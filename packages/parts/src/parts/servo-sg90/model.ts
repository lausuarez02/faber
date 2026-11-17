import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { GROUND } from "@fabwright/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

export const IDLE_MA = 10;
export const MOVING_MA = 250;
export const STALL_MA = 650;
/** Pulses outside this window are not servo pulses; the servo ignores them. */
export const VALID_PULSE_US = [400, 2600] as const;
const SIG_HIGH_V = 2.0;
const SIG_LOW_V = 0.8;

/** Pulse width (µs) → commanded angle (deg), the Arduino Servo library's linear map (not clamped). */
export function pulseToAngle(us: number, minUs = 544, maxUs = 2400): number {
  return ((us - minUs) / (maxUs - minUs)) * 180;
}

export const create: PartModelFactory = (ctx): PartModel => {
  const p = () => ({
    minUs: num(ctx.props.minPulseUs, 544),
    maxUs: num(ctx.props.maxPulseUs, 2400),
    secPer60: Math.max(0.01, num(ctx.props.speed, 0.1)),
    lo: clamp(num(ctx.props.minAngle, 0), 0, 180),
    hi: clamp(num(ctx.props.maxAngle, 180), 0, 180),
  });
  let P = p();
  let angle = clamp(num(ctx.props.initialAngle, 90), P.lo, P.hi);
  let target = angle;
  let commanded = angle; // before the mechanical clamp
  let pulseUs = 0;
  let vcc = 0;
  let moving = false;
  let stalled = false;
  let blockedAt: number | undefined;
  let sigHigh = false;
  let riseMs = 0;
  let lastT: number | undefined;
  let supply: ElementId | undefined;
  let currentA = 0;
  let badPulseUs: number | undefined;
  let fastPwmHz: number | undefined;
  let stampedMode = "idle";

  const mode = () => (stalled ? "stall" : moving ? "moving" : "idle");

  const acceptPulse = (us: number) => {
    if (us < VALID_PULSE_US[0] || us > VALID_PULSE_US[1]) {
      badPulseUs = us;
      return;
    }
    badPulseUs = undefined;
    pulseUs = us;
    commanded = clamp(pulseToAngle(us, P.minUs, P.maxUs), 0, 180);
    let t = clamp(commanded, P.lo, P.hi);
    if (blockedAt !== undefined) t = angle <= blockedAt ? Math.min(t, blockedAt) : Math.max(t, blockedAt);
    target = t;
  };

  return {
    stamp(c) {
      stampedMode = mode();
      const mA = stampedMode === "stall" ? STALL_MA : stampedMode === "moving" ? MOVING_MA : IDLE_MA;
      // Resistive load drawing `mA` at 4.8 V.
      supply = c.resistor(ctx.node("VCC"), GROUND, 4.8 / (mA / 1000), { id: "motor" });
    },
    onSolved(r, tMs) {
      vcc = r.voltage(ctx.node("VCC"));
      currentA = supply ? r.current(supply) : 0;
      const pw = ctx.pwm?.("SIG");
      if (pw?.averaged) {
        // analogWrite() on the signal pin: 490/980 Hz, not servo pulses.
        fastPwmHz = pw.freqHz;
        if (pw.highUs > 0) acceptPulse(pw.highUs);
        return;
      }
      fastPwmHz = undefined;
      const v = r.voltage(ctx.node("SIG"));
      if (!sigHigh && v >= SIG_HIGH_V) {
        sigHigh = true;
        riseMs = tMs;
      } else if (sigHigh && v <= SIG_LOW_V) {
        sigHigh = false;
        // Prefer the cycle-stamped measurement of the MCU pin driving SIG.
        const us = pw && pw.source.startsWith("mcu:") && pw.highUs > 0 ? pw.highUs : (tMs - riseMs) * 1000;
        acceptPulse(us);
      }
    },
    tick(tMs, dtMs) {
      const dt = (lastT === undefined ? dtMs : Math.max(0, tMs - lastT)) / 1000;
      lastT = tMs;
      const volts = clamp(vcc / 4.8, 0, 1.3);
      const rate = vcc < 3.5 ? 0 : (60 / P.secPer60) * volts; // deg/s
      const err = target - angle;
      const step = rate * dt;
      if (Math.abs(err) <= step) angle = target;
      else angle += Math.sign(err) * step;
      moving = Math.abs(target - angle) > 0.05;
      // Stalled: it wants to go further than a stop lets it.
      const wantsPast = commanded < P.lo - 0.5 || commanded > P.hi + 0.5 || (blockedAt !== undefined && Math.abs(angle - blockedAt) < 0.05 && Math.abs(commanded - blockedAt) > 0.5);
      stalled = !moving && wantsPast && vcc >= 3.5;
      if (mode() !== stampedMode) ctx.requestSolve();
    },
    visualState() {
      return {
        angle: round(angle, 2),
        target: round(target, 2),
        pulseUs: round(pulseUs, 1),
        moving,
        stalled,
        hornTransform: `rotate(${round(angle - 90, 1)} 112 50)`,
        label: `${Math.round(angle)}°`,
        currentmA: round(currentA * 1000, 1),
      };
    },
    setProp() {
      P = p();
      target = clamp(target, P.lo, P.hi);
      angle = clamp(angle, P.lo, P.hi);
    },
    interact(e) {
      // set key "blockedAt" (deg): something blocks the horn there; a negative value clears it.
      if (e.kind === "set" && (e.key === undefined || e.key === "blockedAt")) {
        const v = Number(e.value);
        blockedAt = Number.isFinite(v) && v >= 0 ? clamp(v, 0, 180) : undefined;
        if (blockedAt !== undefined) target = angle <= blockedAt ? Math.min(target, blockedAt) : Math.max(target, blockedAt);
      }
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (fastPwmHz !== undefined) {
        out.push({
          severity: "warning",
          code: "servo-not-servo-pulses",
          pin: "SIG",
          message: `${id}:SIG gets ${fastPwmHz.toFixed(0)} Hz PWM (analogWrite), but a servo needs 50 Hz pulses of 544–2400 µs, so on hardware it jitters or does not move. Use the Servo library: #include <Servo.h>, Servo s; s.attach(pin); s.write(angle);`,
        });
      }
      if (badPulseUs !== undefined) {
        out.push({
          severity: "warning",
          code: "servo-pulse-out-of-range",
          pin: "SIG",
          message: `${id} got a ${badPulseUs.toFixed(0)} µs pulse; servos only understand ${VALID_PULSE_US[0]}–${VALID_PULSE_US[1]} µs (544 = 0°, 2400 = 180°), so it ignored it. Use servo.write(0..180) or writeMicroseconds(544..2400).`,
        });
      }
      if (stalled) {
        out.push({
          severity: "warning",
          code: "servo-stalled",
          message: `${id} is pushing against a stop at ${Math.round(angle)}° (asked for ${Math.round(commanded)}°) and draws ~${STALL_MA} mA; a real SG90 heats up and can strip its gears. Limit the angle in code to ${Math.round(P.lo)}–${Math.round(P.hi)}°.`,
        });
      }
      if (vcc <= 0.5 && pulseUs > 0) {
        out.push({
          severity: "error",
          code: "servo-unpowered",
          pin: "VCC",
          message: `${id} gets control pulses but its V+ (red) has no power, so it cannot move. Wire ${id}:VCC → 5V and ${id}:GND → GND.`,
        });
      }
      if (vcc > 0.5 && vcc < 4.0) {
        out.push({
          severity: "warning",
          code: "servo-undervoltage",
          pin: "VCC",
          message: `${id} gets ${vcc.toFixed(2)} V on V+ (needs 4.8–6 V), so it is slow or does not move. Power it from 5V; for several servos use a separate 5–6 V supply with a common GND.`,
        });
      }
      if (vcc > 6.2) {
        out.push({ severity: "error", code: "servo-overvoltage", pin: "VCC", message: `${id} gets ${vcc.toFixed(1)} V on V+; the SG90 is rated 4.8–6 V and will burn out. Use a 5 V supply.` });
      }
      return out;
    },
  };
};
