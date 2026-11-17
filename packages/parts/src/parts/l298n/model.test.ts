import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { pwmReading, timedMount } from "../../lib/timedBench.ts";

const def = need(registry.get("l298n"), "l298n");

/** VS from a battery, logic inputs from ideal sources, a 10 Ω load on each output pair. */
const rig = (vs: number, inputs: Record<string, number>, props: Record<string, boolean> = {}) => {
  const wiring: Record<string, string> = { "12V": "vs", OUT1: "o1", OUT2: "o2", OUT3: "o3", OUT4: "o4", "5V": "v5" };
  for (const k of Object.keys(inputs)) wiring[k] = k.toLowerCase();
  const b = timedMount(def, { wiring, props });
  b.extra((c) => {
    c.resistor("o1", "o2", 10, { id: "loadA" });
    c.resistor("o3", "o4", 10, { id: "loadB" });
  });
  b.set("vs", vs);
  for (const [k, v] of Object.entries(inputs)) b.set(k.toLowerCase(), v);
  return b;
};
const vA = (b: ReturnType<typeof rig>) => b.result!.voltage("o1") - b.result!.voltage("o2");

describe("l298n", () => {
  it("drives motor A forward with about a 2 V drop (datasheet 1.8 V typ at 1 A)", () => {
    const b = rig(9, { ENA: 5, IN1: 5, IN2: 0 });
    const v = vA(b);
    const i = v / 10;
    expect(9 - v).toBeGreaterThan(1.8);
    expect(9 - v).toBeLessThan(2.6);
    expect(i).toBeGreaterThan(0.6);
    expect(b.model.visualState()).toMatchObject({ aState: "fwd", aDuty: 1, powered: true, bState: "off" });
  });

  it("reverses, brakes and coasts per the truth table", () => {
    expect(vA(rig(9, { ENA: 5, IN1: 0, IN2: 5 }))).toBeLessThan(-6);
    const brakeLow = rig(9, { ENA: 5, IN1: 0, IN2: 0 });
    expect(brakeLow.model.visualState().aState).toBe("brake");
    expect(Math.abs(vA(brakeLow))).toBeLessThan(0.01);
    const brakeHigh = rig(9, { ENA: 5, IN1: 5, IN2: 5 });
    expect(brakeHigh.model.visualState().aState).toBe("brake");
    const off = rig(9, { ENA: 0, IN1: 5, IN2: 0 });
    expect(off.model.visualState().aState).toBe("off");
    expect(Math.abs(vA(off))).toBeLessThan(0.01);
  });

  it("drives motor B from ENB/IN3/IN4 and honours the ENA jumper", () => {
    const b = rig(9, { ENB: 5, IN3: 5, IN4: 0, IN1: 5, IN2: 0 }, { enaJumper: true });
    expect(b.model.visualState()).toMatchObject({ aState: "fwd", bState: "fwd" });
    expect(b.result!.voltage("o3") - b.result!.voltage("o4")).toBeGreaterThan(6);
  });

  it("thresholds inputs at 1.5 / 2.3 V with hysteresis", () => {
    const b = rig(9, { ENA: 5, IN1: 3.3, IN2: 0 });
    expect(b.model.visualState().aState).toBe("fwd"); // 3.3 V logic works
    b.set("in1", 2.0); // between thresholds: keeps HIGH
    expect(b.model.visualState().aState).toBe("fwd");
    b.set("in1", 1.0);
    expect(b.model.visualState().aState).toBe("brake");
  });

  it("takes analogWrite on ENA as a duty and declares it on OUT1/OUT2 for the motor", () => {
    const b = rig(9, { ENA: 2.5, IN1: 5, IN2: 0 });
    b.pwm.set("ENA", pwmReading(0.6, 976, "mcu:D5"));
    b.solve();
    expect(b.model.visualState()).toMatchObject({ aState: "fwd", aDuty: 0.6, aLabel: "A fwd 60%" });
    expect(b.declared.get("OUT1")).toMatchObject({ duty: 0.6 });
    expect(b.declared.get("OUT2")).toMatchObject({ duty: 0.6 });
    b.pwm.set("ENA", pwmReading(1, 976, "mcu:D5"));
    b.set("ena", 5);
    expect(b.declared.get("OUT1")).toBeUndefined();
  });

  it("explains a disabled channel, a missing battery and a starved regulator", () => {
    const disabled = rig(9, { IN1: 5, IN2: 0 });
    const d1 = disabled.model.diagnostics!().find((d) => d.code === "l298n-enable-low");
    expect(d1?.message).toMatch(/ENA/);
    expect(d1?.message).toMatch(/analogWrite|enaJumper/);

    const noBattery = rig(0, { ENA: 5, IN1: 5, IN2: 0 }, { regulatorJumper: false });
    noBattery.set("v5", 5);
    const d2 = noBattery.model.diagnostics!().find((d) => d.code === "l298n-no-motor-supply");
    expect(d2?.severity).toBe("error");
    expect(d2?.message).toMatch(/battery POS → l298n:12V/);

    const lowReg = rig(5, { ENA: 5, IN1: 5, IN2: 0 });
    expect(lowReg.model.visualState().powered).toBe(false);
    expect(lowReg.model.diagnostics!().map((d) => d.code)).toContain("l298n-no-logic-supply");
  });

  it("outputs 5 V from its regulator at ≥ 7 V and VS − 2 V below", () => {
    expect(rig(9, {}).result!.voltage("v5")).toBeCloseTo(5, 1);
    expect(rig(6, {}).result!.voltage("v5")).toBeCloseTo(4, 1);
  });

  it("flags overcurrent above 2 A per channel", () => {
    const b = rig(12, { ENA: 5, IN1: 5, IN2: 0 });
    b.extra((c) => void c.resistor("o1", "o2", 1, { id: "short" }));
    b.solve();
    b.solve();
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("l298n-overcurrent");
  });
});

describe("example.ino (L298N + motor + 2S LiPo) on the Uno", { timeout: 60_000 }, () => {
  it("half speed, full speed, brake, reverse, coast", () => {
    const sim = exampleSim("l298n", [
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
