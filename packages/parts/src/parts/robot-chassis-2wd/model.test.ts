import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("robot-chassis-2wd"), "robot-chassis-2wd");

describe("robot-chassis-2wd", () => {
  it("is mechanical: no pins, nothing in the circuit", () => {
    expect(def.spec.pins).toEqual([]);
    const b = mount(def);
    expect(b.solve().converged).toBe(true);
    expect(b.circuit.elementCount).toBe(0);
  });

  it("shows the pose the physics world writes back", () => {
    const b = mount(def);
    for (const [key, value] of Object.entries({ x: 52.4, y: 40, heading: 90, collisions: 1 })) b.model.interact!({ kind: "set", key, value });
    expect(b.model.visualState()).toMatchObject({ x: 52.4, y: 40, heading: 90, collisions: 1, label: "x 52 y 40 cm · 90°" });
  });

  it("defaults match a common acrylic 2WD kit with 65 mm wheels", () => {
    expect(b().wheelRadius).toBe(3.25);
    expect(b().sensorOffset).toBe(15);
    expect(b().trackWidth).toBe(13.5);
    function b() {
      return mount(def).model.visualState();
    }
  });
});
