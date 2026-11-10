// Lever micro switch (KW12-3 class): COM–NO closed while pressed, COM–NC closed while free.
// Pressed by press / release / set, or by the robot physics (interact set key "pressed").
import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import { truthy } from "../../lib/props.ts";

export const create: PartModelFactory = (ctx): PartModel => {
  let pressed = false;
  return {
    stamp(c) {
      c.switch(ctx.node("COM"), ctx.node("NO"), pressed, { id: "no" });
      c.switch(ctx.node("COM"), ctx.node("NC"), !pressed, { id: "nc" });
    },
    visualState() {
      return {
        pressed,
        contact: pressed ? "NO" : "NC",
        leverTransform: pressed ? "rotate(9 18 30)" : "rotate(0 18 30)",
      };
    },
    setProp() {},
    interact(e) {
      if (e.kind === "press") pressed = true;
      else if (e.kind === "release") pressed = false;
      else if (e.kind === "set" && (e.key === undefined || e.key === "pressed")) pressed = truthy(e.value);
    },
  };
};
