import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import type { PropValue } from "@jumper/project-format";
import { num, truthy } from "../../lib/props.ts";

const toPos = (v: PropValue | undefined, fallback: 0 | 1): 0 | 1 =>
  typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? (v >= 0.5 ? 1 : 0) : v === undefined ? fallback : truthy(v) ? 1 : num(v, fallback) >= 0.5 ? 1 : 0;

export const create: PartModelFactory = (ctx): PartModel => {
  let position = toPos(ctx.props.position, 0);
  return {
    stamp(c) {
      c.switch(ctx.node("2"), ctx.node("1"), position === 0, { id: "throw1" });
      c.switch(ctx.node("2"), ctx.node("3"), position === 1, { id: "throw3" });
    },
    visualState() {
      return { position, knobTransform: position ? "translate(16 0)" : "translate(0 0)" };
    },
    setProp(id, v) {
      if (id === "position") position = toPos(v, position);
    },
    interact(e) {
      if (e.kind === "press") position = position ? 0 : 1;
      else if (e.kind === "set") position = toPos(e.value, position);
    },
  };
};
