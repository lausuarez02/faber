import type { PartModel, PartModelFactory } from "@faber/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

/** Wiper contact resistance (Ω); also keeps the ends finite at position 0 / 1. */
export const WIPER_OHMS = 0.5;

export const create: PartModelFactory = (ctx): PartModel => {
  let position = clamp(num(ctx.props.position, 0.5), 0, 1);
  let total = Math.max(1, num(ctx.props.resistance, 10_000));

  return {
    stamp(c) {
      const w = ctx.node("W");
      c.resistor(ctx.node("1"), w, total * position + WIPER_OHMS, { id: "lower" });
      c.resistor(w, ctx.node("2"), total * (1 - position) + WIPER_OHMS, { id: "upper" });
    },
    visualState() {
      const knobAngle = round(-135 + 270 * position, 1);
      return { position: round(position), knobAngle, knobTransform: `rotate(${knobAngle} 40 38)` };
    },
    setProp(id, v) {
      if (id === "position") position = clamp(num(v, position), 0, 1);
      if (id === "resistance") total = Math.max(1, num(v, total));
    },
    interact(e) {
      if (e.kind === "set") position = clamp(num(e.value as number, position), 0, 1);
    },
  };
};
