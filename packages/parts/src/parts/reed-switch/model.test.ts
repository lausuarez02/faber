import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";
import { discFieldMt } from "../../lib/magnet.ts";

const def = need(registry.get("reed-switch"), "reed-switch");

describe("reed-switch", () => {
  it("a 6 x 3 mm N35 disc gives the textbook field on its axis", () => {
    // Br / 2 * T / sqrt(R^2 + T^2) at the face: 0.595 T * 3 / 4.24 = 421 mT
    expect(discFieldMt(0, 6, 3, 1.19)).toBeCloseTo(421, 0);
    expect(discFieldMt(10, 6, 3, 1.19)).toBeGreaterThan(9);
    expect(discFieldMt(10, 6, 3, 1.19)).toBeLessThan(11);
  });

  it("pulls a GPIO low while the magnet is near and lets the pull-up win when it goes away, with hysteresis", () => {
    const b = mount(def, { wiring: { "1": "io", "2": GROUND } });
    const pull = supply("vcc", 3.3);
    const solve = () => b.solve((c) => {
      pull(c);
      c.resistor("vcc", "io", 45_000);
    });
    expect(solve().voltage("io")).toBeCloseTo(3.3, 2); // magnet 40 mm away: open
    const closesAt = b.model.visualState().closes_at_mm as number;
    expect(closesAt).toBeGreaterThan(10);
    expect(closesAt).toBeLessThan(17);
    b.setProp("magnet_mm", closesAt - 0.5);
    expect(solve().voltage("io")).toBeLessThan(0.01);
    // between drop-out and pull-in it stays closed
    b.setProp("magnet_mm", closesAt + 1);
    expect(b.model.visualState().closed).toBe(true);
    b.setProp("magnet_mm", 35);
    expect(solve().voltage("io")).toBeCloseTo(3.3, 2);
    expect(b.model.visualState().operations).toBe(1);
  });

  it("press / release and set magnet near | away move the magnet (a lid in a test)", () => {
    const b = mount(def, { wiring: { "1": "io", "2": GROUND } });
    b.interact({ kind: "press" });
    expect(b.model.visualState()).toMatchObject({ closed: true, magnet_mm: 2 });
    b.interact({ kind: "set", key: "magnet", value: "away" });
    expect(b.model.visualState().closed).toBe(false);
    b.interact({ kind: "set", key: "magnet_mm", value: 5 });
    expect(b.model.visualState().closed).toBe(true);
  });

  it("a weaker magnet has to come closer", () => {
    const b = mount(def, { props: { magnet_grade: "ferrite" } });
    expect(b.model.visualState().closes_at_mm as number).toBeLessThan(10);
  });
});
