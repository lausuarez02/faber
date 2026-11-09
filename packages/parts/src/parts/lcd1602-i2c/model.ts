// 16x2 character LCD (HD44780) behind a PCF8574 I2C port expander, as on the common blue
// backpack modules. PCF8574 pin map (the one LiquidCrystal_PCF8574 and LiquidCrystal_I2C use):
// P0 = RS, P1 = RW, P2 = EN, P3 = backlight, P4..P7 = D4..D7. The HD44780 latches a nibble on
// the falling edge of EN; it powers up in 8-bit mode and the library switches it to 4-bit.
import type { Diagnostic, I2cDevice, PartModel, PartModelFactory } from "@jumper/sim-core";
import { bytesToBase64 } from "@jumper/sim-core";
import { createI2cModule } from "../../lib/i2cModule.ts";
import { str } from "../../lib/props.ts";

export const COLS = 16;
export const ROWS = 2;
const RS = 0x01;
const RW = 0x02;
const EN = 0x04;
const BL = 0x08;
/** HD44780 cursor blink: about 409.6 ms per phase at the 270 kHz oscillator. */
const BLINK_MS = 409.6;

/** HD44780U ROM A00 for codes the LCD shows that differ from ASCII. */
const ROM_A00: Record<number, string> = { 0x5c: "¥", 0x7e: "→", 0x7f: "←", 0xdf: "°", 0xe4: "µ", 0xf4: "Ω", 0xa5: "·" };

export function charOf(code: number): string {
  if (code < 16) return "▯"; // CGRAM (0-7, mirrored at 8-15)
  if (ROM_A00[code]) return ROM_A00[code]!;
  if (code >= 0x20 && code < 0x7e) return String.fromCharCode(code);
  if (code === 0x20 || code === 0xa0) return " ";
  return "?";
}

/** The HD44780 controller alone: feed it 4-bit or 8-bit writes. */
export class Hd44780 {
  ddram = new Uint8Array(0x68).fill(0x20);
  cgram = new Uint8Array(64);
  ac = 0;
  toCgram = false;
  increment = true;
  shiftOnWrite = false;
  displayOn = false;
  cursorOn = false;
  blink = false;
  shift = 0; // display shift in characters
  eightBit = true;
  twoLines = false;
  private pending: number | undefined;
  version = 0;
  /** Count of instructions/data, for tests. */
  writes = 0;

  /** EN falling edge with D7..D4 = `nibble`, RS = `rs`. */
  strobe(nibble: number, rs: boolean): void {
    if (this.eightBit) {
      // In 8-bit mode with only D7..D4 wired, the low bits read as 0.
      this.exec(nibble << 4, rs);
      return;
    }
    if (this.pending === undefined) {
      this.pending = nibble;
      return;
    }
    const byte = (this.pending << 4) | nibble;
    this.pending = undefined;
    this.exec(byte, rs);
  }

  exec(b: number, rs: boolean): void {
    this.writes++;
    this.version++;
    if (rs) {
      if (this.toCgram) this.cgram[this.ac & 0x3f] = b & 0x1f;
      else this.ddram[this.ddIndex(this.ac)] = b;
      this.step(true);
      return;
    }
    if (b & 0x80) {
      this.toCgram = false;
      this.ac = b & 0x7f;
    } else if (b & 0x40) {
      this.toCgram = true;
      this.ac = b & 0x3f;
    } else if (b & 0x20) {
      this.eightBit = (b & 0x10) !== 0;
      this.twoLines = (b & 0x08) !== 0;
      this.pending = undefined;
    } else if (b & 0x10) {
      const display = (b & 0x08) !== 0;
      const right = (b & 0x04) !== 0;
      // Display shift left moves the text left: the first visible cell shows the next address.
      if (display) this.shift = (this.shift + (right ? -1 : 1) + 40) % 40;
      else this.moveAc(right);
    } else if (b & 0x08) {
      this.displayOn = (b & 0x04) !== 0;
      this.cursorOn = (b & 0x02) !== 0;
      this.blink = (b & 0x01) !== 0;
    } else if (b & 0x04) {
      this.increment = (b & 0x02) !== 0;
      this.shiftOnWrite = (b & 0x01) !== 0;
    } else if (b & 0x02) {
      this.ac = 0;
      this.toCgram = false;
      this.shift = 0;
    } else if (b & 0x01) {
      this.ddram.fill(0x20);
      this.ac = 0;
      this.toCgram = false;
      this.shift = 0;
      this.increment = true;
    }
  }

  /** DDRAM address → index into our buffer (line 2 starts at 0x40). */
  private ddIndex(addr: number): number {
    const a = addr & 0x7f;
    if (!this.twoLines) return a % 0x68;
    if (a >= 0x40) return 0x40 + ((a - 0x40) % 40);
    return a % 40;
  }

  private moveAc(right: boolean): void {
    if (this.toCgram) {
      this.ac = (this.ac + (right ? 1 : -1)) & 0x3f;
      return;
    }
    let a = this.ac + (right ? 1 : -1);
    if (this.twoLines) {
      if (a === 0x28) a = 0x40;
      else if (a === 0x68) a = 0x00;
      else if (a === 0x3f) a = 0x27;
      else if (a === -1) a = 0x67;
    } else {
      if (a === 0x50) a = 0;
      if (a === -1) a = 0x4f;
    }
    this.ac = a;
  }

