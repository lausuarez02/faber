// SSD1306 128x64 OLED controller on I2C. Implements the command set Adafruit_SSD1306 and U8g2
// use (datasheet rev 1.1, section 10): addressing modes, column/page ranges, page-mode pointers,
// display on/off, contrast, normal/inverse, entire-display-on, start line, offset, segment remap,
// COM scan direction, COM pin configuration, multiplex ratio and the charge pump.
import type { Diagnostic, I2cDevice, PartModel, PartModelFactory } from "@faber/sim-core";
import { bytesToBase64 } from "@faber/sim-core";
import { createI2cModule } from "../../lib/i2cModule.ts";
import { str } from "../../lib/props.ts";

export const WIDTH = 128;
export const HEIGHT = 64;
const PAGES = HEIGHT / 8;

/** Bytes of arguments each multi-byte command takes. */
const ARGS: Record<number, number> = {
  0x81: 1, // contrast
  0x20: 1, // memory addressing mode
  0x21: 2, // column address
  0x22: 2, // page address
  0xa8: 1, // multiplex ratio
  0xd3: 1, // display offset
  0xda: 1, // COM pins hardware configuration
  0xd5: 1, // clock divide / oscillator
  0xd9: 1, // pre-charge period
  0xdb: 1, // VCOMH deselect level
  0x8d: 1, // charge pump
  0x26: 6, // right horizontal scroll setup
  0x27: 6, // left horizontal scroll setup
  0x29: 5, // vertical + right scroll setup
  0x2a: 5, // vertical + left scroll setup
  0xa3: 2, // vertical scroll area
  0xd6: 1, // zoom in (SSD1306B), accepted and ignored
};

export interface Ssd1306State {
  ram: Uint8Array; // GDDRAM: 8 pages x 128 columns, bit 0 = top row of the page
  displayOn: boolean;
  chargePump: boolean;
  contrast: number;
  inverse: boolean;
  entireOn: boolean;
  mode: 0 | 1 | 2; // 0 horizontal, 1 vertical, 2 page
  colStart: number;
  colEnd: number;
  pageStart: number;
  pageEnd: number;
  col: number;
  page: number;
  pageModeCol: number;
  startLine: number;
  offset: number;
  segRemap: boolean;
  comRemap: boolean;
  comAlt: boolean;
  comLrRemap: boolean;
  mux: number;
  scrolling: boolean;
}

export function resetState(): Ssd1306State {
  // Power-on reset values from the datasheet command table.
  return {
    ram: new Uint8Array(WIDTH * PAGES),
    displayOn: false,
    chargePump: false,
    contrast: 0x7f,
    inverse: false,
    entireOn: false,
    mode: 2,
    colStart: 0,
    colEnd: WIDTH - 1,
    pageStart: 0,
    pageEnd: PAGES - 1,
    col: 0,
    page: 0,
    pageModeCol: 0,
    startLine: 0,
    offset: 0,
    segRemap: false,
    comRemap: false,
    comAlt: true,
    comLrRemap: false,
    mux: 63,
    scrolling: false,
  };
}

/** The SSD1306 itself, independent of the bus: feed it commands and data bytes. */
export class Ssd1306 {
  s = resetState();
  /** Bumped whenever something visible may have changed. */
  version = 0;
  private cmd: number[] = [];
  private need = 0;

  command(b: number): void {
    const s = this.s;
    if (this.need > 0) {
      this.cmd.push(b);
      if (--this.need === 0) this.exec(this.cmd);
      return;
    }
    const n = ARGS[b];
    if (n !== undefined) {
      this.cmd = [b];
      this.need = n;
      return;
    }
    this.version++;
    if (b <= 0x0f) {
      s.pageModeCol = (s.pageModeCol & 0xf0) | b;
      s.col = s.pageModeCol;
    } else if (b <= 0x1f) {
      s.pageModeCol = ((b & 0x07) << 4) | (s.pageModeCol & 0x0f);
      s.col = s.pageModeCol;
    } else if (b === 0x2e) s.scrolling = false;
    else if (b === 0x2f) s.scrolling = true;
    else if (b >= 0x40 && b <= 0x7f) s.startLine = b & 0x3f;
    else if (b === 0xa0 || b === 0xa1) s.segRemap = b === 0xa1;
    else if (b === 0xa4 || b === 0xa5) s.entireOn = b === 0xa5;
    else if (b === 0xa6 || b === 0xa7) s.inverse = b === 0xa7;
    else if (b === 0xae || b === 0xaf) s.displayOn = b === 0xaf;
    else if (b >= 0xb0 && b <= 0xb7) s.page = b & 0x07;
    else if (b === 0xc0 || b === 0xc8) s.comRemap = b === 0xc8;
    // 0xE3 NOP and unknown single-byte commands are ignored, as on the chip.
  }

