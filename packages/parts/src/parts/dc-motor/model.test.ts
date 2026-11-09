import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { pwmReading, timedMount } from "../../lib/timedBench.ts";
import { motorParams } from "./model.ts";

const def = need(registry.get("dc-motor"), "dc-motor");

const rig = (volts: number) => {
  const b = timedMount(def, { wiring: { A: "a", B: GROUND } });
  b.set("a", volts);
  return b;
};
const rpm = (b: ReturnType<typeof rig>) => Number(b.model.visualState().rpm);

describe("dc-motor (TT gear motor)", () => {
  it("derives consistent constants: no-load speed and current at the rated voltage", () => {
    const p = motorParams({ ratedVoltage: 6, noLoadRpm: 200, stallCurrent: 1.5, noLoadCurrent: 0.15, timeConstantMs: 60 });
    expect(p.R).toBeCloseTo(4, 6);
    const i0 = (6 - p.Ke * p.w0) / p.R;
    expect(i0).toBeCloseTo(0.15, 6);
    expect(p.Ke * i0).toBeCloseTo(p.Tc + p.b * p.w0, 9);
  });

  it("reaches its 200 rpm no-load speed at 6 V and draws the no-load current", () => {
    const b = rig(6);
    b.advance(1000);
    expect(rpm(b)).toBeGreaterThan(197);
    expect(rpm(b)).toBeLessThan(203);
    expect(Number(b.model.visualState().currentmA)).toBeCloseTo(150, -1);
    expect(b.model.visualState().spinning).toBe(true);
  });

  it("spins up with the 60 ms time constant (≈63 % after one τ)", () => {
    const b = rig(6);
    b.advance(60);
    expect(rpm(b) / 200).toBeGreaterThan(0.55);
    expect(rpm(b) / 200).toBeLessThan(0.72);
  });

  it("runs at about half speed at 3 V and reverses with polarity", () => {
    const half = rig(3);
    half.advance(1000);
    expect(rpm(half)).toBeGreaterThan(90);
    expect(rpm(half)).toBeLessThan(100);
    const rev = rig(-6);
    rev.advance(1000);
    expect(rpm(rev)).toBeLessThan(-197);
  });

  it("does not start below its static-friction dead band (~0.3 V)", () => {
    const b = rig(0.25);
    b.advance(500);
    expect(rpm(b)).toBe(0);
    const c = rig(1);
    c.advance(500);
    expect(rpm(c)).toBeGreaterThan(10);
  });

  it("draws the stall current when blocked and warns after 0.5 s", () => {
    const b = rig(6);
    b.model.interact!({ kind: "set", key: "loadTorque", value: 10 });
    b.advance(800);
    expect(rpm(b)).toBe(0);
    expect(Number(b.model.visualState().currentmA)).toBeCloseTo(1500, -1);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("dc-motor-stalled");
  });

  it("averages a PWM duty declared on its net (driver output at 50 %)", () => {
    const b = timedMount(def, { wiring: { A: "a", B: GROUND } });
    b.pwm.set("A", pwmReading(0.5, 490, "drv"));
    b.set("a", 6);
    b.advance(1500);
    // Half the average voltage minus friction: a bit under 100 rpm.
    expect(rpm(b)).toBeGreaterThan(85);
    expect(rpm(b)).toBeLessThan(100);
    expect(b.model.diagnostics!()).toEqual([]);
  });

  it("is an error to wire it straight to an Arduino pin", () => {
    const b = timedMount(def, { wiring: { A: "d5", B: GROUND } });
    b.pwm.set("A", pwmReading(1, 490, "mcu:D5"));
    b.set("d5", 5);
    const d = b.model.diagnostics!().find((x) => x.code === "dc-motor-on-gpio");
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/D5.*L298N|l298n/i);
  });

  it("warns about overvoltage and turns the hub visually", () => {
    const b = rig(12);
    b.advance(200);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("dc-motor-overvoltage");
    expect(String(b.model.visualState().spinTransform)).toMatch(/^rotate\(-?\d+(\.\d+)? 98 40\)$/);
    expect(b.model.visualState().spinTransform).not.toBe("rotate(0 98 40)");
  });
});

describe("example.ino (L298N + motor + 2S LiPo) on the Uno", { timeout: 60_000 }, () => {
  it("half speed, full speed, brake, reverse, coast", () => {
    const sim = exampleSim("dc-motor", [
      { id: "drv", type: "l298n", x: 0, y: 0 },
      { id: "m", type: "dc-motor", x: 0, y: 0 },
      { id: "bat", type: "battery-pack", x: 0, y: 0, props: { preset: "2S-LiPo" } },
    ], [
      ["uno.D5", "drv.ENA"],
      ["uno.D7", "drv.IN1"],
      ["uno.D8", "drv.IN2"],
      ["drv.OUT1", "m.A"],
      ["drv.OUT2", "m.B"],
      ["bat.POS", "drv.12V"],
      ["bat.NEG", "drv.GND"],
      ["drv.GND", "uno.GND.1"],
    ]);
    const rpm: number[] = [];
    for (const ms of [900, 1000, 500, 1000, 500]) {
      sim.runFor(ms);
      rpm.push(Math.round(Number(sim.partState("m")!.rpm)));
    }
    const [half, full, brake, rev, coast] = rpm as [number, number, number, number, number];
    // 8.4 V − ~1.9 V L298N drop ≈ 6.5 V at full duty → a bit over the 200 rpm rated at 6 V
    expect(full).toBeGreaterThan(195);
    expect(full).toBeLessThan(235);
    expect(half / full).toBeGreaterThan(0.42);
    expect(half / full).toBeLessThan(0.52);
    // Brake shorts the motor through the low sides (~1.5 V of drops), so below ~1.5 V of back-EMF
    // it only coasts, as on a real L298N: well under 10 % of full speed after 0.5 s.
    expect(Math.abs(brake)).toBeLessThan(0.1 * full);
    expect(rev / full).toBeLessThan(-0.68);
    expect(rev / full).toBeGreaterThan(-0.78);
    expect(Math.abs(coast)).toBeLessThan(Math.abs(rev));
    expect(sim.diagnostics().filter((d) => d.severity !== "info")).toEqual([]);
  });
});
