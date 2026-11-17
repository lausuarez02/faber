import type { Diagnostic, ElementId, PartModel, PartModelFactory, PwmReading } from "@fabwright/sim-core";
import { num, round } from "../../lib/props.ts";

/** Brushed DC motor constants derived from the datasheet-style props (SI units, output shaft). */
export interface MotorParams {
  /** Winding resistance (Ω). */
  R: number;
  /** Back-EMF constant (V·s/rad) == torque constant (N·m/A). */
  Ke: number;
  /** Viscous friction (N·m·s/rad). */
  b: number;
  /** Coulomb (static/dry) friction torque (N·m). */
  Tc: number;
  /** Rotor + gearbox inertia at the output shaft (kg·m²). */
  J: number;
  /** No-load speed at the rated voltage (rad/s). */
  w0: number;
}

const RPM = 60 / (2 * Math.PI);

/**
 * From rated voltage V, no-load speed w0, stall current Is and no-load current I0:
 *   R = V / Is;  Ke = (V − I0·R) / w0;  friction torque at w0 = Ke·I0 (half dry, half viscous);
 *   J from the mechanical time constant τ = J / (Ke²/R + b).
 */
export function motorParams(p: { ratedVoltage: number; noLoadRpm: number; stallCurrent: number; noLoadCurrent: number; timeConstantMs: number }): MotorParams {
  const V = Math.max(0.1, p.ratedVoltage);
  const w0 = Math.max(0.1, p.noLoadRpm) / RPM;
  const Is = Math.max(1e-3, p.stallCurrent);
  const I0 = Math.min(Math.max(1e-4, p.noLoadCurrent), Is * 0.9);
  const R = V / Is;
  const Ke = Math.max(1e-6, (V - I0 * R) / w0);
  const Tf = Ke * I0;
  const Tc = Tf / 2;
  const b = Tf / 2 / w0;
  const tau = Math.max(0.005, p.timeConstantMs / 1000);
  const J = tau * (Ke * Ke / R + b);
  return { R, Ke, b, Tc, J, w0 };
}

