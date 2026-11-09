import { describe, expect, it } from "vitest";
import { GROUND, PULLUP_OHMS } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("bump-switch"), "bump-switch");

describe("bump-switch", () => {
  it("pulls an INPUT_PULLUP pin LOW on NO while pressed and releases it when free", () => {
    const b = mount(def, { wiring: { COM: GROUND, NO: "d2", NC: "d3" } });
    b.solve((c) => {
      c.voltageSource("d2", GROUND, 5, PULLUP_OHMS);
      c.voltageSource("d3", GROUND, 5, PULLUP_OHMS);
    });
    expect(b.result!.voltage("d2")).toBeCloseTo(5, 3);
    expect(b.result!.voltage("d3")).toBeLessThan(0.01);
    const r = b.interact({ kind: "press" });
    expect(r.voltage("d2")).toBeLessThan(0.01);
    expect(r.voltage("d3")).toBeCloseTo(5, 3);
    expect(b.model.visualState()).toMatchObject({ pressed: true, contact: "NO" });
    expect(b.interact({ kind: "release" }).voltage("d2")).toBeCloseTo(5, 3);
  });

  it("accepts set pressed from the physics", () => {
    const b = mount(def);
    b.solve();
    b.interact({ kind: "set", key: "pressed", value: true });
    expect(b.model.visualState().pressed).toBe(true);
    b.interact({ kind: "set", key: "pressed", value: 0 });
    expect(b.model.visualState().pressed).toBe(false);
  });
});
