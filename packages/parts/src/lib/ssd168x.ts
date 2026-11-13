// Round 15: Solomon Systech SSD1680 / SSD1681 e-paper controllers (1.54 in 200 x 200 GDEY0154D67,
// 2.13 in 122 x 250 and their kin), written from the SSD1681 datasheet's command table. What a
// person sees is the GLASS, not the RAM: writing pixels (0x24) changes nothing on the screen until a
// refresh (0x22 + 0x20) runs, which takes about 2 s (full) or 0.5 s (partial) with BUSY high, and the
// image then stays with no power at all. A partial refresh (display mode 2) only drives the pixels
// whose new value (0x24 RAM) differs from the previous one (0x26 RAM): a firmware that does not keep
// 0x26 in step leaves ghosts, as on the real panel.
//
// Pixels: 1 bit each, MSB = leftmost, 1 = white, 0 = black. RAM X is in bytes (8 pixels), RAM Y in
// rows; data entry mode 0x11 sets the address direction (bit 0 X+, bit 1 Y+, bit 2 Y first).
// No Date, no timers: the module schedules BUSY through the Simulation's part events.

export interface Ssd168xOptions {
  width: number;
  height: number;
  /** Full refresh (display mode 1) BUSY time, ms. */
  fullMs: number;
  /** Partial refresh (display mode 2) BUSY time, ms. */
  partialMs: number;
  /** Analog power on / off alone (0x22 0xC0 / 0x83), ms. */
  powerOnMs: number;
  powerOffMs: number;
  /** Software reset (0x12), ms. */
  swResetMs: number;
}

export const SSD1681_200: Ssd168xOptions = { width: 200, height: 200, fullMs: 2000, partialMs: 500, powerOnMs: 100, powerOffMs: 150, swResetMs: 10 };

export type Ssd168xEvent = { kind: "busy"; ms: number; what: "full" | "partial" | "power-on" | "power-off" | "reset" | "other" };

export class Ssd168x {
  readonly bw: Uint8Array;
  readonly red: Uint8Array;
  /** What the glass shows (1 = white), one byte per pixel. */
  readonly glass: Uint8Array;
  private readonly stride: number;
  cmd = -1;
  private args: number[] = [];
  private writing: 0 | 0x24 | 0x26 = 0;
  // registers
  entry = 0x03;
  xStart = 0;
  xEnd: number;
  yStart = 0;
  yEnd: number;
  xAddr = 0;
  yAddr = 0;
  ctrl1 = [0x00, 0x80];
  ctrl2 = 0xff;
  border = 0x05;
  // state
  deepSleep = false;
  analogOn = false;
  clockOn = false;
  /** The refresh in progress (applied when BUSY drops). */
  pending?: "full" | "partial";
  version = 0;
  fullRefreshes = 0;
  partialRefreshes = 0;
  bytesWritten = 0;
  /** RAM written since the last refresh (drawn but not shown). */
  dirty = false;
  /** Pixels a partial refresh left showing the old image (RAM 0x24 differs from the glass). */
  ghostPixels = 0;
  /** Commands that arrived while the panel was in deep sleep (ignored: it needs a hardware reset). */
  ignoredAsleep = 0;
  /** A refresh asked for with the analog supplies off (nothing is driven). */
  unpoweredRefreshes = 0;

  constructor(readonly o: Ssd168xOptions) {
    this.stride = Math.ceil(o.width / 8);
    this.bw = new Uint8Array(this.stride * o.height).fill(0xff);
    this.red = new Uint8Array(this.stride * o.height).fill(0xff);
    this.glass = new Uint8Array(o.width * o.height).fill(1);
    this.xEnd = this.stride - 1;
    this.yEnd = o.height - 1;
  }

  /** Hardware reset (RST low): registers to their defaults, out of deep sleep. RAM keeps its content. */
  hardReset(): void {
    this.deepSleep = false;
    this.softReset();
  }

  private softReset(): void {
    this.entry = 0x03;
    this.xStart = 0;
    this.xEnd = this.stride - 1;
    this.yStart = 0;
    this.yEnd = this.o.height - 1;
    this.xAddr = 0;
    this.yAddr = 0;
    this.ctrl1 = [0x00, 0x80];
    this.ctrl2 = 0xff;
    this.cmd = -1;
    this.args = [];
    this.writing = 0;
    this.analogOn = false;
    this.clockOn = false;
  }

  /** One SPI byte with the D/C level (0 = command). Returns a BUSY period to start, if any. */
  byte(b: number, dc: 0 | 1): Ssd168xEvent | undefined {
    if (this.deepSleep) {
      this.ignoredAsleep++;
      return undefined;
    }
    if (dc === 0) return this.command(b);
    if (this.writing) {
      this.writeRam(b);
      return undefined;
    }
    this.args.push(b);
    return this.argument();
  }

  private command(c: number): Ssd168xEvent | undefined {
    this.cmd = c;
    this.args = [];
    this.writing = 0;
    switch (c) {
      case 0x12:
        this.softReset();
        return { kind: "busy", ms: this.o.swResetMs, what: "reset" };
      case 0x20:
        return this.activate();
      case 0x24:
      case 0x26:
        this.writing = c;
        return undefined;
      default:
        return undefined;
    }
  }

