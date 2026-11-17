import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { ldrResistance } from "./model.ts";

const def = need(registry.get("photoresistor"), "photoresistor");

describe("photoresistor (GL5528)", () => {
  it("matches the datasheet resistance ranges", () => {
    // GL5528: 10–20 kΩ at 10 lx, ≥ 1 MΩ dark, a few hundred Ω to ~1 kΩ at 1000 lx.
    const r10 = ldrResistance(10);
    const r1000 = ldrResistance(1000);
    expect(r10).toBeGreaterThanOrEqual(10_000);
    expect(r10).toBeLessThanOrEqual(20_000);
    expect(r1000).toBeGreaterThan(300);
    expect(r1000).toBeLessThan(1_500);
    expect(r10 / r1000).toBeGreaterThan(10); // more than a decade apart
    expect(ldrResistance(0)).toBe(1_000_000);
    // γ = log10(R10 / R100) ≈ 0.6
    expect(Math.log10(ldrResistance(10) / ldrResistance(100))).toBeCloseTo(0.6, 3);
  });

  it("is monotonic: more light, less resistance", () => {
    let prev = Infinity;
    for (const lux of [0, 0.1, 1, 10, 100, 1000, 10_000, 100_000]) {
      const r = ldrResistance(lux);
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
  });

  it("drives an analog divider: brighter → higher voltage on A0 (LDR on top, 10 kΩ to GND)", () => {
    const b = mount(def, { props: { lux: 10 }, wiring: { "1": "vcc", "2": "a0" } });
    b.solve((c) => {
      c.voltageSource("vcc", GROUND, 5, 0.01);
      c.resistor("a0", GROUND, 10_000);
    });
    const dim = b.result!.voltage("a0");
    expect(dim).toBeCloseTo(5 * 10_000 / (10_000 + 15_000), 2); // 2.0 V
    const bright = b.setProp("lux", 1000).voltage("a0");
    expect(bright).toBeGreaterThan(4.5);
    const dark = b.interact({ kind: "set", value: 0 }).voltage("a0");
    expect(dark).toBeLessThan(0.06);
    expect(b.model.visualState()).toMatchObject({ lux: 0, resistance: 1_000_000, light: 0 });
  });
});
