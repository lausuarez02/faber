import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";
import { soilVolts } from "./model.ts";

const def = need(registry.get("capacitive-soil-moisture"), "capacitive-soil-moisture");
const wiring = { VCC: "vcc", AOUT: "a0", GND: GROUND };
/** analogRead on a 5 V AVR. */
const adc = (v: number) => Math.round((v / 5) * 1023);

describe("capacitive-soil-moisture", () => {
  it("reads ~590 in dry air and ~255 in water on a 5 V Uno, falling as it gets wetter", () => {
    const b = mount(def, { wiring, props: { moisture: 0 } });
    b.solve(supply("vcc", 5));
    const dry = adc(b.result!.voltage("a0"));
    expect(dry).toBeGreaterThan(570);
    expect(dry).toBeLessThan(610);
    const wet = adc(b.setProp("moisture", 100).voltage("a0"));
    expect(wet).toBeGreaterThan(240);
    expect(wet).toBeLessThan(270);
    const mid = adc(b.setProp("moisture", 50).voltage("a0"));
    expect(mid).toBeLessThan(dry);
    expect(mid).toBeGreaterThan(wet);
  });

  it("follows set_sensor_value and shows it", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 5));
    b.interact({ kind: "set", value: 75 });
    expect(b.model.visualState()).toMatchObject({ moisture: 75, powered: true });
    expect(String(b.model.visualState().label)).toMatch(/^75 % · 1\.\d\d V$/);
  });

  it("gives a slightly lower voltage at 3.3 V (regulator dropout) and nothing below 3 V", () => {
    expect(soilVolts(3.3, 0)).toBeLessThan(soilVolts(5, 0));
    expect(soilVolts(3.3, 0)).toBeGreaterThan(2.6);
    expect(soilVolts(2.5, 0)).toBe(0);
  });

  it("is loaded by its 10 kΩ output resistance", () => {
    const b = mount(def, { wiring, props: { moisture: 0 } });
    b.solve((c) => {
      supply("vcc", 5)(c);
      c.resistor("a0", GROUND, 10_000);
    });
    expect(b.result!.voltage("a0")).toBeCloseTo(soilVolts(5, 0) / 2, 2);
  });

  it("explains an undervoltage supply", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 2));
    expect(b.model.diagnostics!()[0]!.code).toBe("soil-undervoltage");
    expect(b.result!.voltage("a0")).toBeLessThan(0.01);
  });
});
