import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("npn-transistor"), "npn-transistor");

describe("npn-transistor", () => {
  it("saturates as a low-side switch: GPIO → 1 kΩ → B, 100 Ω LED-ish load", () => {
    const b = mount(def, { id: "q1", wiring: { B: "base", C: "col", E: "0" } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("vcc", "col", 100);
      supply("gpio", 5)(c);
      c.resistor("gpio", "base", 1000);
    });
    const s = b.model.visualState();
    expect(s.on).toBe(true);
    expect(s.saturated).toBe(true);
    expect(b.result!.voltage("col")).toBeLessThan(0.3);
    expect(Number(s.icmA)).toBeGreaterThan(45);
  });

  it("limits the collector to hFE × Ib when the base current is small", () => {
    const b = mount(def, { id: "q1", wiring: { B: "base", C: "col", E: "0" } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("vcc", "col", 10);
      supply("gpio", 5)(c);
      c.resistor("gpio", "base", 1_000_000); // ~4.3 µA → 0.65 mA at hFE 150
    });
    const s = b.model.visualState();
    expect(s.saturated).toBe(false);
    // Ib = (5 − 0.65) V / 1 MΩ ≈ 4.35 µA → Ic ≈ 150 × 4.35 µA ≈ 0.65 mA
    expect(Number(s.icmA)).toBeCloseTo(0.65, 1);
  });

  it("is off without base current and flags a missing base resistor", () => {
    const b = mount(def, { id: "q1", wiring: { B: "base", C: "col", E: "0" } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("vcc", "col", 100);
    });
    expect(b.model.visualState().on).toBe(false);
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("vcc", "col", 100);
      supply("base", 5)(c);
    });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("bjt-no-base-resistor");
  });
});
