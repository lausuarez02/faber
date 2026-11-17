// Mini submersible pump: a brushed DC motor (the dc-motor model, see lib/innerMotor.ts) driving an
// impeller. Flow rises with speed above a threshold (the pump must overcome its own head) and is
// integrated into pumped millilitres, so a watering scenario can check how much water went out.
import type { Diagnostic, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { innerMotor, type InnerMotorParams } from "../../lib/innerMotor.ts";
import { clamp, num, round } from "../../lib/props.ts";

/** Impeller no-load speed at the rated voltage (not exposed; only ratios matter). */
const IMPELLER_RPM = 6000;
/** Below this fraction of the rated speed no water comes out. */
export const FLOW_THRESHOLD = 0.2;

export const create: PartModelFactory = (ctx): PartModel => {
  const read = () => ({
    ratedVoltage: num(ctx.props.ratedVoltage, 5),
    flowLph: num(ctx.props.flowLph, 120),
    ratedCurrent: num(ctx.props.ratedCurrent, 0.18),
  });
  let p = read();
  const params = (): InnerMotorParams => ({
    ratedVoltage: p.ratedVoltage,
    noLoadRpm: IMPELLER_RPM,
    stallCurrent: p.ratedCurrent * 4,
    noLoadCurrent: p.ratedCurrent,
    timeConstantMs: 80,
  });
  const motor = innerMotor(ctx, { a: ctx.node("POS"), b: ctx.node("NEG") }, params(), { a: "POS", b: "NEG" });
  let pumpedMl = 0;
  let lastT: number | undefined;

  /** Flow in L/h at the current impeller speed (0 when reversed or too slow). */
  const flow = () => {
    const s = motor.rpm() / IMPELLER_RPM;
    if (s <= FLOW_THRESHOLD) return 0;
    return p.flowLph * clamp((s - FLOW_THRESHOLD) / (1 - FLOW_THRESHOLD), 0, 1.5);
  };
  const directGpio = () => {
    const a = ctx.pwm?.("POS");
    const b = ctx.pwm?.("NEG");
    return a?.source.startsWith("mcu:") ? a.source.slice(4) : b?.source.startsWith("mcu:") ? b.source.slice(4) : undefined;
  };

  return {
    stamp(c) {
      motor.model.stamp(c);
    },
    onSolved(r, t) {
      motor.model.onSolved?.(r, t);
    },
    tick(tMs, dtMs) {
      motor.model.tick?.(tMs, dtMs);
      const dt = (lastT === undefined ? dtMs : Math.max(0, tMs - lastT)) / 1000;
      lastT = tMs;
      pumpedMl += (flow() / 3600) * 1000 * dt;
    },
    visualState() {
      const f = flow();
      return {
        running: f > 0.5,
        flowLph: round(f, 1),
        pumpedMl: round(pumpedMl, 1),
        currentmA: round(motor.currentA() * 1000, 1),
        volts: round(motor.volts(), 3),
        rpm: round(motor.rpm(), 0),
        label: `${Math.round(f)} L/h · ${Math.round(pumpedMl)} ml`,
        waterOpacity: round(clamp(f / p.flowLph, 0, 1), 2),
      };
    },
    setProp() {
      p = read();
      motor.update(params());
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      const v = motor.volts();
      const gpio = directGpio();
      if (gpio && Math.abs(motor.currentA()) > 0.04) {
        out.push({
          severity: "error",
          code: "pump-on-gpio",
          pin: "POS",
          message: `${id} is powered straight from the Arduino pin ${gpio}: a pump draws ${Math.round(p.ratedCurrent * 1000)} mA (more when starting), a pin gives 20 mA (40 mA absolute max), and its voltage spikes can kill the pin. Switch it with a relay module (COM/NO between 5V and ${id}.POS, ${gpio} → relay IN), a logic-level MOSFET or an L298N output.`,
        });
      }
      if (v < -0.5 && Math.abs(motor.rpm()) > 1) {
        out.push({ severity: "warning", code: "pump-reversed", pin: "POS", message: `${id} is wired backwards (${v.toFixed(1)} V across it): the impeller spins the wrong way and almost no water comes out. Swap the wires: red (+) to the switched supply, black (−) to GND.` });
      }
      if (v > (ctx.spec.limits?.maxVoltage ?? 6.5)) {
        out.push({ severity: "warning", code: "pump-overvoltage", message: `${id} gets ${v.toFixed(1)} V; it is a ${p.ratedVoltage} V pump (6.5 V max). It overheats and wears out. Power it from 5 V.` });
      }
      if (v > 0.5 && v < 2.5 && motor.rpm() / IMPELLER_RPM < FLOW_THRESHOLD) {
        out.push({ severity: "info", code: "pump-no-flow", message: `${id} gets only ${v.toFixed(1)} V: the impeller turns too slowly to push water out (it needs about 2.5 V or a higher PWM duty).` });
      }
      return out;
    },
  };
};
