import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { pwmReading, timedMount } from "../../lib/timedBench.ts";
import { pulseToAngle } from "./model.ts";

const def = need(registry.get("servo-sg90"), "servo-sg90");

const rig = (vcc = 5, props: Record<string, number> = {}) => {
  const b = timedMount(def, { props, wiring: { VCC: "vcc", SIG: "sig" } });
  b.set("vcc", vcc);
  b.set("sig", 0);
  return b;
};

/** Send 50 Hz pulses of `us` for `ms`. */
function pulses(b: ReturnType<typeof rig>, us: number, ms: number) {
  for (let t = 0; t < ms; t += 20) {
    b.set("sig", 5);
    b.advance(us / 1000);
    b.set("sig", 0);
    b.advance(20 - us / 1000);
  }
}
const angle = (b: ReturnType<typeof rig>) => Number(b.model.visualState().angle);

describe("servo-sg90", () => {
  it("maps 544 / 1472 / 2400 µs to 0 / 90 / 180° (Servo library)", () => {
    expect(pulseToAngle(544)).toBe(0);
    expect(pulseToAngle(1472)).toBe(90);
    expect(pulseToAngle(2400)).toBe(180);
    const b = rig();
    pulses(b, 2400, 600);
    expect(angle(b)).toBeCloseTo(180, 1);
    pulses(b, 544, 600);
    expect(angle(b)).toBeCloseTo(0, 1);
    pulses(b, 1000, 400);
    expect(angle(b)).toBeCloseTo(pulseToAngle(1000), 0);
    expect(b.model.visualState().pulseUs).toBeCloseTo(1000, 0);
  });

  it("slews at 0.1 s per 60° at 4.8 V (faster at 6 V)", () => {
    const b = rig(4.8);
    pulses(b, 2400, 100); // from 90° towards 180°, 100 ms
    expect(angle(b)).toBeGreaterThan(90 + 55);
    expect(angle(b)).toBeLessThan(90 + 62);
    expect(b.model.visualState().moving).toBe(true);
    const fast = rig(6);
    pulses(fast, 2400, 100);
    expect(angle(fast)).toBeGreaterThan(angle(b));
  });

  it("draws ~250 mA while moving and ~10 mA holding", () => {
    const b = rig(4.8);
    pulses(b, 2400, 60);
    expect(Number(b.model.visualState().currentmA)).toBeGreaterThan(200);
    pulses(b, 2400, 400);
    expect(Number(b.model.visualState().currentmA)).toBeLessThan(15);
  });

  it("stalls at a mechanical stop with stall current and a warning", () => {
    const b = rig(4.8, { maxAngle: 150 });
    pulses(b, 2400, 600);
    expect(angle(b)).toBeCloseTo(150, 1);
    expect(b.model.visualState().stalled).toBe(true);
    expect(Number(b.model.visualState().currentmA)).toBeGreaterThan(600);
    expect(b.model.diagnostics!().find((d) => d.code === "servo-stalled")?.message).toMatch(/0–150°/);
  });

  it("holds when pulses stop, ignores bad pulses and explains analogWrite", () => {
    const b = rig();
    pulses(b, 2000, 600);
    const held = angle(b);
    b.advance(500);
    expect(angle(b)).toBe(held);
    pulses(b, 3000, 100);
    expect(angle(b)).toBe(held);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("servo-pulse-out-of-range");
    b.pwm.set("SIG", pwmReading(0.5, 490));
    b.solve();
    expect(b.model.diagnostics!().find((d) => d.code === "servo-not-servo-pulses")?.message).toMatch(/Servo library/);
  });

  it("prefers the cycle-stamped pulse width from the simulation", () => {
    const b = rig();
    b.pwm.set("SIG", { ...pwmReading(0.075, 50), highUs: 1500, averaged: false, level: 0 });
    pulses(b, 1400, 400); // the meter says 1500 µs; the meter wins
    expect(b.model.visualState().pulseUs).toBe(1500);
  });

  it("does not move without power and says so", () => {
    const b = rig(0);
    pulses(b, 2400, 200);
    expect(angle(b)).toBe(90);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("servo-unpowered");
  });

  it("rotates the horn in the SVG", () => {
    const b = rig();
    pulses(b, 544, 600);
    expect(b.model.visualState().hornTransform).toBe("rotate(-90 112 50)");
  });
});

describe("servo-sg90 example.ino on the Uno", { timeout: 60_000 }, () => {
  it("sweeps 0 → 90 → 180° once a second", () => {
    const sim = exampleSim("servo-sg90", [{ id: "servo", type: "servo-sg90", x: 0, y: 0 }], [
      ["uno.5V", "servo.VCC"],
      ["servo.GND", "uno.GND.1"],
      ["uno.D9", "servo.SIG"],
    ]);
    const angles: number[] = [];
    for (let i = 0; i < 3; i++) {
      sim.runFor(1000);
      angles.push(Math.round(Number(sim.partState("servo")!.angle)));
    }
    expect(angles).toEqual([0, 90, 180]);
    expect(sim.serialText()).toBe("angle 0\r\nangle 90\r\nangle 180\r\n");
    expect(sim.pwm("servo", "SIG")).toMatchObject({ averaged: false });
  });
});
