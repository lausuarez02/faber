import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";
import { rdsFor } from "./model.ts";

const def = need(registry.get("n-mosfet"), "n-mosfet");

describe("n-mosfet", () => {
  it("Rds(on) follows the gate voltage (AO3400 typical)", () => {
    expect(rdsFor(0.5)).toBeUndefined();
    expect(rdsFor(1.2)).toBe(5);
    expect(rdsFor(3.3)).toBe(0.04);
    expect(rdsFor(5)).toBe(0.028);
  });

  it("a 3.3 V GPIO switches a 5 V, 500 mA load on the low side", () => {
    const b = mount(def, { id: "q1", wiring: { G: "gate", D: "drain", S: "0" } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("vcc", "drain", 10, { id: "load" });
      c.voltageSource("gate", GROUND, 3.3, 100);
      c.resistor("gate", GROUND, 100_000);
    });
    const s = b.model.visualState();
    expect(s.on).toBe(true);
    expect(Number(s.currentmA)).toBeGreaterThan(490);
    expect(b.result!.voltage("drain")).toBeLessThan(0.05);
    expect(b.model.diagnostics!()).toEqual([]);
  });

  it("is off with the gate at 0 V, and warns about a floating gate", () => {
    const b = mount(def, { id: "q1", wiring: { G: "gate", D: "drain", S: "0" } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("vcc", "drain", 10);
    });
    expect(b.model.visualState().on).toBe(false);
    expect(b.result!.voltage("drain")).toBeCloseTo(5, 1);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("mosfet-gate-floating");
  });
});
