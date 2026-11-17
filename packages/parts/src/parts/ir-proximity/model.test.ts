import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("ir-proximity"), "ir-proximity");
const wiring = { VCC: "vcc", OUT: "out", GND: GROUND };

describe("ir-proximity", () => {
  it("OUT is HIGH (its own pull-up) when clear and LOW within the trigger distance", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 5));
    expect(b.result!.voltage("out")).toBeCloseTo(5, 2);
    expect(b.model.visualState().label).toBe("clear");
    expect(b.setProp("distance", 8).voltage("out")).toBeLessThan(0.05);
    expect(b.model.visualState()).toMatchObject({ obstacle: true, label: "obstacle 8 cm" });
    expect(b.setProp("distance", 12).voltage("out")).toBeCloseTo(5, 2);
  });

  it("sees dark objects much later", () => {
    const b = mount(def, { wiring, props: { surface: "black", distance: 5 } });
    b.solve(supply("vcc", 5));
    expect(b.model.visualState().obstacle).toBe(false);
    b.setProp("distance", 1.5);
    expect(b.model.visualState().obstacle).toBe(true);
  });

  it("follows set_sensor_value, press and release", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 3.3));
    expect(b.interact({ kind: "set", key: "distance", value: 4 }).voltage("out")).toBeLessThan(0.05);
    expect(b.interact({ kind: "release" }).voltage("out")).toBeCloseTo(3.3, 2);
    expect(b.interact({ kind: "press" }).voltage("out")).toBeLessThan(0.05);
    b.interact({ kind: "set", key: "obstacle", value: false });
    expect(b.model.visualState().obstacle).toBe(false);
  });

  it("says why OUT never changes without power", () => {
    const b = mount(def, { wiring, props: { distance: 3 } });
    b.solve(supply("vcc", 2));
    expect(b.model.visualState().obstacle).toBe(false);
    expect(b.model.diagnostics!()[0]!.code).toBe("ir-undervoltage");
  });
});
