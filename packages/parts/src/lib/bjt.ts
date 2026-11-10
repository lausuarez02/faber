// Round 6 (power): NPN / PNP bipolar transistor for switching. Base-emitter is a diode; the
// collector-emitter path is a current source of hFE × Ib (active) or a 0.2 V diode drop when the
// load cannot take that much (saturated). The state comes from the last solve and is re-solved when it
// changes.
import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@jumper/sim-core";
import { round, str } from "./props.ts";

export interface BjtModel {
  hfe: number;
  maxmA: number;
  maxV: number;
}

export function createBjtModel(polarity: "npn" | "pnp", models: Record<string, BjtModel>, dflt: string): PartModelFactory {
  return (ctx): PartModel => {
    let model = str(ctx.props.model, dflt);
    const spec = () => models[model] ?? models[dflt]!;
    let state: "off" | "active" | "sat" = "off";
    let be: ElementId = "";
    let ce: ElementId | undefined;
    let ib = 0;
    let ic = 0;
    let peakmA = 0;
    let peakW = 0;
    let peakIbmA = 0;
    // Node names: current flows B → E (npn) / E → B (pnp), C → E (npn) / E → C (pnp).
    const hi = (a: string, b: string) => (polarity === "npn" ? [ctx.node(a), ctx.node(b)] : [ctx.node(b), ctx.node(a)]) as [string, string];
    return {
      stamp(c) {
        const [ba, bk] = hi("B", "E");
        be = c.diode(ba, bk, { vf: 0.65, rOn: 25 }, { id: "be" });
        const [ca, ck] = hi("C", "E");
        if (state === "active") ce = c.currentSource(ca, ck, spec().hfe * ib, { id: "ce" });
        else if (state === "sat") ce = c.diode(ca, ck, { vf: 0.2, rOn: 0.5 }, { id: "ce" });
        else ce = undefined;
      },
      onSolved(r) {
        ib = Math.max(0, r.current(be));
        ic = ce ? Math.max(0, r.current(ce)) : 0;
        const [ca, ck] = hi("C", "E");
        const vce = r.voltage(ca) - r.voltage(ck);
        let next = state;
        if (ib < 1e-6) next = "off";
        else if (state === "off") next = "sat";
        else if (state === "sat" && ic > spec().hfe * ib * 1.02) next = "active";
        else if (state === "active" && vce < 0.2) next = "sat";
        peakmA = Math.max(peakmA, ic * 1000);
        peakIbmA = Math.max(peakIbmA, ib * 1000);
        peakW = Math.max(peakW, Math.max(0, vce) * ic);
        if (next !== state) {
          state = next;
          ctx.requestSolve();
        }
      },
      visualState() {
        const on = state !== "off";
        return { on, saturated: state === "sat", ibmA: round(ib * 1000, 3), icmA: round(ic * 1000, 2), label: model, glow: on ? 0.35 : 0 };
      },
      setProp(id, v) {
        if (id === "model") model = str(v, model);
      },
      diagnostics() {
        const out: Diagnostic[] = [];
        const s = spec();
        const id = ctx.id;
        if (peakmA > s.maxmA) out.push({ severity: "warning", code: "bjt-overcurrent", pin: "C", message: `${id} (${model}) carried ${peakmA.toFixed(0)} mA, above its ${s.maxmA} mA rating. Fix: use a 2N2222 / 2N2907 (600 mA) or a MOSFET (n-mosfet) for bigger loads.` });
        if (peakIbmA > 50) out.push({ severity: "error", code: "bjt-no-base-resistor", pin: "B", message: `${id} base takes ${peakIbmA.toFixed(0)} mA: there is no resistor limiting it, which kills the transistor and the GPIO. Fix: put 1 kΩ between the driving pin and ${id}.B.` });
        if (peakW > 0.6) out.push({ severity: "warning", code: "bjt-heat", pin: "C", message: `${id} dissipates ${peakW.toFixed(2)} W: it is not saturated, so it acts as a heater (TO-92 handles about 0.6 W). Fix: more base current (smaller base resistor) so it switches fully on.` });
        return out;
      },
    };
  };
}
