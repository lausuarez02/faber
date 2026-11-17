import type { Diagnostic, PartModel, PartModelFactory } from "@faber/sim-core";
import { GROUND } from "@faber/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

export const MIN_TRIGGER_US = 10;
/** TRIG falling edge → ECHO rising edge: 8 cycles of 40 kHz (200 µs) plus the module's own processing. */
export const BURST_DELAY_US = 460;
export const MIN_RANGE_CM = 2;
export const MAX_RANGE_CM = 400;
/** ECHO HIGH time when nothing returns. */
export const TIMEOUT_US = 38_000;
const SUPPLY_MA = 15;
const TRIG_HIGH_V = 2.0;
const TRIG_LOW_V = 0.8;

/** Speed of sound in air (m/s) at `celsius`. */
export const speedOfSound = (celsius: number): number => 331.3 + 0.606 * celsius;

/** ECHO HIGH time (µs) for a target at `cm`, or TIMEOUT_US when out of range. */
export function echoMicros(cm: number, celsius = 20): number {
  if (!Number.isFinite(cm) || cm <= 0 || cm > MAX_RANGE_CM) return TIMEOUT_US;
  const d = Math.max(MIN_RANGE_CM, cm) / 100; // m
  return ((2 * d) / speedOfSound(celsius)) * 1e6;
}

export const create: PartModelFactory = (ctx): PartModel => {
  let distance = num(ctx.props.distance, 100);
  let celsius = num(ctx.props.temperature, 20);
  let vcc = 0;
  let powered = false;
  let echo = false;
  let measuring = false;
  let trigHigh = false;
  let trigRiseMs = 0;
  let lastEchoUs = 0;
  let pings = 0;
  let shortTrigUs: number | undefined;
  let ignoredWhileBusy = 0;
  let trigWhileUnpowered = false;
  /** Cancels the pending ECHO edge event (dropped on dispose). */
  let pending: (() => void) | undefined;

  const startMeasurement = () => {
    measuring = true;
    pings++;
    const schedule = ctx.schedule;
    if (!schedule) {
      // Bench without a clock: compute the result, no pin timing.
      lastEchoUs = echoMicros(distance, celsius);
      measuring = false;
      return;
    }
    pending = schedule(BURST_DELAY_US / 1000, () => {
        // The distance at the moment the burst leaves counts (the robot may be moving).
        const width = echoMicros(distance, celsius);
        echo = true;
        ctx.requestSolve();
        pending = schedule(width / 1000, () => {
          pending = undefined;
          echo = false;
          measuring = false;
          lastEchoUs = width;
          ctx.requestSolve();
        });
      });
  };

  return {
    stamp(c) {
      c.resistor(ctx.node("VCC"), GROUND, 5 / (SUPPLY_MA / 1000), { id: "supply" });
      if (powered) c.voltageSource(ctx.node("ECHO"), GROUND, echo ? vcc : 0, 50, { id: "echo" });
    },
    onSolved(r, tMs) {
      vcc = r.voltage(ctx.node("VCC"));
      const nowPowered = vcc >= 4.5;
      if (nowPowered !== powered) {
        powered = nowPowered;
        if (!powered) {
          echo = false;
          measuring = false;
        }
        ctx.requestSolve();
      }
      const t = r.voltage(ctx.node("TRIG"));
      if (!trigHigh && t >= TRIG_HIGH_V) {
        trigHigh = true;
        trigRiseMs = tMs;
      } else if (trigHigh && t <= TRIG_LOW_V) {
        trigHigh = false;
        const widthUs = (tMs - trigRiseMs) * 1000;
        if (!powered) trigWhileUnpowered = true;
        else if (widthUs + 1e-6 < MIN_TRIGGER_US) shortTrigUs = widthUs;
        else if (measuring) ignoredWhileBusy++;
        else startMeasurement();
      }
    },
    visualState() {
      const inRange = distance > 0 && distance <= MAX_RANGE_CM;
      return {
        distance: round(distance, 2),
        echo,
        measuring,
        label: inRange ? `${Math.round(Math.max(distance, MIN_RANGE_CM))} cm` : "> 400 cm",
        lastEchoUs: round(lastEchoUs, 1),
        pings,
      };
    },
    setProp(id, v) {
      if (id === "distance") distance = clamp(num(v, distance), 0, 1000);
      if (id === "temperature") celsius = clamp(num(v, celsius), -40, 85);
    },
    interact(e) {
      // set (key "distance" or none) → distance in cm; ≤ 0 or > 400 = nothing in range.
      if (e.kind === "set" && (e.key === undefined || e.key === "distance" || e.key === "distance_cm" || e.key === "distanceCm")) {
        const v = Number(e.value);
        distance = Number.isFinite(v) ? clamp(v, 0, 1000) : 0;
      }
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (shortTrigUs !== undefined) {
        out.push({
          severity: "info",
          code: "hc-sr04-short-trigger",
          pin: "TRIG",
          message: `${id}: a TRIG pulse was only ${shortTrigUs.toFixed(1)} µs, so no measurement started (it needs ≥ ${MIN_TRIGGER_US} µs HIGH). Use digitalWrite(TRIG, LOW); delayMicroseconds(2); digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);`,
        });
      }
      if (trigWhileUnpowered) {
        out.push({
          severity: "error",
          code: "hc-sr04-unpowered",
          pin: "VCC",
          message: `${id} was triggered but VCC is ${vcc.toFixed(1)} V (needs 4.5–5.5 V), so ECHO never answers and pulseIn() returns 0. Wire ${id}:VCC → Arduino 5V and ${id}:GND → GND.`,
        });
      }
      if (ignoredWhileBusy > 0) {
        out.push({
          severity: "info",
          code: "hc-sr04-busy",
          pin: "TRIG",
          message: `${id}: ${ignoredWhileBusy} trigger(s) came while a measurement was still running and were ignored. Wait for ECHO to fall (pulseIn with a 30000 µs timeout) and leave ~60 ms between pings.`,
        });
      }
      return out;
    },
    dispose() {
      pending?.();
      pending = undefined;
    },
  };
};
