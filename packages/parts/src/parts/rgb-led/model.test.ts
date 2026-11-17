import { describe, expect, it } from "vitest";
import { GPIO_R_OUT, GROUND, type CircuitBuilder } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("rgb-led"), "rgb-led");

/** Each channel: GPIO (25 Ω) at `levels[ch]` volts → 220 Ω → anode. COM to GND. */
function rig(levels: { R: number; G: number; B: number }, series = 220) {
  const b = mount(def, { wiring: { R: "r", G: "g", B: "b", COM: GROUND } });
  b.solve((c: CircuitBuilder) => {
    for (const ch of ["R", "G", "B"] as const) {
      const n = ch.toLowerCase();
      c.voltageSource(`pin_${n}`, GROUND, levels[ch], GPIO_R_OUT);
      c.resistor(`pin_${n}`, n, series);
    }
  });
  return b;
}

describe("rgb-led (common cathode)", () => {
  it("lights only the driven channel", () => {
    const s = rig({ R: 5, G: 0, B: 0 }).model.visualState();
    expect(s.r).toBeGreaterThan(0.6);
    expect(s.g).toBe(0);
    expect(s.b).toBe(0);
    expect(s.color).toBe("#FF0000");
  });

  it("green and blue drop more voltage than red, so they carry less current at 5 V / 220 Ω", () => {
    const red = rig({ R: 5, G: 0, B: 0 }).result!.voltage("r");
    const blue = rig({ R: 0, G: 0, B: 5 }).result!.voltage("b");
    expect(red).toBeGreaterThan(2.0);
    expect(red).toBeLessThan(2.2);
    expect(blue).toBeGreaterThan(2.9);
    expect(blue).toBeLessThan(3.2);
  });

  it("mixes all three to a near-white", () => {
    const s = rig({ R: 5, G: 5, B: 5 }).model.visualState();
    expect(s.on).toBe(true);
    expect(s.color).toMatch(/^#FF[C-F][0-9A-F][C-F][0-9A-F]$/);
  });

  it("is dark with all channels LOW", () => {
    expect(rig({ R: 0, G: 0, B: 0 }).model.visualState()).toMatchObject({ on: false, brightness: 0, color: "#000000" });
  });

  it("flags a channel with no resistor", () => {
    const d = rig({ R: 5, G: 0, B: 0 }, 0.1).model.diagnostics!();
    expect(d).toMatchObject([{ severity: "error", code: "led-overcurrent", pin: "R" }]);
    expect(d[0]!.message).toMatch(/LED will burn out, add a resistor/);
  });
});
