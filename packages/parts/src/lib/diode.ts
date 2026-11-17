// Round 6 (power): shared model for the plain diodes (schottky-diode, generic-diode).
import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@faber/sim-core";
import { round } from "./props.ts";

export interface DiodeModelOptions {
  /** Knee voltage (V) and on resistance (Ω) of the piecewise-linear diode. */
  vf: number;
  rOn: number;
  /** Off resistance (Ω): reverse leakage. */
  rOff?: number;
  /** Plain-words name for messages, e.g. "Schottky diode". */
  what: string;
}

export function createDiodeModel(opts: DiodeModelOptions): PartModelFactory {
  return (ctx): PartModel => {
    const maxmA = ctx.spec.limits?.maxCurrentmA ?? 1000;
    const maxRev = (ctx.spec.limits as Record<string, number> | undefined)?.maxReverseVoltage ?? 20;
    let el: ElementId = "";
    let mA = 0;
    let vd = 0;
    let on = false;
    let peakmA = 0;
    let peakRev = 0;
    return {
      stamp(c) {
        el = c.diode(ctx.node("A"), ctx.node("C"), { vf: opts.vf, rOn: opts.rOn, ...(opts.rOff ? { rOff: opts.rOff } : {}) }, { id: "d" });
      },
      onSolved(r) {
        on = r.isOn(el);
        mA = on ? Math.max(0, r.current(el) * 1000) : 0;
        vd = r.voltage(ctx.node("A")) - r.voltage(ctx.node("C"));
        if (mA > peakmA) peakmA = mA;
        if (-vd > peakRev) peakRev = -vd;
      },
      visualState() {
        return { on, currentmA: round(mA, 2), vf: round(vd, 3), glow: on ? round(Math.min(0.4, 0.1 + mA / 500), 2) : 0 };
      },
      setProp() {},
      diagnostics() {
        const out: Diagnostic[] = [];
        const id = ctx.id;
        if (peakmA > maxmA) out.push({ severity: "warning", code: "diode-overcurrent", message: `${id} (${opts.what}) carried ${peakmA.toFixed(0)} mA, above its ${maxmA} mA rating: it overheats. Fix: use a bigger diode (schottky-diode is 1 A) or reduce the load.` });
        if (peakRev > maxRev) out.push({ severity: "error", code: "diode-reverse-voltage", pin: "C", message: `${id} (${opts.what}) blocks ${peakRev.toFixed(1)} V, above its ${maxRev} V reverse rating: it can break down and conduct backwards. Fix: use a diode rated for the voltage, or check its direction (stripe = C).` });
        return out;
      },
    };
  };
}
