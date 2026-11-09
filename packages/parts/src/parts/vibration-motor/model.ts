// Coin ERM vibration motor on a driver board: IN → 1 kΩ → NPN base, motor from VCC to the
// collector, flyback diode across it. The motor is the dc-motor model (lib/innerMotor.ts) with the
// constants of a 3 V 1027 coin motor (12 000 rpm, 75 mA running).
import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@jumper/sim-core";
import { GROUND } from "@jumper/sim-core";
import { innerMotor } from "../../lib/innerMotor.ts";
import { clamp, round } from "../../lib/props.ts";

export const RATED_RPM = 12_000;
/** Base current that saturates the transistor for the motor current (β ≈ 100). */
const ON_BASE_MA = 0.3;
/** Collector–emitter path when saturated (≈ 0.15 V at 75 mA). */
const VCE_SAT_OHMS = 2;

export const create: PartModelFactory = (ctx): PartModel => {
  const collector = ctx.internalNode("c");
  const motor = innerMotor(
    ctx,
    { a: ctx.node("VCC"), b: collector },
    { ratedVoltage: 3, noLoadRpm: RATED_RPM, stallCurrent: 0.12, noLoadCurrent: 0.075, timeConstantMs: 40 },
    { b: "IN" },
  );
  let on = false;
  let baseEl: ElementId = "";
  let vcc = 0;
  let ticks = 0;

  /** PWM on IN (analogWrite): the transistor chops the motor at that duty. */
  const pwmOn = () => {
    const p = ctx.pwm?.("IN");
    return !!p && p.averaged && p.duty > 0.004;
  };

  return {
    stamp(c) {
      const b = ctx.internalNode("b");
      c.resistor(ctx.node("IN"), b, 1000, { id: "base-r" });
      baseEl = c.diode(b, GROUND, { vf: 0.7, rOn: 20 }, { id: "base" });
      if (on || pwmOn()) c.resistor(collector, GROUND, VCE_SAT_OHMS, { id: "ce" });
      motor.model.stamp(c);
    },
    onSolved(r, t) {
      vcc = r.voltage(ctx.node("VCC"));
      motor.model.onSolved?.(r, t);
      const next = r.current(baseEl) * 1000 > ON_BASE_MA;
      if (next !== on) {
        on = next;
        ctx.requestSolve();
      }
    },
    tick(tMs, dtMs) {
      ticks++;
      motor.model.tick?.(tMs, dtMs);
    },
    visualState() {
      const rpm = Math.max(0, motor.rpm());
      const running = rpm > 200;
      const j = running ? (ticks % 2 === 0 ? 0.8 : -0.8) : 0;
      return {
        running,
        strength: round(clamp(rpm / RATED_RPM, 0, 2), 3),
        rpm: round(rpm, 0),
        currentmA: round(Math.max(0, motor.currentA()) * 1000, 1),
        shakeTransform: `translate(${j} ${-j / 2})`,
      };
    },
    setProp() {},
    diagnostics() {
      const out: Diagnostic[] = [];
      if (vcc > 5.6) out.push({ severity: "warning", code: "vibration-overvoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V; its 3 V coin motor wears out fast above 5 V. Wire VCC to 3V3 or 5V.` });
      if ((on || pwmOn()) && vcc < 1.5) out.push({ severity: "info", code: "vibration-unpowered", pin: "VCC", message: `${ctx.id} is switched on but VCC is ${vcc.toFixed(1)} V, so it does not vibrate. Wire VCC to 3V3 or 5V and GND to GND.` });
      return out;
    },
  };
};