  private argument(): Ssd168xEvent | undefined {
    const a = this.args;
    switch (this.cmd) {
      case 0x10: // deep sleep mode: 0x01 / 0x03 enter, 0x00 normal
        if ((a[0]! & 0x03) !== 0) {
          this.deepSleep = true;
          this.analogOn = false;
          this.clockOn = false;
        }
        break;
      case 0x11:
        this.entry = a[0]! & 0x07;
        break;
      case 0x21:
        if (a.length <= 2) this.ctrl1[a.length - 1] = a[a.length - 1]!;
        break;
      case 0x22:
        this.ctrl2 = a[0]!;
        break;
      case 0x3c:
        this.border = a[0]!;
        break;
      case 0x44:
        if (a.length === 1) this.xStart = a[0]! & 0x3f;
        if (a.length === 2) this.xEnd = a[1]! & 0x3f;
        break;
      case 0x45:
        if (a.length === 2) this.yStart = a[0]! | ((a[1]! & 0x01) << 8);
        if (a.length === 4) this.yEnd = a[2]! | ((a[3]! & 0x01) << 8);
        break;
      case 0x4e:
        this.xAddr = a[0]! & 0x3f;
        break;
      case 0x4f:
        if (a.length === 1) this.yAddr = a[0]!;
        if (a.length === 2) this.yAddr = a[0]! | ((a[1]! & 0x01) << 8);
        break;
      default:
        break; // driver output, temperature, LUT, booster...: accepted, no visible effect here
    }
    return undefined;
  }

  private writeRam(b: number): void {
    const ram = this.writing === 0x24 ? this.bw : this.red;
    if (this.xAddr < this.stride && this.yAddr < this.o.height) ram[this.yAddr * this.stride + this.xAddr] = b;
    this.bytesWritten++;
    if (this.writing === 0x24) this.dirty = true;
    const xInc = (this.entry & 1) !== 0;
    const yInc = (this.entry & 2) !== 0;
    const yFirst = (this.entry & 4) !== 0;
    const lo = (s: number, e: number) => Math.min(s, e);
    const hi = (s: number, e: number) => Math.max(s, e);
    const stepX = (): boolean => {
      // true when X wrapped
      if (xInc) {
        if (this.xAddr >= hi(this.xStart, this.xEnd)) {
          this.xAddr = lo(this.xStart, this.xEnd);
          return true;
        }
        this.xAddr++;
      } else {
        if (this.xAddr <= lo(this.xStart, this.xEnd)) {
          this.xAddr = hi(this.xStart, this.xEnd);
          return true;
        }
        this.xAddr--;
      }
      return false;
    };
    const stepY = (): boolean => {
      if (yInc) {
        if (this.yAddr >= hi(this.yStart, this.yEnd)) {
          this.yAddr = lo(this.yStart, this.yEnd);
          return true;
        }
        this.yAddr++;
      } else {
        if (this.yAddr <= lo(this.yStart, this.yEnd)) {
          this.yAddr = hi(this.yStart, this.yEnd);
          return true;
        }
        this.yAddr--;
      }
      return false;
    };
    if (yFirst) {
      if (stepY()) stepX();
    } else if (stepX()) stepY();
  }

  /** 0x20 master activation: run what 0x22 (display update control 2) asks for. */
  private activate(): Ssd168xEvent {
    const c = this.ctrl2;
    if (c & 0x80) this.clockOn = true;
    if (c & 0x40) this.analogOn = true;
    let what: Ssd168xEvent["what"] = "other";
    let ms = 1;
    if (c & 0x04) {
      if (!this.analogOn) {
        this.unpoweredRefreshes++;
      } else {
        this.pending = c & 0x08 ? "partial" : "full";
        what = this.pending;
        ms = this.pending === "full" ? this.o.fullMs : this.o.partialMs;
      }
    } else if (c & 0x40 && !(c & 0x02)) {
      what = "power-on";
      ms = this.o.powerOnMs;
    }
    if (c & 0x02) {
      if (!(c & 0x04)) {
        what = "power-off";
        ms = this.o.powerOffMs;
      }
    }
    return { kind: "busy", ms, what };
  }

  /** BUSY dropped: the refresh is done (the glass changes), the supplies go off if asked. */
  finish(): void {
    const c = this.ctrl2;
    if (this.pending) {
      const partial = this.pending === "partial";
      const inv = (opt: number) => (opt & 0x08) !== 0; // "inverse RAM content"
      const bwInv = inv(this.ctrl1[0]! & 0x0f);
      const { width, height } = this.o;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * this.stride + (x >> 3);
          const bit = 0x80 >> (x & 7);
          let nw = (this.bw[i]! & bit) !== 0 ? 1 : 0;
          if (bwInv) nw ^= 1;
          const old = (this.red[i]! & bit) !== 0 ? 1 : 0;
          const p = y * width + x;
          if (!partial || nw !== old) this.glass[p] = nw;
        }
      let ghosts = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const nw = (this.bw[y * this.stride + (x >> 3)]! & (0x80 >> (x & 7))) !== 0 ? 1 : 0;
          if (this.glass[y * width + x] !== (bwInv ? nw ^ 1 : nw)) ghosts++;
        }
      this.ghostPixels = ghosts;
      if (partial) this.partialRefreshes++;
      else this.fullRefreshes++;
      this.pending = undefined;
      this.dirty = false;
      this.version++;
    }
    if (c & 0x02) this.analogOn = false;
    if (c & 0x01) this.clockOn = false;
  }

  /** Black pixels on the glass. */
  blackPixels(): number {
    let n = 0;
    for (const v of this.glass) if (!v) n++;
    return n;
  }
}
