import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("generic-diode"), "generic-diode");

describe("generic-diode", () => {
  it("drops about 0.65 V at 10 mA (1N4148) and blocks reverse", () => {
    const b = mount(def, { id: "d1", wiring: { A: "a", C: "k" } });
    b.solve((c) => {
      supply("a", 5)(c);
      c.resistor("k", GROUND, 435);
    });
    const s = b.model.visualState();
    expect(Number(s.currentmA)).toBeCloseTo(10, 0);
    expect(Number(s.vf)).toBeGreaterThan(0.6);
    expect(Number(s.vf)).toBeLessThan(0.75);
    b.solve((c) => {
      supply("k", 5)(c);
      c.resistor("a", GROUND, 435);
    });
    expect(b.model.visualState().on).toBe(false);
    expect(Number(b.model.visualState().currentmA)).toBe(0);
  });
});