export const create: PartModelFactory = (ctx): PartModel => {
  const read = () => ({
    ratedVoltage: num(ctx.props.ratedVoltage, 6),
    noLoadRpm: num(ctx.props.noLoadRpm, 200),
    stallCurrent: num(ctx.props.stallCurrent, 1.5),
    noLoadCurrent: num(ctx.props.noLoadCurrent, 0.15),
    timeConstantMs: num(ctx.props.timeConstantMs, 60),
  });
  let raw = read();
  let P = motorParams(raw);

  let omega = 0; // rad/s, output shaft
  let omegaStamped = 0;
  let angleDeg = 0; // visual
  let winding: ElementId | undefined;
  let dStamped = 1; // PWM duty the last stamp used (0 = open)
  let iSolved = 0; // average winding current (A) into A, from the last solve
  let vAB = 0;
  let loadTorque = 0; // N·m from outside (physics, a test)
  let lastT: number | undefined;
  let directGpio: string | undefined;
  let stallMs = 0;

  /** Duty of a fast PWM switching this motor's net (declared by an H-bridge), or 1. */
  const duty = (): { d: number; pw: PwmReading | undefined } => {
    const a = ctx.pwm?.("A");
    const b = ctx.pwm?.("B");
    directGpio = a?.source.startsWith("mcu:") ? a.source.slice(4) : b?.source.startsWith("mcu:") ? b.source.slice(4) : undefined;
    const pw = a?.averaged ? a : b?.averaged ? b : undefined;
    return { d: pw ? pw.duty : 1, pw };
  };

  /** Current right now: the last solve corrected for the speed change since (dI/dω = −Ke/Reff). */
  const currentNow = () => (dStamped > 0 ? iSolved - (P.Ke * (omega - omegaStamped)) / P.R : 0);

  return {
    stamp(c) {
      const { d } = duty();
      omegaStamped = omega;
      if (d <= 5e-3) {
        // Driver output off for (almost) the whole period: the winding carries no current.
        dStamped = 0;
        winding = c.resistor(ctx.node("A"), ctx.node("B"), 1e7, { id: "winding-open" });
        return;
      }
      dStamped = d;
      // Duty-averaged winding (continuous current, the inductance smooths it):
      //   motor current I = (d·V_on − Ke·ω) / R, where V_on is the terminal voltage while driven,
      //   and the supply only delivers it during the on-time, so the circuit carries d·I.
      // As a Norton source between A and B: volts = Ke·ω/d, rOut = R/d². Current delivered out of
      // A = d·(Ke·ω − d·V_AB)/R = −d·I. With d = 1 this is the plain motor: Ke·ω behind R.
      winding = c.voltageSource(ctx.node("A"), ctx.node("B"), (P.Ke * omega) / d, P.R / (d * d), { id: "winding" });
    },
    onSolved(r) {
      vAB = r.voltage(ctx.node("A")) - r.voltage(ctx.node("B"));
      iSolved = winding !== undefined && dStamped > 0 ? -r.current(winding) / dStamped : 0;
    },
    tick(tMs, dtMs) {
      const dt = (lastT === undefined ? dtMs : Math.max(0, tMs - lastT)) / 1000;
      lastT = tMs;
      if (dt <= 0) return;
      const i = currentNow();
      const drive = P.Ke * i;
      // Dry friction plus the external load both oppose motion and can hold the shaft still.
      const hold = P.Tc + Math.abs(loadTorque);
      let next: number;
      if (Math.abs(omega) < 1e-3 && Math.abs(drive) <= hold) {
        next = 0; // static friction / load holds it
      } else {
        const dir = Math.abs(omega) >= 1e-3 ? Math.sign(omega) : Math.sign(drive);
        const torque = drive - P.b * omega - hold * dir;
        next = omega + (torque / P.J) * dt;
        if (omega !== 0 && Math.sign(next) !== Math.sign(omega)) next = 0; // friction stops it, never reverses it
      }
      omega = next;
      angleDeg = (angleDeg + omega * dt * (180 / Math.PI)) % 360;
      if (Math.abs(omega) < 0.05 * P.w0 && Math.abs(i) > 0.5 * (raw.ratedVoltage / P.R)) stallMs += dt * 1000;
      else stallMs = 0;
      // Re-solve when the back-EMF moved enough to matter (1 % of no-load speed).
      if (Math.abs(omega - omegaStamped) > 0.01 * P.w0) ctx.requestSolve();
    },
    visualState() {
      const rpm = omega * RPM;
      return {
        rpm: round(rpm, 1),
        omega: round(omega, 4),
        spinning: Math.abs(rpm) > 1,
        spinTransform: `rotate(${round(angleDeg, 1)} 98 40)`,
        currentmA: round(currentNow() * 1000, 1),
        volts: round(vAB, 3),
        label: `${Math.round(rpm)} rpm`,
      };
    },
    setProp() {
      raw = read();
      P = motorParams(raw);
    },
    interact(e) {
      // set key "loadTorque" (N·m, opposing rotation) — e.g. a blocked wheel. No key = same.
      if (e.kind === "set" && (e.key === undefined || e.key === "loadTorque")) {
        const v = Number(e.value);
        loadTorque = Number.isFinite(v) ? v : 0;
      }
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (directGpio) {
        out.push({
          severity: "error",
          code: "dc-motor-on-gpio",
          pin: "A",
          message: `${id} is wired straight to the Arduino pin ${directGpio}. A motor needs 150–1500 mA, a pin gives 20 mA (40 mA absolute max) and the motor's voltage spikes can kill it. Drive it through a motor driver: ${directGpio} → l298n IN1 (or ENA), l298n OUT1/OUT2 → ${id} A/B, battery → l298n 12V.`,
        });
      }
      const vmax = ctx.spec.limits?.maxVoltage ?? 9;
      if (Math.abs(vAB) > vmax) {
        out.push({
          severity: "warning",
          code: "dc-motor-overvoltage",
          message: `${id} gets ${Math.abs(vAB).toFixed(1)} V; it is rated ${raw.ratedVoltage} V (keep it under ${vmax} V). It will run too fast and wear out. Use a lower supply or limit the PWM duty.`,
        });
      }
      if (stallMs > 500) {
        out.push({
          severity: "warning",
          code: "dc-motor-stalled",
          message: `${id} is stalled: it draws ${(Math.abs(currentNow()) * 1000).toFixed(0)} mA but does not turn. A stalled motor overheats and browns out the supply. Check the load (loadTorque ${loadTorque} N·m) or lower the drive.`,
        });
      }
      return out;
    },
  };
};
