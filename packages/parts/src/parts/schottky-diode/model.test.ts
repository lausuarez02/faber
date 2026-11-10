import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("schottky-diode"), "schottky-diode");

describe("schottky-diode", () => {
  it("drops about 0.3 V at 100 mA and about 0.45 V at 1 A (1N5817 datasheet)", () => {
    const b = mount(def, { id: "d1", wiring: { A: "bat", C: "load" } });
    b.solve((c) => {
      supply("bat", 4.0)(c);
      c.resistor("load", GROUND, 37);
    });
    let s = b.model.visualState();
    expect(s.on).toBe(true);
    expect(Number(s.currentmA)).toBeCloseTo(100, -1);
    expect(Number(s.vf)).toBeGreaterThan(0.25);
    expect(Number(s.vf)).toBeLessThan(0.33);
    b.solve((c) => {
      supply("bat", 4.0)(c);
      c.resistor("load", GROUND, 3.55);
    });
    s = b.model.visualState();
    expect(Number(s.currentmA)).toBeGreaterThan(950);
    expect(Number(s.vf)).toBeCloseTo(0.45, 1);
  });

  it("blocks reverse current: USB 5 V on the cathode does not reach a 4 V cell", () => {
    const b = mount(def, { id: "d1", wiring: { A: "bat", C: "vbus" } });
    const r = b.solve((c) => {
      c.voltageSource("bat", GROUND, 4.0, 0.15, { id: "cell" });
      supply("vbus", 5)(c);
    });
    expect(b.model.visualState().on).toBe(false);
    expect(Math.abs(r.current("cell"))).toBeLessThan(1e-6);
    expect(b.model.diagnostics!()).toEqual([]);
  });

  it("warns above 1 A and above 20 V reverse", () => {
    const b = mount(def, { id: "d1", wiring: { A: "a", C: "k" } });
    b.solve((c) => {
      supply("a", 5)(c);
      c.resistor("k", GROUND, 2);
    });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("diode-overcurrent");
    b.solve((c) => {
      supply("a", 0)(c);
      supply("k", 24)(c);
    });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("diode-reverse-voltage");
  });
});
