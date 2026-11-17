// AO3400 logic-level N-MOSFET: the D-S channel is a resistance chosen from the gate voltage of the
// last solve (re-solved when it changes step), plus the body diode S → D.
import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@faber/sim-core";
import { round } from "../../lib/props.ts";

/** Rds(on) steps vs Vgs (AO3400A typical curves): below the first threshold the channel is off. */
export const RDS_STEPS: readonly (readonly [number, number])[] = [
  [4.5, 0.028],
  [2.5, 0.04],
  [1.5, 0.1],
  [1.0, 5],
];

export function rdsFor(vgs: number): number | undefined {
  for (const [v, r] of RDS_STEPS) if (vgs >= v) return r;
  return undefined;
}

export const create: PartModelFactory = (ctx): PartModel => {
  const maxmA = ctx.spec.limits?.maxCurrentmA ?? 5700;
  const maxW = ctx.spec.limits?.maxPowerW ?? 1.4;
  let vgs = 0;
  let rds: number | undefined;
  let ch: ElementId | undefined;
  let mA = 0;
  let floating = false;
  let peakW = 0;
  let peakmA = 0;
  let peakVgs = 0;
  let peakVds = 0;
  let halfOn = false;
  return {
    stamp(c) {
      ch = rds === undefined ? undefined : c.resistor(ctx.node("D"), ctx.node("S"), rds, { id: "channel" });
      c.diode(ctx.node("S"), ctx.node("D"), { vf: 0.7, rOn: 0.05 }, { id: "body" });
      // The gate is a capacitor at DC: put its node in the circuit (so a gate nothing drives reads as floating) without a path anywhere.
      c.resistor(ctx.node("G"), ctx.internalNode("gate"), 1e9, { id: "gate" });
    },
    onSolved(r) {
      const g = ctx.node("G");
      floating = r.isFloating(g);
      vgs = floating ? 0 : r.voltage(g) - r.voltage(ctx.node("S"));
      mA = ch ? r.current(ch) * 1000 : 0;
      const vds = r.voltage(ctx.node("D")) - r.voltage(ctx.node("S"));
      peakmA = Math.max(peakmA, Math.abs(mA));
      peakW = Math.max(peakW, (mA / 1000) ** 2 * (rds ?? 0));
      peakVgs = Math.max(peakVgs, Math.abs(vgs));
      peakVds = Math.max(peakVds, vds);
      if (rds !== undefined && rds >= 0.1 && Math.abs(mA) > 100) halfOn = true;
      const next = rdsFor(vgs);
      if (next !== rds) {
        rds = next;
        ctx.requestSolve();
      }
    },
    visualState() {
      const on = rds !== undefined;
      return { on, vgs: round(vgs, 3), rdsOhms: on ? rds! : 0, currentmA: round(mA, 2), label: "AO3400", glow: on ? 0.35 : 0 };
    },
    setProp() {},
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (floating) out.push({ severity: "warning", code: "mosfet-gate-floating", pin: "G", message: `${id}.G is not driven by anything: a real MOSFET gate floats and switches on and off by itself (the simulator reads it as off). Fix: wire G to a GPIO through ~100 Ω and add a 100 kΩ resistor from G to S.` });
      if (peakVgs > (ctx.spec.limits?.maxGateVoltage ?? 12)) out.push({ severity: "error", code: "mosfet-gate-overvoltage", pin: "G", message: `${id} saw ${peakVgs.toFixed(1)} V gate to source, above the AO3400's ±12 V: the gate oxide breaks. Fix: drive the gate from a 3.3 / 5 V GPIO, not the battery or motor supply.` });
      if (peakVds > (ctx.spec.limits?.maxVoltage ?? 30)) out.push({ severity: "error", code: "mosfet-overvoltage", pin: "D", message: `${id} blocks ${peakVds.toFixed(1)} V drain to source, above its 30 V rating. Fix: use a higher-voltage MOSFET.` });
      if (peakmA > maxmA) out.push({ severity: "warning", code: "mosfet-overcurrent", pin: "D", message: `${id} carried ${(peakmA / 1000).toFixed(2)} A, above its ${(maxmA / 1000).toFixed(1)} A rating. Fix: use a bigger MOSFET or split the load.` });
      if (peakW > maxW) out.push({ severity: "warning", code: "mosfet-heat", pin: "D", message: `${id} dissipates ${peakW.toFixed(2)} W (I² × Rds), more than a SOT-23 on a small board gets rid of (${maxW} W). Fix: drive the gate harder (≥ 4.5 V) or use a TO-220 MOSFET.` });
      if (halfOn) out.push({ severity: "warning", code: "mosfet-half-on", pin: "G", message: `${id} carries over 100 mA with only ${vgs.toFixed(2)} V on its gate, so it is not fully on and heats up. Fix: drive G with at least 2.5 V (a 3.3 V GPIO is fine; check there is no divider on the gate).` });
      return out;
    },
  };
};
