import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";
import { formatOhms, resistorBands } from "../../lib/resistorBands.ts";

const def = need(registry.get("resistor"), "resistor");

describe("resistor", () => {
  it("obeys Ohm's law: 5 V across 1 kΩ is 5 mA", () => {
    const b = mount(def, { props: { resistance: 1000 }, wiring: { "1": "vcc", "2": GROUND } });
    b.solve(supply("vcc", 5));
    expect(b.model.visualState().currentmA).toBeCloseTo(5, 2);
  });

  it("divides 5 V in half with two 10 kΩ resistors", () => {
    const top = mount(def, { id: "r1", props: { resistance: 10_000 }, wiring: { "1": "vcc", "2": "mid" } });
    const bot = mount(def, { id: "r2", props: { resistance: 10_000 }, wiring: { "1": "mid", "2": GROUND } });
    top.solve((c) => {
      bot.model.stamp(c);
      c.voltageSource("vcc", GROUND, 5, 0.01);
    });
    expect(top.result!.voltage("mid")).toBeCloseTo(2.5, 3);
  });

  it("re-stamps after setProp and accepts the 'ohms' alias", () => {
    const b = mount(def, { wiring: { "1": "vcc", "2": GROUND } });
    b.solve(supply("vcc", 5));
    expect(b.model.visualState().currentmA).toBeCloseTo(5 / 220 * 1000, 1);
    b.setProp("ohms", 470);
    expect(b.model.visualState().resistance).toBe(470);
    expect(b.model.visualState().currentmA).toBeCloseTo(5 / 470 * 1000, 1);
  });

  it("warns when dissipating more than 1/4 W (10 Ω across 5 V = 2.5 W → error)", () => {
    const b = mount(def, { props: { resistance: 10 }, wiring: { "1": "vcc", "2": GROUND } });
    b.solve(supply("vcc", 5));
    const d = b.model.diagnostics!();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "resistor-overpower", severity: "error" });
    b.setProp("resistance", 1000);
    expect(b.model.diagnostics!()).toEqual([]);
  });

  it("colour-codes standard values", () => {
    // 220 Ω = red red brown, 10 kΩ = brown black orange, 4.7 Ω = yellow violet gold
    expect(resistorBands(220)).toEqual(["#E0321E", "#E0321E", "#7A4A26"]);
    expect(resistorBands(10_000)).toEqual(["#7A4A26", "#1A1A1A", "#F28A1E"]);
    expect(resistorBands(4.7)).toEqual(["#F5D020", "#8A4FD8", "#C9A43A"]);
    expect(formatOhms(4700)).toBe("4.7 kΩ");
    expect(formatOhms(220)).toBe("220 Ω");
  });
});
