// Reed switch (normally open): closes when the magnet's field at the switch exceeds pull-in, opens
// below drop-out (hysteresis). The magnet is the part's magnet_* props; press / release (or
// set {key: "magnet", value: "near" | "away" | mm}) moves it, as a lid with a magnet does.
import type { PartModel, PartModelFactory } from "@faber/sim-core";
import { MAGNET_GRADES, distanceForField, magnetInteraction, magnetOf } from "../../lib/magnet.ts";
import { num, round } from "../../lib/props.ts";

export const create: PartModelFactory = (ctx): PartModel => {
  const props: Record<string, unknown> = { ...ctx.props };
  let closed = false;
  let operations = 0;
  const update = () => {
    const m = magnetOf(props as never);
    const pull = num(props.pull_in_mT as never, 4);
    const drop = pull * num(props.drop_out_ratio as never, 0.6);
    const was = closed;
    closed = closed ? m.mT >= drop : m.mT >= pull;
    if (closed && !was) operations++;
    if (closed !== was) ctx.requestSolve();
  };
  update();
  return {
    stamp(c) {
      c.switch(ctx.node("1"), ctx.node("2"), closed, { id: "contacts" });
    },
    visualState() {
      const m = magnetOf(props as never);
      const pull = num(props.pull_in_mT as never, 4);
      return { closed, field_mT: round(m.mT, 2), magnet_mm: m.distance, closes_at_mm: round(distanceForField(pull, m.d, m.t, MAGNET_GRADES[m.grade] ?? 1.19), 1), operations, contactOpacity: closed ? 1 : 0 };
    },
    setProp(id, value) {
      props[id] = value;
      update();
    },
    interact(e) {
      const mm = magnetInteraction(e, 2, 40);
      if (mm === undefined) return;
      props.magnet_mm = mm;
      update();
    },
  };
};
