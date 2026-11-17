import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("speaker-15mm"), "speaker-15mm");

describe("speaker-15mm", () => {
  it("is a real 15 mm part: smaller than the 28 mm speaker in every direction", () => {
    const big = need(registry.get("speaker"), "speaker").spec.dimensions_mm!;
    const d = def.spec.dimensions_mm!;
    expect(d.w).toBe(15);
    expect(d.w).toBeLessThan(big.w);
    expect(d.d).toBeLessThan(big.d);
    expect(def.spec.mechanical?.features?.find((f) => f.kind === "grille")?.d).toBe(10);
    expect(def.spec.limits?.maxPowerW).toBe(0.25);
  });

  it("1 V RMS into 8 Ω: 125 mA, sounding", () => {
    const b = mount(def, { wiring: { "+": "a", "-": "b" } });
    b.solve((c) => c.voltageSource("a", "b", 1, 0));
    const s = b.model.visualState();
    expect(s.sounding).toBe(true);
    expect(s.currentmA).toBeCloseTo(125, 0);
  });

  it("overpower is judged against its own 0.25 W rating", () => {
    const b = mount(def, { wiring: { "+": "a", "-": "b" } });
    b.solve((c) => c.voltageSource("a", "b", 2.6, 0)); // about 0.85 W
    const d = b.model.diagnostics?.() ?? [];
    expect(d[0]).toMatchObject({ code: "speaker-overpower" });
    expect(d[0]!.message).toMatch(/rated 0.25 W.*Why:.*Fix:/);
  });

  it("silent with nothing driving it", () => {
    const b = mount(def, { wiring: { "+": "a", "-": GROUND } });
    b.solve();
    expect(b.model.visualState().sounding).toBe(false);
  });
});
