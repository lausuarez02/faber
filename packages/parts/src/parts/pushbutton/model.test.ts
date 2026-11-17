import { describe, expect, it } from "vitest";
import { GROUND, PULLUP_OHMS, type CircuitBuilder } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("pushbutton"), "pushbutton");

describe("pushbutton", () => {
  // Classic wiring: D2 with INPUT_PULLUP (35 kΩ to 5 V) on leg 1a, GND on the diagonal leg 2b.
  const pullup = (c: CircuitBuilder) =>
    void c.voltageSource("d2", GROUND, 5, PULLUP_OHMS);

  it("reads HIGH released and LOW pressed with a pull-up", () => {
    const b = mount(def, { wiring: { "1a": "d2", "2b": GROUND } });
    expect(b.solve(pullup).voltage("d2")).toBeCloseTo(5, 3);
    expect(b.interact({ kind: "press" }).voltage("d2")).toBeLessThan(0.01);
    expect(b.model.visualState()).toEqual({ pressed: true, capTransform: "translate(0 1.5)" });
    expect(b.interact({ kind: "release" }).voltage("d2")).toBeCloseTo(5, 3);
    expect(b.model.visualState().pressed).toBe(false);
  });

  it("ties 1a–1b and 2a–2b even when released", () => {
    const b = mount(def, { wiring: { "1a": "x", "1b": "y" } });
    const r = b.solve((c) => {
      c.voltageSource("x", GROUND, 3.3, 0.01);
      c.resistor("y", GROUND, 1000);
    });
    expect(r.voltage("y")).toBeCloseTo(3.3, 2);
  });

  it("supports 'set' interactions", () => {
    const b = mount(def);
    b.interact({ kind: "set", value: true });
    expect(b.model.visualState().pressed).toBe(true);
    b.interact({ kind: "set", value: 0 });
    expect(b.model.visualState().pressed).toBe(false);
  });
});