  private step(isWrite: boolean): void {
    this.moveAc(this.increment);
    if (isWrite && this.shiftOnWrite && !this.toCgram) this.shift = (this.shift + (this.increment ? 1 : -1) + 40) % 40;
  }

  /** Character code at a visible cell. */
  codeAt(row: number, col: number): number {
    if (!this.twoLines && row > 0) return 0x20;
    const base = row === 0 ? 0 : 0x40;
    return this.ddram[base + ((col + this.shift) % 40)]!;
  }

  /** Visible column of the cursor, or -1. */
  cursorCell(): { row: number; col: number } {
    if (this.toCgram) return { row: 0, col: -1 };
    const row = this.ac >= 0x40 ? 1 : 0;
    const pos = (this.ac - (row ? 0x40 : 0) - this.shift + 40) % 40;
    return { row, col: pos < COLS ? pos : -1 };
  }
}

/** The PCF8574 backpack: an 8-bit quasi-bidirectional port driving the HD44780. */
export function createBackpack(lcd: Hd44780, powered: () => boolean, address: () => number) {
  let port = 0xff; // PCF8574 powers up with all outputs high
  const state = {
    get port() {
      return port;
    },
    get backlight() {
      return (port & BL) !== 0;
    },
  };
  const write = (b: number) => {
    const prev = port;
    port = b & 0xff;
    if (prev & EN && !(port & EN) && !(port & RW)) lcd.strobe((port >> 4) & 0x0f, (port & RS) !== 0);
    if ((prev ^ port) & BL) lcd.version++;
  };
  const i2c: I2cDevice = {
    i2cAddress: address,
    i2cConnect: () => powered(),
    i2cWrite(b) {
      write(b);
      return true;
    },
    // Reads return the pins: the latch, with the data lines the LCD drives when RW is high
    // (busy flag always clear: every instruction completes instantly here).
    i2cRead: () => (port & RW && port & EN ? port & 0x7f : port),
    i2cStop() {},
  };
  return { i2c, state, write };
}

export const create: PartModelFactory = (ctx): PartModel => {
  const mod = createI2cModule(ctx, { supplymA: 25, minVolts: 4.0, maxVolts: 6 });
  let lcd = new Hd44780();
  let pack = createBackpack(lcd, () => mod.powered, mod.address);
  let color = str(ctx.props.color, "blue");
  let frame = 0;
  let lastSig = "";
  let sawTraffic = false;

  const i2c: I2cDevice = {
    i2cAddress: () => pack.i2c.i2cAddress(),
    i2cConnect: (r, rep) => {
      const ok = pack.i2c.i2cConnect(r, rep);
      if (ok) sawTraffic = true;
      return ok;
    },
    i2cWrite: (b) => pack.i2c.i2cWrite(b),
    i2cRead: (a) => pack.i2c.i2cRead(a),
    i2cStop: () => pack.i2c.i2cStop(),
  };

  return {
    i2c,
    stamp: (c) => mod.stamp(c),
    onSolved(r) {
      const was = mod.powered;
      mod.onSolved(r);
      if (was && !mod.powered) {
        lcd = new Hd44780();
        pack = createBackpack(lcd, () => mod.powered, mod.address);
      }
    },
    visualState() {
      const powered = mod.powered;
      const on = powered && lcd.displayOn;
      const codes = new Uint8Array(COLS * ROWS);
      const lines = ["", ""];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const code = on ? lcd.codeAt(r, c) : 0x20;
          codes[r * COLS + c] = code;
          lines[r] += charOf(code);
        }
      }
      const cur = lcd.cursorCell();
      const backlight = powered && pack.state.backlight;
      const blinkOn = on && lcd.blink && Math.floor(ctx.now() / BLINK_MS) % 2 === 0;
      const glyphs = bytesToBase64(codes);
      const cgram = bytesToBase64(lcd.cgram);
      const sig = `${glyphs}|${cgram}|${on}|${backlight}|${cur.row},${cur.col}|${lcd.cursorOn}|${blinkOn}`;
      if (sig !== lastSig) {
        lastSig = sig;
        frame++;
      }
      return {
        on,
        backlight,
        backlightOpacity: backlight ? 1 : 0.15,
        line0: lines[0]!,
        line1: lines[1]!,
        glyphs,
        cgram,
        cursorCol: on ? cur.col : -1,
        cursorRow: cur.row,
        cursorOn: on && lcd.cursorOn,
        blinkOn,
        frame,
        cols: COLS,
        rows: ROWS,
        color,
      };
    },
    setProp(id, v) {
      if (id === "address") mod.setAddressProp(v);
      if (id === "color") color = str(v, "blue");
    },
    diagnostics() {
      const out: Diagnostic[] = mod.diagnostics();
      if (mod.powered && sawTraffic && lcd.writes > 0 && !lcd.twoLines && lcd.displayOn) {
        out.push({
          severity: "info",
          code: "lcd-one-line-mode",
          message: `${ctx.id} is in 1-line mode, so line 2 stays blank. Call lcd.begin(16, 2) (two rows) so the library sends function set 0x28.`,
        });
      }
      if (mod.powered && sawTraffic && lcd.writes === 0) {
        out.push({
          severity: "info",
          code: "lcd-no-init",
          message: `${ctx.id} gets I2C traffic but the LCD has received no instruction yet: the backpack pin map may not match. Use a library for PCF8574 backpacks with P0 = RS, P1 = RW, P2 = EN, P3 = backlight, P4-P7 = D4-D7 (LiquidCrystal_PCF8574).`,
        });
      }
      return out;
    },
  };
};
