// DHT22 / AM2302 on its 3-pin module (10 kΩ pull-up). Single-bus protocol (AM2302 datasheet):
//   host pulls DATA low ≥ 0.8 ms (1–10 ms typ.), releases it; 20–40 µs later the sensor answers
//   80 µs LOW, 80 µs HIGH, then 40 bits, each 50 µs LOW + 26 µs (0) or 70 µs (1) HIGH, then
//   50 µs LOW and releases. Data: humidity × 10 (16 bit), temperature × 10 (16 bit, bit 15 =
//   negative), checksum = low byte of the sum of the four bytes.
// The start pulse is seen in onSolved (the MCU's pin change re-solves at its exact cycle); the
// answer is a chain of ctx.schedule events that pull DATA low or let the pull-up raise it.
// The sensor returns the measurement taken at the PREVIOUS read (datasheet note): a new value
// shows on the second read after it changed.
import type { Diagnostic, PartModel, PartModelFactory } from "@faber/sim-core";
import { GROUND } from "@faber/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

export const START_LOW_MIN_MS = 0.8;
export const RESPONSE_DELAY_US = 30;
export const MIN_INTERVAL_MS = 2000;
export const POWER_UP_MS = 1000;
const MIN_VCC = 3.0;

/** The 5 bytes the sensor sends for a reading. */
export function dhtFrame(temperature: number, humidity: number): number[] {
  const h = Math.round(clamp(humidity, 0, 100) * 10);
  const t = Math.round(clamp(Math.abs(temperature), 0, 80) * 10) | (temperature < 0 ? 0x8000 : 0);
  const b = [(h >> 8) & 0xff, h & 0xff, (t >> 8) & 0xff, t & 0xff];
  return [...b, (b[0]! + b[1]! + b[2]! + b[3]!) & 0xff];
}

/** LOW / HIGH phases (µs) of a whole answer, starting with the 80 µs LOW. */
export function dhtWaveform(bytes: number[]): [0 | 1, number][] {
  const out: [0 | 1, number][] = [[0, 80], [1, 80]];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      out.push([0, 50]);
      out.push([1, (byte >> i) & 1 ? 70 : 26]);
    }
  }
  out.push([0, 50]);
  return out;
}

export const create: PartModelFactory = (ctx): PartModel => {
  let temperature = clamp(num(ctx.props.temperature, 22), -40, 80);
  let humidity = clamp(num(ctx.props.humidity, 55), 0, 100);
  let latched = { t: temperature, h: humidity };
  let vcc = 0;
  let powered = false;
  let poweredAt = 0;
  let pullLow = false;
  let sending = false;
  let lineHigh = true;
  let lowSince = 0;
  let lastReadAt = -Infinity;
  let reads = 0;
  let tooFast = 0;
  let early = 0;
  let shortStart: number | undefined;
  let cancel: (() => void) | undefined;

  const send = (phases: [0 | 1, number][], i: number) => {
    if (i >= phases.length) {
      pullLow = false;
      sending = false;
      cancel = undefined;
      ctx.requestSolve();
      return;
    }
    const [level, us] = phases[i]!;
    pullLow = level === 0;
    ctx.requestSolve();
    cancel = ctx.schedule!(us / 1000, () => send(phases, i + 1));
  };

  const answer = (tMs: number) => {
    if (!ctx.schedule) return;
    if (tMs < poweredAt + POWER_UP_MS) {
      early++;
      return;
    }
    if (tMs - lastReadAt < MIN_INTERVAL_MS) tooFast++;
    const bytes = dhtFrame(latched.t, latched.h);
    // Measured now; sent at the next read (unless reads come faster than the sensor measures).
    if (tMs - lastReadAt >= MIN_INTERVAL_MS) latched = { t: temperature, h: humidity };
    lastReadAt = tMs;
    reads++;
    sending = true;
    cancel = ctx.schedule(RESPONSE_DELAY_US / 1000, () => send(dhtWaveform(bytes), 0));
  };

  return {
    stamp(c) {
      const v = ctx.node("VCC");
      c.resistor(v, GROUND, 5 / 0.00005, { id: "standby" });
      c.resistor(ctx.node("DATA"), v, 10_000, { id: "pullup" });
      if (powered && pullLow) c.voltageSource(ctx.node("DATA"), GROUND, 0, 30, { id: "drive" });
    },
    onSolved(r, tMs) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const p = vcc >= MIN_VCC;
      if (p !== powered) {
        powered = p;
        poweredAt = tMs;
        // Measured at power-up.
        latched = { t: temperature, h: humidity };
        if (!p) {
          cancel?.();
          cancel = undefined;
          sending = false;
          pullLow = false;
        }
        ctx.requestSolve();
      }
      if (sending || !powered) {
        lineHigh = true;
        return;
      }
      const high = r.voltage(ctx.node("DATA")) > vcc * 0.5;
      if (lineHigh && !high) lowSince = tMs;
      else if (!lineHigh && high) {
        const width = tMs - lowSince;
        if (width >= START_LOW_MIN_MS) answer(tMs);
        else if (width > 0.1) shortStart = width;
      }
      lineHigh = high;
    },
    visualState() {
      return {
        temperature: round(temperature, 2),
        humidity: round(humidity, 2),
        label: `${temperature.toFixed(1)} °C · ${Math.round(humidity)} %`,
        reads,
        sending,
      };
    },
    setProp(id, v) {
      if (id === "temperature") temperature = clamp(num(v, temperature), -40, 80);
      if (id === "humidity") humidity = clamp(num(v, humidity), 0, 100);
    },
    interact(e) {
      if (e.kind !== "set") return;
      const v = Number(e.value);
      if (!Number.isFinite(v)) return;
      if (e.key === "humidity") humidity = clamp(v, 0, 100);
      else if (e.key === undefined || e.key === "temperature") temperature = clamp(v, -40, 80);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (!powered && vcc > 0.3) out.push({ severity: "error", code: "dht-undervoltage", pin: "VCC", message: `${id} VCC is ${vcc.toFixed(1)} V (needs 3.3 to 6 V), so it never answers and the library reports NaN / a timeout. Wire VCC to 3V3 or 5V.` });
      if (early > 0) out.push({ severity: "info", code: "dht-read-too-early", message: `${id} was asked for a reading ${early} time(s) less than 1 s after power-up and did not answer (the sensor is still starting). Wait 1–2 s in setup() before the first read.` });
      if (tooFast > 0) out.push({ severity: "info", code: "dht-read-too-fast", message: `${id} was read ${tooFast} time(s) less than 2 s after the previous read, so it repeated an old measurement. Read it at most every 2 s (delay(2000) in loop()).` });
      if (shortStart !== undefined) out.push({ severity: "info", code: "dht-short-start", pin: "DATA", message: `${id}: the start pulse was only ${(shortStart * 1000).toFixed(0)} µs LOW; the DHT22 needs at least 800 µs (libraries use 1–1.1 ms), so it did not answer.` });
      return out;
    },
    dispose() {
      cancel?.();
      cancel = undefined;
    },
  };
};
