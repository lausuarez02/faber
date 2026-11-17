// Bosch BME280 (datasheet BST-BME280-DS002) on I2C. The register map, calibration block and the
// integer compensation formulas are the datasheet's (temperature 32-bit, pressure 64-bit, humidity
// 32-bit), written with divisions the way Adafruit_BME280 2.3.0 does (C division truncates toward
// zero, so negative intermediates differ from the datasheet's shifts by one LSB). Raw ADC values are found by inverting those
// formulas, so a library reading this sensor gets back the prop values to the formula's resolution.
import type { Diagnostic, I2cDevice, PartModel, PartModelFactory } from "@faber/sim-core";
import { createI2cModule } from "../../lib/i2cModule.ts";
import { clamp, num, round } from "../../lib/props.ts";

/** Calibration of a typical sensor (temperature/pressure: the datasheet example; humidity: a production part). */
export const CALIB = {
  T1: 27504, T2: 26435, T3: -1000,
  P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000,
  H1: 75, H2: 362, H3: 0, H4: 313, H5: 50, H6: 30,
} as const;

const CHIP_ID = 0x60;
const SKIPPED_TP = 0x80000; // 20-bit value read when a measurement is skipped
const SKIPPED_H = 0x8000;

// ------------------------------------------------------------------ compensation (datasheet 4.2.3 / 8.2)

const trunc = (x: number) => (x < 0 ? Math.ceil(x) : Math.floor(x));

export function tFine(adcT: number, c = CALIB): number {
  let var1 = trunc(adcT / 8) - c.T1 * 2;
  var1 = trunc((var1 * c.T2) / 2048);
  let var2 = trunc(adcT / 16) - c.T1;
  var2 = trunc((trunc((var2 * var2) / 4096) * c.T3) / 16384);
  return var1 + var2;
}

/** °C × 100. */
export function compT(adcT: number, c = CALIB): number {
  return trunc((tFine(adcT, c) * 5 + 128) / 256);
}

/** Pa × 256 (Q24.8), 64-bit integer version. BigInt `/` truncates toward zero like C. */
export function compP(adcP: number, tf: number, c = CALIB): number {
  let var1 = BigInt(tf) - 128000n;
  let var2 = var1 * var1 * BigInt(c.P6);
  var2 = var2 + var1 * BigInt(c.P5) * 131072n;
  var2 = var2 + BigInt(c.P4) * 34359738368n;
  var1 = (var1 * var1 * BigInt(c.P3)) / 256n + var1 * BigInt(c.P2) * 4096n;
  var1 = ((140737488355328n + var1) * BigInt(c.P1)) / 8589934592n;
  if (var1 === 0n) return 0;
  let p = 1048576n - BigInt(adcP);
  p = ((p * 2147483648n - var2) * 3125n) / var1;
  var1 = (BigInt(c.P9) * (p / 8192n) * (p / 8192n)) / 33554432n;
  var2 = (BigInt(c.P8) * p) / 524288n;
  p = (p + var1 + var2) / 256n + BigInt(c.P7) * 16n;
  return Number(p);
}

/** %RH × 1024 (Q22.10), as Adafruit_BME280 computes it. */
export function compH(adcH: number, tf: number, c = CALIB): number {
  const i32 = (x: number) => x | 0;
  let var1 = tf - 76800;
  let var2 = i32(adcH * 16384);
  let var3 = i32(c.H4 * 1048576);
  let var4 = i32(c.H5 * var1);
  let var5 = trunc((var2 - var3 - var4 + 16384) / 32768);
  var2 = trunc((var1 * c.H6) / 1024);
  var3 = trunc((var1 * c.H3) / 2048);
  var4 = trunc((var2 * (var3 + 32768)) / 1024) + 2097152;
  var2 = trunc((var4 * c.H2 + 8192) / 16384);
  var3 = i32(var5 * var2);
  var4 = trunc((trunc(var3 / 32768) * trunc(var3 / 32768)) / 128);
  var5 = var3 - trunc((var4 * c.H1) / 16);
  var5 = clamp(var5, 0, 419430400);
  void var1;
  return trunc(var5 / 4096);
}

