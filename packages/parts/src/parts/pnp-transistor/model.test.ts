import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("pnp-transistor"), "pnp-transistor");

describe("pnp-transistor", () => {
  it("high-side switch: base pulled LOW through 1 kΩ turns the load on", () => {
    const b = mount(def, { id: "q1", wiring: { E: "vcc", B: "base", C: "col" } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("col", GROUND, 100);
      supply("gpio", 0)(c);
      c.resistor("gpio", "base", 1000);
    });
    const s = b.model.visualState();
    expect(s.on).toBe(true);
    expect(s.saturated).toBe(true);
    expect(b.result!.voltage("col")).toBeGreaterThan(4.7);
  });

  it("is off with the base at the emitter voltage", () => {
    const b = mount(def, { id: "q1", wiring: { E: "vcc", B: "base", C: "col" } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("col", GROUND, 100);
      supply("gpio", 5)(c);
      c.resistor("gpio", "base", 1000);
    });
    expect(b.model.visualState().on).toBe(false);
    expect(b.result!.voltage("col")).toBeLessThan(0.01);
  });
});
