import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("slide-switch"), "slide-switch");

describe("slide-switch", () => {
  // 1 → 5 V, 3 → GND, COM → 10 kΩ load: COM follows whichever throw is selected.
  const rig = () => {
    const b = mount(def, { wiring: { "1": "vcc", "2": "com", "3": GROUND } });
    b.solve((c) => {
      c.voltageSource("vcc", GROUND, 5, 0.01);
      c.resistor("com", GROUND, 10_000);
    });
    return b;
  };

  it("connects COM to 1 in position 0 and to 3 in position 1", () => {
    const b = rig();
    expect(b.result!.voltage("com")).toBeCloseTo(5, 2);
    b.interact({ kind: "press" });
    expect(b.model.visualState()).toEqual({ position: 1, knobTransform: "translate(16 0)" });
    expect(b.result!.voltage("com")).toBeCloseTo(0, 3);
    b.interact({ kind: "press" });
    expect(b.result!.voltage("com")).toBeCloseTo(5, 2);
  });

  it("follows the position prop and 'set' interactions", () => {
    const b = rig();
    b.setProp("position", 1);
    expect(b.result!.voltage("com")).toBeCloseTo(0, 3);
    b.interact({ kind: "set", value: 0 });
    expect(b.result!.voltage("com")).toBeCloseTo(5, 2);
  });

  it("never shorts 1 to 3", () => {
    const b = rig();
    for (const p of [0, 1]) {
      b.setProp("position", p);
      expect(b.result!.voltage("vcc")).toBeCloseTo(5, 2); // supply not dragged down
    }
  });
});
