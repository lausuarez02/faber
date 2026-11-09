// A MIPI-DCS-style TFT controller (ILI9341, ST7735, ST7789 share this command set): column /
// page address windows (CASET / PASET), memory write (RAMWR / RAMWRC), MADCTL rotation and
// mirroring, COLMOD 16-bit RGB565 or 18-bit RGB666, sleep, display on/off, inversion, reset, and
// the read commands Adafruit's libraries use. Driven byte by byte from the SPI bus with the D/C
// level of each byte. Pixels land in a viewer-oriented RGB565 framebuffer with a dirty rect, so a
// renderer repaints only what changed. Deterministic: no clock, no randomness.
import { DirtyTracker, type ColorFrame } from "@jumper/sim-core";

export const CMD = {
  NOP: 0x00,
  SWRESET: 0x01,
  RDDID: 0x04,
  RDDST: 0x09,
  RDMODE: 0x0a,
  RDMADCTL: 0x0b,
  RDPIXFMT: 0x0c,
  RDIMGFMT: 0x0d,
  RDSELFDIAG: 0x0f,
  SLPIN: 0x10,
  SLPOUT: 0x11,
  PTLON: 0x12,
  NORON: 0x13,
  INVOFF: 0x20,
  INVON: 0x21,
  GAMMASET: 0x26,
  DISPOFF: 0x28,
  DISPON: 0x29,
  CASET: 0x2a,
  PASET: 0x2b,
  RAMWR: 0x2c,
  RAMRD: 0x2e,
  VSCRDEF: 0x33,
  MADCTL: 0x36,
  VSCRSADD: 0x37,
  COLMOD: 0x3a,
  RAMWRC: 0x3c,
  RDID4: 0xd3,
  ILI_INDEX: 0xd9,
} as const;

/** MADCTL bits. */
export const MADCTL = { MY: 0x80, MX: 0x40, MV: 0x20, ML: 0x10, BGR: 0x08, MH: 0x04 } as const;

export interface PanelOptions {
  /** Native (physical, unrotated) size of the glass: ILI9341 240x320, ST7735 128x160. */
  nativeW: number;
  nativeH: number;
  /**
   * How the module is drawn on the canvas. The frame is given in this orientation:
   *  - "landscape": native rows run left to right (ILI9341 with Adafruit setRotation(1) upright).
   *  - "portrait":  native columns run left to right (setRotation(0) upright).
   * `portraitFlip` adds a 180° turn for panels whose rotation 0 is MX|MY (ST7735 black tab).
   */
  viewer: "landscape" | "portrait";
  portraitFlip?: boolean;
  /** Glass colour order: true when MADCTL.BGR = 1 gives correct colours (most ILI9341 modules). */
  bgrPanel: boolean;
  /** Bytes returned by RDID4 / RDDID (chip id), e.g. ILI9341: 0x00 0x93 0x41. */
  id4: number[];
  /** Arguments each command takes when it is not handled specially (unknown commands take any number). */
  argCounts?: Record<number, number>;
}

/** Power-on / software-reset state of the registers (ILI9341 datasheet 8.2 defaults). */
interface Regs {
  sleeping: boolean;
  displayOn: boolean;
  inverted: boolean;
  madctl: number;
  colmod: number;
  xs: number;
  xe: number;
  ys: number;
  ye: number;
  scrollStart: number;
}

export class MipiPanel {
  readonly opts: PanelOptions;
  readonly width: number;
  readonly height: number;
  readonly data: Uint16Array;
  readonly dirty = new DirtyTracker();
  version = 0;
  /** Pixels written since power-on (for tests and the fidelity card). */
  pixelsWritten = 0;
  /** Commands seen since power-on, for agents ("did the library ever send DISPON?"). */
  commands = 0;
  regs: Regs;

  private cmd = -1;
  private args: number[] = [];
  private col = 0;
  private page = 0;
  private pixBytes: number[] = [];
  private readQueue: number[] = [];
  /** Parameter index set through 0xD9 for the next read command, or -1. */
  private iliIndex = -1;
  private frame: ColorFrame;

  constructor(opts: PanelOptions) {
    this.opts = opts;
    const landscape = opts.viewer === "landscape";
    this.width = landscape ? opts.nativeH : opts.nativeW;
    this.height = landscape ? opts.nativeW : opts.nativeH;
    this.data = new Uint16Array(this.width * this.height);
    this.regs = this.resetRegs();
    this.frame = { width: this.width, height: this.height, data: this.data, version: 0, on: false, inverted: false };
  }

