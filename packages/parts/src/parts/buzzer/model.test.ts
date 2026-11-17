import { describe, expect, it } from "vitest";
import { GPIO_R_OUT, GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("buzzer"), "buzzer");

describe("buzzer (active, 5 V)", () => {
  it("sounds on a 5 V GPIO and draws ~20–30 mA", () => {
    const b = mount(def, { wiring: { POS: "d8", NEG: GROUND } });
    b.solve((c) => void c.voltageSource("d8", GROUND, 5, GPIO_R_OUT));
    const s = b.model.visualState();
    expect(s.sounding).toBe(true);
    expect(s.currentmA).toBeGreaterThan(18);
    expect(s.currentmA).toBeLessThan(30);
    expect(s.volume).toBeGreaterThan(0.75);
    expect(b.model.diagnostics!()).toEqual([]);
  });

  it("is silent when the pin is LOW", () => {
    const b = mount(def, { wiring: { POS: "d8", NEG: GROUND } });
    b.solve((c) => void c.voltageSource("d8", GROUND, 0, GPIO_R_OUT));
    expect(b.model.visualState()).toMatchObject({ sounding: false, volume: 0 });
  });

  it("is silent below 3 V and says why", () => {
    const b = mount(def, { wiring: { POS: "v", NEG: GROUND } });
    b.solve(supply("v", 2.5));
    expect(b.model.visualState().sounding).toBe(false);
    expect(b.model.diagnostics!()).toMatchObject([{ code: "buzzer-undervoltage" }]);
  });

  it("stays silent and warns when reversed", () => {
    const b = mount(def, { wiring: { POS: GROUND, NEG: "v" } });
    b.solve(supply("v", 5));
    expect(b.model.visualState().sounding).toBe(false);
    expect(b.model.visualState().currentmA).toBe(0);
    expect(b.model.diagnostics!()).toMatchObject([{ code: "buzzer-reversed", severity: "warning" }]);
  });
});