  private exec(c: number[]): void {
    const s = this.s;
    const [op, a = 0, b = 0] = c;
    this.version++;
    switch (op) {
      case 0x81:
        s.contrast = a;
        break;
      case 0x20:
        s.mode = (a & 3) === 3 ? s.mode : ((a & 3) as 0 | 1 | 2);
        break;
      case 0x21:
        s.colStart = a & 0x7f;
        s.colEnd = b & 0x7f;
        s.col = s.colStart;
        break;
      case 0x22:
        s.pageStart = a & 0x07;
        s.pageEnd = b & 0x07;
        s.page = s.pageStart;
        break;
      case 0xa8:
        s.mux = Math.max(15, a & 0x3f);
        break;
      case 0xd3:
        s.offset = a & 0x3f;
        break;
      case 0xda:
        s.comAlt = (a & 0x10) !== 0;
        s.comLrRemap = (a & 0x20) !== 0;
        break;
      case 0x8d:
        s.chargePump = (a & 0x04) !== 0;
        break;
      default:
        break; // timing/scroll setup: accepted, no visible effect modelled
    }
  }

  data(b: number): void {
    const s = this.s;
    s.ram[s.page * WIDTH + s.col] = b;
    this.version++;
    if (s.mode === 0) {
      if (s.col >= s.colEnd) {
        s.col = s.colStart;
        s.page = s.page >= s.pageEnd ? s.pageStart : s.page + 1;
      } else s.col++;
    } else if (s.mode === 1) {
      if (s.page >= s.pageEnd) {
        s.page = s.pageStart;
        s.col = s.col >= s.colEnd ? s.colStart : s.col + 1;
      } else s.page++;
    } else {
      // Page mode: the column wraps to the page-mode start column, the page stays.
      s.col = s.col >= WIDTH - 1 ? s.pageModeCol : s.col + 1;
    }
  }

  /** True when the panel emits light. */
  lit(powered: boolean): boolean {
    return powered && this.s.displayOn && this.s.chargePump;
  }

  /** RAM row (0..63) shown on screen row y, or -1 when the row is outside the multiplex ratio. */
  ramRowFor(y: number): number {
    const s = this.s;
    const rows = s.mux + 1;
    // Panel wiring of a 128x64 module expects the alternative COM configuration (0xDA 0x12).
    let com: number;
    if (s.comAlt) com = y;
    else com = y % 2 === 0 ? y / 2 : 32 + (y - 1) / 2; // sequential config on an alternative-wired panel interleaves rows
    if (s.comLrRemap) com = com < 32 ? com + 32 : com - 32;
    // Common 0.96 in modules mount the glass so that 0xC8 (COM63 → COM0) is upright: both
    // Adafruit_SSD1306 and U8g2 send 0xA1 0xC8 for the normal orientation.
    if (!s.comRemap) com = HEIGHT - 1 - com;
    if (com >= rows) return -1;
    return (com + s.startLine + s.offset) & 63;
  }