  private resetRegs(): Regs {
    return {
      sleeping: true,
      displayOn: false,
      inverted: false,
      madctl: 0,
      colmod: 0x66,
      xs: 0,
      xe: this.opts.nativeW - 1,
      ys: 0,
      ye: this.opts.nativeH - 1,
      scrollStart: 0,
    };
  }

  /** Hardware or software reset: registers to defaults, RAM kept (it is undefined on the chip; keeping it is the gentle choice). */
  reset(): void {
    this.regs = this.resetRegs();
    this.cmd = -1;
    this.args = [];
    this.pixBytes = [];
    this.readQueue = [];
    this.bump();
  }

  /** Power lost: RAM content is gone too. */
  powerOff(): void {
    this.data.fill(0);
    this.dirty.add(0, 0, this.width, this.height);
    this.reset();
  }

  /** Lit = sleep out and display on. */
  get lit(): boolean {
    return !this.regs.sleeping && this.regs.displayOn;
  }

  /** Adafruit rotation index (0..3) that MADCTL corresponds to, or -1 for other combinations. */
  get rotation(): number {
    const m = this.regs.madctl & (MADCTL.MY | MADCTL.MX | MADCTL.MV);
    const ili = [MADCTL.MX, MADCTL.MV, MADCTL.MY, MADCTL.MX | MADCTL.MY | MADCTL.MV];
    const st = [MADCTL.MX | MADCTL.MY, MADCTL.MY | MADCTL.MV, 0, MADCTL.MX | MADCTL.MV];
    const table = this.opts.portraitFlip ? st : ili;
    return table.indexOf(m);
  }

  framebuffer(on: boolean): ColorFrame {
    this.frame.version = this.version;
    this.frame.on = on && this.lit;
    this.frame.inverted = this.regs.inverted;
    return this.frame;
  }

  /** One byte from the bus. `dc` = level of the D/C pin (0 = command, 1 = data). Returns the MISO byte. */
  byte(b: number, dc: 0 | 1): number {
    if (dc === 0) {
      this.command(b);
      return 0xff;
    }
    if (this.readQueue.length > 0) return this.readQueue.shift()!;
    this.data8(b);
    return 0xff;
  }

  private bump(): void {
    this.version++;
  }

  private command(b: number): void {
    this.commands++;
    this.cmd = b;
    this.args = [];
    this.pixBytes = [];
    this.readQueue = [];
    const r = this.regs;
    switch (b) {
      case CMD.SWRESET:
        this.reset();
        this.cmd = -1;
        return;
      case CMD.SLPIN:
        r.sleeping = true;
        this.bump();
        return;
      case CMD.SLPOUT:
        r.sleeping = false;
        this.bump();
        return;
      case CMD.DISPOFF:
        r.displayOn = false;
        this.bump();
        return;
      case CMD.DISPON:
        r.displayOn = true;
        this.bump();
        return;
      case CMD.INVOFF:
      case CMD.INVON:
        r.inverted = b === CMD.INVON;
        this.bump();
        return;
      case CMD.RAMWR:
        this.col = r.xs;
        this.page = r.ys;
        return;
      case CMD.RAMWRC:
        return;
      case CMD.RDDID:
        this.readQueue = [0x00, ...this.opts.id4.slice(0, 3)];
        return;
      case CMD.RDID4:
        this.readQueue = [0x00, ...this.opts.id4];
        return;
      default:
        break;
    }
    // ILI9341 read commands answer through the undocumented 0xD9 index register (Adafruit
    // readcommand8): the byte at `index` of the answer; other controllers answer from byte 1.
    const answer = this.readAnswer(b);
    if (answer) {
      // answer[0] is the dummy byte of a plain read; the index register selects a parameter.
      this.readQueue = this.iliIndex >= 0 ? [answer[this.iliIndex + 1] ?? 0] : answer;
    }
    this.iliIndex = -1;
  }

