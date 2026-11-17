import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("potentiometer"), "potentiometer");

describe("potentiometer", () => {
  // 1 → GND, 2 → 5 V, W → an ADC input (high impedance).
  const rig = (position: number) => {
    const b = mount(def, { props: { position }, wiring: { "1": GROUND, "2": "vcc", W: "a0" } });
    b.solve((c) => void c.voltageSource("vcc", GROUND, 5, 0.01));
    return b;
  };

  it("gives ~2.5 V on the wiper at the middle", () => {
    expect(rig(0.5).result!.voltage("a0")).toBeCloseTo(2.5, 2);
  });

  it("spans 0..5 V linearly", () => {
    expect(rig(0).result!.voltage("a0")).toBeLessThan(0.01);
    expect(rig(1).result!.voltage("a0")).toBeGreaterThan(4.99);
    expect(rig(0.25).result!.voltage("a0")).toBeCloseTo(1.25, 2);
  });

  it("draws 0.5 mA end to end (10 kΩ at 5 V)", () => {
    const b = rig(0.3);
    expect(b.result!.current("potentiometer/lower")).toBeCloseTo(-0.5e-3, 5); // current flows 2 → W → 1
  });

  it("follows 'set' interactions and the position prop, and rotates the knob", () => {
    const b = rig(0.5);
    expect(b.model.visualState().knobTransform).toBe("rotate(0 40 38)");
    b.interact({ kind: "set", value: 1 });
    expect(b.result!.voltage("a0")).toBeGreaterThan(4.99);
    expect(b.model.visualState().knobAngle).toBe(135);
    b.setProp("position", 0);
    expect(b.model.visualState().knobTransform).toBe("rotate(-135 40 38)");
    b.interact({ kind: "set", value: 7 });
    expect(b.model.visualState().position).toBe(1);
  });
});
