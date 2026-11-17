import type { PartModel, PartModelFactory } from "@faber/sim-core";
import { truthy } from "../../lib/props.ts";

export const create: PartModelFactory = (ctx): PartModel => {
  let pressed = false;
  return {
    stamp(c) {
      c.switch(ctx.node("1a"), ctx.node("1b"), true, { id: "tie1" });
      c.switch(ctx.node("2a"), ctx.node("2b"), true, { id: "tie2" });
      c.switch(ctx.node("1a"), ctx.node("2a"), pressed, { id: "contact" });
    },
    visualState() {
      return { pressed, capTransform: pressed ? "translate(0 1.5)" : "translate(0 0)" };
    },
    setProp() {},
    interact(e) {
      if (e.kind === "press") pressed = true;
      else if (e.kind === "release") pressed = false;
      else if (e.kind === "set") pressed = truthy(e.value);
    },
  };
};