  /** The image on the glass: row-major, 1 bit per pixel, MSB left. All zeros when dark. */
  render(powered: boolean): Uint8Array {
    const out = new Uint8Array((WIDTH / 8) * HEIGHT);
    if (!this.lit(powered)) return out;
    const s = this.s;
    for (let y = 0; y < HEIGHT; y++) {
      const r = this.ramRowFor(y);
      if (r < 0) continue;
      const page = r >> 3;
      const bit = 1 << (r & 7);
      for (let x = 0; x < WIDTH; x++) {
        const col = s.segRemap ? x : WIDTH - 1 - x; // 0xA1 is upright on these modules
        let on = (s.ram[page * WIDTH + col]! & bit) !== 0;
        if (s.entireOn) on = true;
        if (s.inverse) on = !on;
        if (on) out[y * 16 + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
    return out;
  }
}

/**
 * I2C framing (datasheet 8.1.5.2): after the address, a control byte (Co, D/C#). Co = 0: every
 * following byte is a command (D/C# = 0) or data (D/C# = 1) until STOP. Co = 1: one byte, then
 * another control byte.
 */
export function createSsd1306I2c(chip: Ssd1306, powered: () => boolean, address: () => number): I2cDevice & { reads: number } {
  let expectControl = true;
  let single = false;
  let isData = false;
  const dev = {
    reads: 0,
    i2cAddress: address,
    i2cConnect(read: boolean) {
      if (!powered()) return false;
      expectControl = true;
      void read;
      return true;
    },
    i2cWrite(b: number) {
      if (expectControl) {
        single = (b & 0x80) !== 0;
        isData = (b & 0x40) !== 0;
        expectControl = false;
        return true;
      }
      if (isData) chip.data(b);
      else chip.command(b);
      if (single) expectControl = true;
      return true;
    },
    i2cRead() {
      // The SSD1306 in I2C mode only returns its status byte: bit 6 = display off.
      dev.reads++;
      return chip.s.displayOn ? 0x00 : 0x40;
    },
    i2cStop() {
      expectControl = true;
    },
  };
  return dev;
}

export const create: PartModelFactory = (ctx): PartModel => {
  const mod = createI2cModule(ctx, { supplymA: 10, minVolts: 2.8, maxVolts: 5.5 });
  let chip = new Ssd1306();
  let color = str(ctx.props.color, "white");
  let cache: { version: number; powered: boolean; pixels: string; lit: number; frame: number; image: Uint8Array } = {
    version: -1,
    powered: false,
    pixels: "",
    lit: 0,
    frame: 0,
    image: new Uint8Array(0),
  };
  let sawTraffic = false;

  const refresh = () => {
    const powered = mod.powered;
    if (cache.version === chip.version && cache.powered === powered) return cache;
    const image = chip.render(powered);
    let changed = image.length !== cache.image.length;
    if (!changed) {
      for (let i = 0; i < image.length; i++) {
        if (image[i] !== cache.image[i]) {
          changed = true;
          break;
        }
      }
    }
    let lit = 0;
    for (const b of image) for (let v = b; v; v &= v - 1) lit++;
    cache = {
      version: chip.version,
      powered,
      pixels: changed ? bytesToBase64(image) : cache.pixels,
      lit,
      frame: changed ? cache.frame + 1 : cache.frame,
      image,
    };
    return cache;
  };

  const device = createSsd1306I2c(chip, () => mod.powered, mod.address);
  const i2c: I2cDevice = {
    i2cAddress: () => device.i2cAddress(),
    i2cConnect: (r, rep) => {
      const ack = device.i2cConnect(r, rep);
      if (ack) sawTraffic = true;
      return ack;
    },
    i2cWrite: (b) => device.i2cWrite(b),
    i2cRead: (a) => device.i2cRead(a),
    i2cStop: () => device.i2cStop(),
  };

  return {
    i2c,
    stamp: (c) => mod.stamp(c),
    onSolved(r) {
      const was = mod.powered;
      mod.onSolved(r);
      // Losing power clears the controller: it needs the init sequence again.
      if (was && !mod.powered) {
        chip = new Ssd1306();
        Object.assign(device, createSsd1306I2c(chip, () => mod.powered, mod.address));
      }
    },
    visualState() {
      const c = refresh();
      const s = chip.s;
      const on = chip.lit(mod.powered);
      return {
        on,
        pixels: c.pixels || bytesToBase64(c.image),
        frame: c.frame,
        width: WIDTH,
        height: HEIGHT,
        contrast: s.contrast,
        brightness: Math.round((0.35 + (0.65 * s.contrast) / 255) * 1000) / 1000,
        inverted: s.inverse,
        color,
        lit: c.lit,
        blank: c.lit === 0,
        screenOpacity: on ? 1 : 0,
      };
    },
    setProp(id, v) {
      if (id === "address") mod.setAddressProp(v);
      if (id === "color") color = str(v, "white");
    },
    diagnostics() {
      const out: Diagnostic[] = mod.diagnostics();
      const s = chip.s;
      if (mod.powered && sawTraffic && s.displayOn && !s.chargePump) {
        out.push({
          severity: "warning",
          code: "ssd1306-charge-pump-off",
          message: `${ctx.id} got DISPLAY ON (0xAF) but the charge pump is off, so the panel stays dark (these modules have no external 7-12 V supply). Send 0x8D 0x14 before 0xAF: with Adafruit_SSD1306 call display.begin(SSD1306_SWITCHCAPVCC, 0x3C).`,
        });
      }
      if (mod.powered && sawTraffic && s.displayOn && s.chargePump && s.mux < 63) {
        out.push({
          severity: "info",
          code: "ssd1306-mux-short",
          message: `${ctx.id} is set to ${s.mux + 1} rows (0xA8 ${s.mux}), so only the top ${s.mux + 1} of 64 rows show. For this 128x64 panel use SSD1306 display(128, 64, &Wire, -1) or a U8G2_SSD1306_128X64_* constructor.`,
        });
      }
      return out;
    },
  };
};
