// DS3231 real-time clock (Maxim datasheet 19-5170): timekeeping registers 0x00-0x06 in BCD,
// alarms 0x07-0x0D (stored), control 0x0E, status 0x0F (OSF), aging 0x10, temperature 0x11-0x12.
// Time is deterministic: startTime prop + simulation time (+ whatever the sketch set).
import type { Diagnostic, I2cDevice, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { createI2cModule } from "../../lib/i2cModule.ts";
import { clamp, num, round, truthy } from "../../lib/props.ts";
import { fromEpoch, formatTime, parseTime, toEpoch, bcd, unbcd, type DateTime } from "../../lib/calendar.ts";

const REGS = 0x13;

export { civilFromDays, daysFromCivil, formatTime, fromEpoch, parseTime, toEpoch, type DateTime } from "../../lib/calendar.ts";


// ---------------------------------------------------------------- chip

export class Ds3231 {
  regs = new Uint8Array(REGS);
  /** Clock seconds at sim time 0 (shifted when the sketch writes the time). */
  base: number;
  /** Fractional-second phase is kept so writes restart the second like the chip does. */
  private phaseMs = 0;
  ptr = 0;
  private first = true;
  private latched: Uint8Array | undefined;
  private written = false;
  temperature = 25;

  constructor(
    startEpoch: number,
    lostPower: boolean,
    private readonly nowMs: () => number,
  ) {
    this.base = startEpoch;
    this.regs[0x0e] = 0x1c; // INTCN = 1, RS2 = RS1 = 1 (datasheet power-on state)
    this.regs[0x0f] = lostPower ? 0x88 : 0x08; // OSF, EN32kHz
  }

  /** Clock time in whole seconds now. */
  epoch(): number {
    return this.base + Math.floor((this.nowMs() - this.phaseMs) / 1000);
  }

  /** The 19 registers as the chip would return them now. */
  snapshot(): Uint8Array {
    const r = this.regs.slice();
    const t = fromEpoch(this.epoch());
    const twelve = (this.regs[0x02]! & 0x40) !== 0;
    r[0x00] = bcd(t.second);
    r[0x01] = bcd(t.minute);
    if (twelve) {
      const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
      r[0x02] = 0x40 | (t.hour >= 12 ? 0x20 : 0) | bcd(h12);
    } else r[0x02] = bcd(t.hour);
    r[0x03] = t.weekday + 1; // the chip only counts 1..7; RTClib uses 0 = Sunday on write
    r[0x04] = bcd(t.day);
    const century = t.year >= 2100 ? 0x80 : 0;
    r[0x05] = century | bcd(t.month);
    r[0x06] = bcd(t.year % 100);
    // Temperature: two's complement integer + quarter degrees in bits 7:6 of 0x12.
    const q = Math.round(this.temperature * 4);
    r[0x11] = (q >> 2) & 0xff;
    r[0x12] = (q & 3) << 6;
    return r;
  }

  connect(read: boolean): void {
    if (read) this.latched = this.snapshot(); // time is copied to the read buffer at START
    else this.first = true;
  }

  write(b: number): void {
    if (this.first) {
      this.ptr = b % REGS;
      this.first = false;
      return;
    }
    if (this.ptr <= 0x06) {
      // Writing any time register: rebuild the time from the current registers.
      if (!this.written) {
        this.regs.set(this.snapshot().subarray(0, 7));
        this.written = true;
      }
      this.regs[this.ptr] = b;
    } else if (this.ptr === 0x0f) {
      // OSF and the alarm flags can only be cleared; EN32kHz and the rest are writable.
      this.regs[0x0f] = (this.regs[0x0f]! & b & 0x83) | (b & 0x08);
    } else if (this.ptr !== 0x11 && this.ptr !== 0x12) {
      this.regs[this.ptr] = b;
    }
    this.ptr = (this.ptr + 1) % REGS;
  }

  read(): number {
    const src = this.latched ?? this.snapshot();
    const b = src[this.ptr]!;
    this.ptr = (this.ptr + 1) % REGS;
    return b;
  }

  stop(): void {
    this.latched = undefined;
    if (this.written) this.commitTime();
  }

  private commitTime(): void {
    this.written = false;
    const r = this.regs;
    const h = r[0x02]!;
    let hour: number;
    if (h & 0x40) {
      const h12 = unbcd(h & 0x1f);
      hour = (h12 % 12) + (h & 0x20 ? 12 : 0);
    } else hour = unbcd(h & 0x3f);
    const century = r[0x05]! & 0x80 ? 2100 : 2000;
    const t: DateTime = {
      year: century + unbcd(r[0x06]!),
      month: clamp(unbcd(r[0x05]! & 0x1f), 1, 12),
      day: clamp(unbcd(r[0x04]! & 0x3f), 1, 31),
      hour: clamp(hour, 0, 23),
      minute: clamp(unbcd(r[0x01]! & 0x7f), 0, 59),
      second: clamp(unbcd(r[0x00]! & 0x7f), 0, 59),
    };
    // The countdown chain restarts when the seconds register is written.
    this.phaseMs = this.nowMs();
    this.base = toEpoch(t);
  }
}

const DEFAULT_START = "2026-01-01T12:00:00";

/** One DS3231 module: the chip's own draw and, when the board has one, its power LED. */
export interface Ds3231ModuleOptions {
  /** The chip with the bus idle, mA (datasheet ICCS: 0.11 mA at 3.3 V, 0.17 mA max). */
  chipmA: number;
  /** A power LED the module carries (ZS-042: about 1.5 mA at 3.3 V, 3 mA at 5 V), lit unless prop powerLed is false. */
  ledmA?: number;
  /** Diagnostics for a module that charges its coin cell from VCC (ZS-042: 200 Ω + 1N4148 to a CR2032). */
  chargesCell?: boolean;
}

/** The DS3231 model for any module that carries the chip (ZS-042, the Pi-style mini, Adafruit breakouts). */
export function createDs3231Module(o: Ds3231ModuleOptions): PartModelFactory {
  return (ctx) => ds3231Model(ctx, o);
}

export const create: PartModelFactory = createDs3231Module({ chipmA: 0.11, ledmA: 1.89, chargesCell: true });

function ds3231Model(ctx: Parameters<PartModelFactory>[0], o: Ds3231ModuleOptions): PartModel {
  let led = o.ledmA !== undefined && ctx.props.powerLed !== false;
  // supplies are stamped as resistors sized for 5 V (createI2cModule); the LED is a second one, so
  // prop powerLed (the LED or its jumper cut off) can change it while running
  const mod = createI2cModule(ctx, { supplymA: o.chipmA, minVolts: 2.3, maxVolts: 5.5 });
  let badStart: string | undefined;
  const startOf = (v: unknown) => {
    const s = typeof v === "string" ? parseTime(v) : undefined;
    badStart = s === undefined ? String(v) : undefined;
    return s ?? parseTime(DEFAULT_START)!;
  };
  const chip = new Ds3231(startOf(ctx.props.startTime), truthy(ctx.props.lostPower), () => ctx.now());
  chip.temperature = num(ctx.props.temperature, 25);

  const i2c: I2cDevice = {
    i2cAddress: () => 0x68,
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
    i2cStop: () => chip.stop(),
  };

  return {
    i2c,
    stamp: (c) => {
      mod.stamp(c);
      if (led) c.resistor(ctx.node("VCC"), ctx.node("GND"), 5 / (o.ledmA! / 1000), { id: "power-led" });
    },
    onSolved: (r) => mod.onSolved(r),
    visualState() {
      const now = chip.epoch();
      const s = formatTime(now);
      return {
        time: s,
        clock: s.slice(11),
        temperature: round(Math.round(chip.temperature * 4) / 4, 2),
        running: mod.powered,
        lostPower: (chip.regs[0x0f]! & 0x80) !== 0,
        ...(o.ledmA !== undefined ? { powerLed: led && mod.powered } : {}),
      };
    },
    setProp(id, v) {
      if (id === "startTime") {
        // Keep the time already elapsed: the new start applies at sim time 0.
        chip.base = startOf(v);
      } else if (id === "temperature") chip.temperature = clamp(num(v, 25), -40, 85);
      else if (id === "lostPower") chip.regs[0x0f] = truthy(v) ? chip.regs[0x0f]! | 0x80 : chip.regs[0x0f]! & 0x7f;
      else if (id === "powerLed" && o.ledmA !== undefined && truthy(v) !== led) {
        led = truthy(v);
        ctx.requestSolve();
      }
    },
    interact(e) {
      if (e.kind === "set" && e.key === "temperature") chip.temperature = clamp(num(e.value as number, 25), -40, 85);
      if (e.kind === "set" && e.key === "time" && typeof e.value === "string") {
        const t = parseTime(e.value);
        if (t !== undefined) chip.base = t - Math.floor(ctx.now() / 1000);
      }
    },
    diagnostics() {
      const out: Diagnostic[] = mod.diagnostics();
      if (badStart !== undefined) {
        out.push({
          severity: "warning",
          code: "rtc-bad-start-time",
          message: `${ctx.id}: startTime '${badStart}' is not a date like 2026-01-01T12:00:00, so the clock starts at ${DEFAULT_START}. Set startTime as YYYY-MM-DDTHH:MM:SS.`,
        });
      }
      if (o.chargesCell && mod.powered && mod.volts > 4.2) {
        out.push({
          severity: "warning",
          code: "rtc-charges-coin-cell",
          pin: "VCC",
          message: `${ctx.id}: VCC is ${mod.volts.toFixed(1)} V and this module (ZS-042) charges its coin cell from VCC through a 200 Ω resistor and a diode. Why: a CR2032 is not rechargeable; charging it can make it swell or leak. Fix: run the module from 3.3 V, or remove the diode (or its 200 Ω resistor) next to the cell holder, or fit a rechargeable LIR2032; a small DS3231 module without the charger (ds3231-mini-rtc) or an RV-3028 (rv3028-rtc) avoids it.`,
        });
      }
      return out;
    },
  };
}
