// 3.3 V LDO (MCP1700-3.3 / AP2112K-3.3) on sim-core's regulator element: regulating, dropout
// (VOUT follows VIN − dropout) and off; the input current is the output current + quiescent.
import type { Diagnostic, ElementId, PartModel, PartModelFactory, RegulatorState } from "@faber/sim-core";
import { round, str } from "../../lib/props.ts";

export interface LdoVariant {
  maxmA: number;
  dropout: number;
  iqA: number;
  minIn: number;
  hasEnable: boolean;
}

/** Datasheet typical figures. */
export const LDO_VARIANTS: Record<string, LdoVariant> = {
  "MCP1700-3.3": { maxmA: 250, dropout: 0.178, iqA: 1.6e-6, minIn: 2.3, hasEnable: false },
  "AP2112K-3.3": { maxmA: 600, dropout: 0.25, iqA: 55e-6, minIn: 2.5, hasEnable: true },
};

export const create: PartModelFactory = (ctx): PartModel => {
  let variant = str(ctx.props.variant, "MCP1700-3.3");
  const v = () => LDO_VARIANTS[variant] ?? LDO_VARIANTS["MCP1700-3.3"]!;
  let el: ElementId | undefined;
  let state: RegulatorState = "off";
  let vin = 0;
  let vout = 0;
  let outA = 0;
  let enabled = true;
  let peakmA = 0;
  let peakW = 0;
  let peakVin = 0;
  let sawDropout = false;
  return {
    stamp(c) {
      if (!enabled || !c.regulator) {
        el = undefined;
        return;
      }
      el = c.regulator(ctx.node("VIN"), ctx.node("VOUT"), { volts: 3.3, dropout: v().dropout, iq: v().iqA, minIn: v().minIn, rOut: 0.05 }, { id: "reg" });
    },
    onSolved(r) {
      vin = r.voltage(ctx.node("VIN"));
      vout = r.voltage(ctx.node("VOUT"));
      state = el ? (r.regulatorState?.(el) ?? "off") : "off";
      outA = el ? Math.max(0, r.current(el)) : 0;
      peakmA = Math.max(peakmA, outA * 1000);
      peakW = Math.max(peakW, Math.max(0, vin - vout) * outA);
      peakVin = Math.max(peakVin, vin);
      if (state === "tracking" && outA > 0.0005) sawDropout = true;
      // AP2112 EN: LOW switches it off; unconnected (floating) = on, as on breakouts where EN is tied to VIN.
      const en = ctx.node("EN");
      const want = !v().hasEnable || r.isFloating(en) || r.voltage(en) >= 1.5 || (enabled && r.voltage(en) > 0.4);
      if (want !== enabled) {
        enabled = want;
        ctx.requestSolve();
      }
    },
    visualState() {
      const st = state === "tracking" ? "dropout" : state;
      const on = state !== "off";
      return {
        state: st,
        vin: round(vin, 3),
        vout: round(vout, 3),
        outmA: round(outA * 1000, 2),
        outOn: on ? 1 : 0,
        label: on ? `${vout.toFixed(2)} V · ${Math.round(outA * 1000)} mA` : enabled ? "off" : "EN low",
      };
    },
    setProp(id, val) {
      if (id === "variant") variant = str(val, variant);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      const s = v();
      if (peakVin > 6.2) out.push({ severity: "error", code: "ldo-overvoltage", pin: "VIN", message: `${id} (${variant}) sees ${peakVin.toFixed(1)} V on VIN, above its 6 V maximum. Fix: feed it from 5 V or a 1S LiPo, or use an AMS1117 / a buck converter for higher inputs.` });
      if (peakmA > s.maxmA) out.push({ severity: "warning", code: "ldo-overcurrent", pin: "VOUT", message: `${id} (${variant}) delivers ${peakmA.toFixed(0)} mA, above its ${s.maxmA} mA rating: the real chip current-limits and the 3.3 V rail drops. Fix: ${variant.startsWith("MCP1700") ? "use the AP2112K-3.3 (600 mA, set_part_property variant)" : "use a bigger regulator"} or reduce the load.` });
      if (peakW > 0.3) out.push({ severity: "warning", code: "ldo-heat", pin: "VIN", message: `${id} burns ${peakW.toFixed(2)} W ((VIN − 3.3 V) × current): a small package gets hot and shuts down. Fix: lower the input voltage or use a buck converter.` });
      if (sawDropout) out.push({ severity: "info", code: "ldo-dropout", pin: "VOUT", message: `${id} is in dropout: VIN ${vin.toFixed(2)} V is below 3.3 V + ${s.dropout} V, so VOUT follows it down (${vout.toFixed(2)} V). Normal for a LiPo below about 3.5 V; parts that need a full 3.3 V may misbehave. Fix: shut down in firmware at a cell voltage you choose, or use a buck-boost.` });
      return out;
    },
  };
};