  private readAnswer(b: number): number[] | undefined {
    const r = this.regs;
    switch (b) {
      case CMD.RDMODE:
        return [0x00, 0x80 | (r.sleeping ? 0 : 0x10) | 0x08 | (r.displayOn ? 0x04 : 0)];
      case CMD.RDMADCTL:
        return [0x00, r.madctl];
      case CMD.RDPIXFMT:
        return [0x00, r.colmod];
      case CMD.RDIMGFMT:
        return [0x00, 0x00];
      case CMD.RDSELFDIAG:
        return [0x00, r.sleeping ? 0x00 : 0xc0];
      case CMD.RDDST:
        return [0x00, (r.madctl & 0xfc) | (r.sleeping ? 0 : 0x80) | 0x08, (r.colmod & 0x77) << 0, r.displayOn ? 0x04 : 0x00, 0x00];
      default:
        return undefined;
    }
  }

  private data8(b: number): void {
    const r = this.regs;
    switch (this.cmd) {
      case CMD.RAMWR:
      case CMD.RAMWRC:
        this.pixelByte(b);
        return;
      case CMD.CASET:
      case CMD.PASET: {
        this.args.push(b);
        if (this.args.length === 4) {
          const [a0 = 0, a1 = 0, a2 = 0, a3 = 0] = this.args;
          const s = (a0 << 8) | a1;
          const e = (a2 << 8) | a3;
          if (this.cmd === CMD.CASET) {
            r.xs = s;
            r.xe = e;
          } else {
            r.ys = s;
            r.ye = e;
          }
          this.args = [];
        }
        return;
      }
      case CMD.MADCTL:
        r.madctl = b;
        this.bump();
        this.cmd = -1;
        return;
      case CMD.COLMOD:
        r.colmod = b;
        this.cmd = -1;
        return;
      case CMD.VSCRSADD:
        this.args.push(b);
        if (this.args.length === 2) {
          r.scrollStart = ((this.args[0]! << 8) | this.args[1]!) % this.opts.nativeH;
          this.args = [];
          this.bump();
        }
        return;
      case CMD.ILI_INDEX:
        this.iliIndex = b & 0x10 ? b & 0x0f : -1;
        this.cmd = -1;
        return;
      default:
        // Parameters of commands that do not change what is visible (power control, gamma,
        // frame rate, display function): accepted and ignored, as on the chip.
        return;
    }
  }

  private pixelByte(b: number): void {
    const bpp = (this.regs.colmod & 0x07) === 0x06 ? 3 : 2;
    this.pixBytes.push(b);
    if (this.pixBytes.length < bpp) return;
    let c: number;
    if (bpp === 2) c = (this.pixBytes[0]! << 8) | this.pixBytes[1]!;
    else {
      const [r = 0, g = 0, bl = 0] = this.pixBytes;
      c = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (bl >> 3);
    }
    this.pixBytes.length = 0;
    this.putPixel(c);
  }

  private putPixel(c: number): void {
    const r = this.regs;
    const m = r.madctl;
    const mv = (m & MADCTL.MV) !== 0;
    const lw = mv ? this.opts.nativeH : this.opts.nativeW; // logical columns
    const lh = mv ? this.opts.nativeW : this.opts.nativeH; // logical pages
    const x = this.col;
    const y = this.page;
    if (x < lw && y < lh) {
      // Logical → physical (native) address: exchange, then mirror.
      let pc = mv ? y : x;
      let pr = mv ? x : y;
      if (m & MADCTL.MX) pc = this.opts.nativeW - 1 - pc;
      if (m & MADCTL.MY) pr = this.opts.nativeH - 1 - pr;
      // Colour order: the glass is RGB or BGR; a MADCTL BGR bit that does not match swaps red and blue.
      const swap = ((m & MADCTL.BGR) !== 0) !== this.opts.bgrPanel;
      const px = swap ? ((c & 0x1f) << 11) | (c & 0x07e0) | (c >> 11) : c;
      // Physical → viewer.
      let vx: number;
      let vy: number;
      if (this.opts.viewer === "landscape") {
        vx = pr;
        vy = pc;
      } else if (this.opts.portraitFlip) {
        vx = this.opts.nativeW - 1 - pc;
        vy = this.opts.nativeH - 1 - pr;
      } else {
        vx = this.opts.nativeW - 1 - pc;
        vy = pr;
      }
      const i = vy * this.width + vx;
      if (this.data[i] !== px) {
        this.data[i] = px;
        this.dirty.add(vx, vy, vx + 1, vy + 1);
        this.version++;
      }
      this.pixelsWritten++;
    }
    // Advance inside the window, wrapping to its start (datasheet 8.2.22 / 8.2.23).
    this.col++;
    if (this.col > r.xe) {
      this.col = r.xs;
      this.page++;
      if (this.page > r.ye) this.page = r.ys;
    }
  }
}
