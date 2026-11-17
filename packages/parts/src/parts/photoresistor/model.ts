import type { PartModel, PartModelFactory } from "@faber/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

/** GL5528-class constants (typical): R at 10 lux, slope γ = log10(R10/R100), dark resistance. */
export const LDR_R10 = 15_000;
export const LDR_GAMMA = 0.6;
export const LDR_R_DARK = 1_000_000;

/** Resistance (Ω) of a GL5528-class LDR at an illuminance in lux. */
export function ldrResistance(lux: number): number {
  if (!(lux > 0)) return LDR_R_DARK;
  return Math.min(LDR_R_DARK, LDR_R10 * (lux / 10) ** -LDR_GAMMA);
}

export const create: PartModelFactory = (ctx): PartModel => {
  let lux = Math.max(0, num(ctx.props.lux, 100));
  return {
    stamp(c) {
      c.resistor(ctx.node("1"), ctx.node("2"), ldrResistance(lux), { id: "r" });
    },
    visualState() {
      return {
        lux,
        resistance: Math.round(ldrResistance(lux)),
        light: round(clamp(Math.log10(lux + 1) / 5, 0, 1)),
      };
    },
    setProp(id, v) {
      if (id === "lux") lux = Math.max(0, num(v, lux));
    },
    interact(e) {
      if (e.kind === "set") lux = Math.max(0, num(e.value as number, lux));
    },
  };
};
