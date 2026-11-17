import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("speaker"), "speaker");

describe("speaker", () => {
  it("2 V RMS from a 0.5 Ω amplifier into 8 Ω: 235 mA, 0.44 W, sounding", () => {
    const b = mount(def, { wiring: { "+": "a", "-": "b" } });
    b.solve((c) => c.voltageSource("a", "b", 2, 0.5));
    const s = b.model.visualState();
    expect(s.sounding).toBe(true);
    expect(s.currentmA).toBeCloseTo(235.3, 0);
    expect(s.powerW).toBeCloseTo(0.443, 2);
    expect(Number(s.volume)).toBeGreaterThan(0.9);
    expect(b.model.diagnostics?.()).toEqual([]);
  });

  it("silent with nothing driving it", () => {
    const b = mount(def, { wiring: { "+": "a", "-": GROUND } });
    b.solve();
    expect(b.model.visualState().sounding).toBe(false);
  });

  it("straight on 5 V: 3 W into a 0.5 W speaker is an error with a fix", () => {
    const b = mount(def, { wiring: { "+": "a", "-": GROUND } });
    b.solve((c) => c.voltageSource("a", GROUND, 5, 0.01));
    const d = b.model.diagnostics?.() ?? [];
    expect(d[0]).toMatchObject({ severity: "error", code: "speaker-overpower" });
    expect(d[0]!.message).toMatch(/Why:.*Fix:/);
  });

  it("4 Ω draws twice the current", () => {
    const b = mount(def, { props: { ohms: "4" }, wiring: { "+": "a", "-": "b" } });
    b.solve((c) => c.voltageSource("a", "b", 1, 0));
    expect(b.model.visualState().currentmA).toBeCloseTo(250, 0);
  });
});
