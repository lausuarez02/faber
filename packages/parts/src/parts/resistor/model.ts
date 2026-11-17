import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@faber/sim-core";
import { formatOhms, resistorBands } from "../../lib/resistorBands.ts";
import { num, round } from "../../lib/props.ts";

/** Smallest resistance the model will stamp (keeps the MNA matrix well conditioned). */
export const MIN_OHMS = 0.1;

export const create: PartModelFactory = (ctx): PartModel => {
  const maxW = ctx.spec.limits?.maxPowerW ?? 0.25;
  const read = () => Math.max(MIN_OHMS, num(ctx.props.resistance ?? ctx.props.ohms, 220));
  let ohms = read();
  let el: ElementId = "";
  let amps = 0;

  return {
    stamp(c) {
      el = c.resistor(ctx.node("1"), ctx.node("2"), ohms, { id: "r" });
    },
    onSolved(r) {
      amps = r.current(el);
    },
    visualState() {
      const [band1, band2, band3] = resistorBands(ohms);
      return {
        resistance: ohms,
        label: formatOhms(ohms),
        band1,
        band2,
        band3,
        currentmA: round(amps * 1000),
        powerW: round(amps * amps * ohms, 4),
      };
    },
    setProp(id, v) {
      // "ohms" is accepted as an alias of "resistance".
      if (id === "resistance" || id === "ohms") ohms = Math.max(MIN_OHMS, num(v, ohms));
    },
    diagnostics() {
      const w = amps * amps * ohms;
      if (w <= maxW) return [];
      const d: Diagnostic = {
        severity: w > 2 * maxW ? "error" : "warning",
        code: "resistor-overpower",
        message: `Resistor dissipates ${w.toFixed(2)} W but is rated ${maxW} W, so it will overheat. Use a larger resistance or a higher-wattage resistor.`,
      };
      return [d];
    },
  };
};
