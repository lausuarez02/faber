// MT3608 boost module on sim-core's regulator element (switching): VOUT = vout while VIN is between
// 2 V and vout; the input current is vout × Iout / (efficiency × VIN) + no-load current.
import type { Diagnostic, ElementId, PartModel, PartModelFactory, RegulatorState } from "@fabwright/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

export const create: PartModelFactory = (ctx): PartModel => {
  const lim = (ctx.spec.limits ?? {}) as Record<string, number>;
  const eff = lim.efficiency ?? 0.88;
  const noLoadA = (lim.noLoadmA ?? 1) / 1000;
  const minIn = lim.minVoltage ?? 2;
  let vset = clamp(num(ctx.props.vout, 5), 1, 28);
  let el: ElementId | undefined;
  let state: RegulatorState = "off";
  let vin = 0;
  let vout = 0;
  let inA = 0;
  let outA = 0;
  let peakInA = 0;
  let peakVin = 0;
  return {
    stamp(c) {
      if (!c.regulator) return;
      el = c.regulator(ctx.node("VIN+"), ctx.node("VOUT+"), { volts: vset, kind: "switching", efficiency: eff, iq: noLoadA, minIn, dropout: 0.4, rOut: 0.05 }, { id: "reg" });
    },
    onSolved(r) {
      vin = r.voltage(ctx.node("VIN+"));
      vout = r.voltage(ctx.node("VOUT+"));
      state = el ? (r.regulatorState?.(el) ?? "off") : "off";
      outA = el ? Math.max(0, r.current(el)) : 0;
      inA = el ? Math.max(0, r.current(`${el}:in`)) : 0;
      peakInA = Math.max(peakInA, inA);
      peakVin = Math.max(peakVin, vin);
    },
    visualState() {
      const on = state !== "off";
      return {
        state: state === "regulating" ? "boosting" : state === "tracking" ? "pass-through" : "off",
        vin: round(vin, 3),
        vout: round(vout, 3),
        inmA: round(inA * 1000, 2),
        outmA: round(outA * 1000, 2),
        outOn: on ? 1 : 0,
        label: on ? `${vout.toFixed(2)} V · ${Math.round(outA * 1000)} mA` : vin > 0.1 ? `off (${vin.toFixed(1)} V in)` : "off",
      };
    },
    setProp(id, v) {
      if (id === "vout") vset = clamp(num(v, vset), 1, 28);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (peakVin > (lim.maxVoltage ?? 24)) out.push({ severity: "error", code: "boost-overvoltage", pin: "VIN+", message: `${id} sees ${peakVin.toFixed(1)} V on VIN+, above the MT3608's 24 V maximum. Fix: feed it from a lower-voltage battery.` });
      if (peakInA * 1000 > (lim.switchLimitmA ?? 2000)) out.push({ severity: "warning", code: "boost-overcurrent", pin: "VIN+", message: `${id} draws ${(peakInA).toFixed(2)} A from its input, above the MT3608's 2 A switch limit: the real module current-limits and the output sags. Fix: reduce the load on VOUT+ or use a bigger converter.` });
      if (state === "tracking") out.push({ severity: "info", code: "boost-pass-through", pin: "VOUT+", message: `${id}'s input (${vin.toFixed(2)} V) is above its ${vset} V setting, so it does not boost: the output is the input minus about 0.4 V. Fix: raise vout, or use a buck regulator to step down.` });
      if (state === "off" && vin > 0.5) out.push({ severity: "warning", code: "boost-undervoltage", pin: "VIN+", message: `${id} is off: its input ${vin.toFixed(2)} V is below the ${minIn} V it needs to start. Fix: charge or replace the battery.` });
      return out;
    },
  };
};