/** Smallest x in [lo, hi] with f(x) >= target for an increasing f (or <= for decreasing). */
function search(lo: number, hi: number, f: (x: number) => number, target: number, increasing: boolean): number {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const v = f(mid);
    if (increasing ? v >= target : v <= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Raw ADC values whose compensated readings are closest to the targets. */
export function rawFor(tempC: number, pressPa: number, humPct: number, c = CALIB): { t: number; p: number; h: number } {
  const t = search(0, 0xfffff, (x) => compT(x, c), Math.round(tempC * 100), true);
  const tf = tFine(t, c);
  const p = search(0, 0xfffff, (x) => compP(x, tf, c), Math.round(pressPa * 256), false);
  const h = search(0, 0xffff, (x) => compH(x, tf, c), Math.round(humPct * 1024), true);
  return { t, p, h };
}

function calibBytes(c = CALIB): { lo: Uint8Array; hi: Uint8Array } {
  // 0x88..0xA1
  const lo = new Uint8Array(26);
  const words = [c.T1, c.T2, c.T3, c.P1, c.P2, c.P3, c.P4, c.P5, c.P6, c.P7, c.P8, c.P9];
  words.forEach((w, i) => {
    lo[i * 2] = w & 0xff;
    lo[i * 2 + 1] = (w >> 8) & 0xff;
  });
  lo[25] = c.H1;
  // 0xE1..0xE7: H2 (s16), H3 (u8), H4 (12 bit: E4[7:0]<<4 | E5[3:0]), H5 (E5[7:4] | E6<<4), H6 (s8)
  const hi = new Uint8Array(7);
  hi[0] = c.H2 & 0xff;
  hi[1] = (c.H2 >> 8) & 0xff;
  hi[2] = c.H3;
  hi[3] = (c.H4 >> 4) & 0xff;
  hi[4] = (c.H4 & 0x0f) | ((c.H5 & 0x0f) << 4);
  hi[5] = (c.H5 >> 4) & 0xff;
  hi[6] = c.H6 & 0xff;
  return { lo, hi };
}

// ------------------------------------------------------------------ chip

export class Bme280 {
  regs = new Uint8Array(256);
  private ptr = 0;
  private first = true;
  temperature = 22.5;
  pressurehPa = 1013.25;
  humidity = 45;
  private raw = { t: 0, p: 0, h: 0 };
  private rawKey = "";
  measured = false;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    const { lo, hi } = calibBytes();
    this.regs.set(lo, 0x88);
    this.regs.set(hi, 0xe1);
    this.regs[0xd0] = CHIP_ID;
    this.measured = false;
    this.writeData(SKIPPED_TP, SKIPPED_TP, SKIPPED_H);
  }

  get mode(): "sleep" | "forced" | "normal" {
    const m = this.regs[0xf4]! & 3;
    return m === 0 ? "sleep" : m === 3 ? "normal" : "forced";
  }

  private rawNow() {
    const key = `${this.temperature}|${this.pressurehPa}|${this.humidity}`;
    if (key !== this.rawKey) {
      this.rawKey = key;
      this.raw = rawFor(this.temperature, this.pressurehPa * 100, this.humidity);
    }
    return this.raw;
  }

  /** Run one measurement with the current oversampling settings. */
  measure(): void {
    const osrsT = (this.regs[0xf4]! >> 5) & 7;
    const osrsP = (this.regs[0xf4]! >> 2) & 7;
    const osrsH = this.regs[0xf2]! & 7;
    const r = this.rawNow();
    this.writeData(osrsT ? r.t : SKIPPED_TP, osrsP ? r.p : SKIPPED_TP, osrsH ? r.h : SKIPPED_H);
    this.measured = true;
  }

  private writeData(t: number, p: number, h: number): void {
    const put20 = (at: number, v: number) => {
      this.regs[at] = (v >> 12) & 0xff;
      this.regs[at + 1] = (v >> 4) & 0xff;
      this.regs[at + 2] = (v & 0x0f) << 4;
    };
    put20(0xf7, p);
    put20(0xfa, t);
    this.regs[0xfd] = (h >> 8) & 0xff;
    this.regs[0xfe] = h & 0xff;
  }

  connect(read: boolean): void {
    if (read) {
      // Normal mode: a fresh measurement is always ready (the sensor keeps converting).
      if (this.mode === "normal") this.measure();
    } else this.first = true;
  }

  write(b: number): void {
    if (this.first) {
      this.ptr = b;
      this.first = false;
      return;
    }
    // In I2C mode the master sends register/value pairs; after the first, every even byte is an address.
    const reg = this.ptr;
    this.first = true;
    if (reg === 0xe0) {
      if (b === 0xb6) this.reset();
    } else if (reg === 0xf2) {
      this.regs[0xf2] = b & 7;
    } else if (reg === 0xf4) {
      this.regs[0xf4] = b;
      if ((b & 3) === 1 || (b & 3) === 2) {
        this.measure();
        this.regs[0xf4] = b & 0xfc; // forced mode returns to sleep when done
      } else if ((b & 3) === 3) this.measure();
    } else if (reg === 0xf5) {
      this.regs[0xf5] = b & 0xfd;
    }
  }

  read(): number {
    // status (0xF3): measuring and im_update always 0, conversions finish instantly
    const b = this.ptr === 0xf3 ? 0 : this.regs[this.ptr]!;
    this.ptr = (this.ptr + 1) & 0xff;
    return b;
  }

  /** The values a library would compute from the current raw data. */
  readings(): { temperature: number; pressure: number; humidity: number } {
    const r = this.rawNow();
    const tf = tFine(r.t);
    return { temperature: compT(r.t) / 100, pressure: compP(r.p, tf) / 256 / 100, humidity: compH(r.h, tf) / 1024 };
  }
}

export const create: PartModelFactory = (ctx): PartModel => {
  const mod = createI2cModule(ctx, { vccPin: "VIN", supplymA: 0.4, minVolts: 3.0, maxVolts: 5.5 });
  const chip = new Bme280();
  const apply = (id: string, v: unknown) => {
    if (id === "temperature") chip.temperature = clamp(num(v as number, 22.5), -40, 85);
    else if (id === "humidity") chip.humidity = clamp(num(v as number, 45), 0, 100);
    else if (id === "pressure") chip.pressurehPa = clamp(num(v as number, 1013.25), 300, 1100);
  };
  for (const id of ["temperature", "humidity", "pressure"]) apply(id, ctx.props[id]);

  const i2c: I2cDevice = {
    i2cAddress: mod.address,
    i2cConnect(read) {
      if (!mod.powered) return false;
      chip.connect(read);
      return true;
    },
    i2cWrite(b) {
      chip.write(b);
      return true;
    },
    i2cRead: () => chip.read(),
    i2cStop() {},
  };

  return {
    i2c,
    stamp: (c) => mod.stamp(c),
    onSolved: (r) => mod.onSolved(r),
    visualState() {
      const r = chip.readings();
      return {
        temperature: round(r.temperature, 2),
        humidity: round(r.humidity, 2),
        pressure: round(r.pressure, 2),
        mode: chip.mode,
        label: `${r.temperature.toFixed(1)}°C ${Math.round(r.humidity)}%`,
      };
    },
    setProp(id, v) {
      if (id === "address") mod.setAddressProp(v);
      else apply(id, v);
    },
    interact(e) {
      if (e.kind === "set" && e.key) apply(e.key, e.value);
    },
    diagnostics(): Diagnostic[] {
      return mod.diagnostics();
    },
  };
};
