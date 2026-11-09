import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { serialLines } from "../../lib/firmwareBench.ts";
import { pwmReading, timedMount } from "../../lib/timedBench.ts";

const def = need(registry.get("water-pump"), "water-pump");

describe("water-pump", () => {
  it("runs at ~120 L/h and ~180 mA on 5 V and counts the water it pumps", () => {
    const t = timedMount(def, { wiring: { POS: "v", NEG: GROUND } });
    t.set("v", 5);
    t.advance(1000);
    const s = t.model.visualState();
    expect(Number(s.flowLph)).toBeGreaterThan(110);
    expect(Number(s.flowLph)).toBeLessThan(125);
    expect(Number(s.currentmA)).toBeGreaterThan(160);
    expect(Number(s.currentmA)).toBeLessThan(200);
    expect(s.running).toBe(true);
    const ml = Number(s.pumpedMl);
    t.advance(1000);
    // 120 L/h = 33.3 ml/s
    expect(Number(t.model.visualState().pumpedMl) - ml).toBeGreaterThan(30);
    expect(Number(t.model.visualState().pumpedMl) - ml).toBeLessThan(35);
  });

  it("pumps less at 3 V and nothing below the threshold", () => {
    const t = timedMount(def, { wiring: { POS: "v", NEG: GROUND } });
    t.set("v", 3);
    t.advance(1000);
    const f3 = Number(t.model.visualState().flowLph);
    expect(f3).toBeGreaterThan(30);
    expect(f3).toBeLessThan(90);
    t.set("v", 1);
    t.advance(1000);
    expect(t.model.visualState().running).toBe(false);
    expect(t.model.diagnostics!().map((d) => d.code)).toContain("pump-no-flow");
  });

  it("follows the duty of a PWM driver", () => {
    const t = timedMount(def, { wiring: { POS: "v", NEG: GROUND } });
    t.pwm.set("POS", pwmReading(0.6, 490, "drv"));
    t.set("v", 5);
    t.advance(1500);
    const f = Number(t.model.visualState().flowLph);
    expect(f).toBeGreaterThan(20);
    expect(f).toBeLessThan(100);
  });

  it("pumps (almost) nothing and warns when reversed", () => {
    const t = timedMount(def, { wiring: { POS: GROUND, NEG: "v" } });
    t.set("v", 5);
    t.advance(500);
    expect(t.model.visualState().running).toBe(false);
    expect(t.model.diagnostics!().map((d) => d.code)).toContain("pump-reversed");
  });

  it("is an error straight on a GPIO", () => {
    const t = timedMount(def, { wiring: { POS: "d7", NEG: GROUND } });
    t.pwm.set("POS", { ...pwmReading(1, 490, "mcu:D7"), averaged: false });
    t.set("d7", 5);
    t.advance(200);
    const d = t.model.diagnostics!().find((x) => x.code === "pump-on-gpio");
    expect(d?.message).toMatch(/relay module/);
  });
});

describe("water-pump: a plant waterer on real firmware (soil probe + relay module + pump, example.ino)", () => {
  it("waters dry soil for 3 s through the relay and leaves wet soil alone", () => {
    const sim = exampleSim(
      "water-pump",
      [
        { id: "soil", type: "capacitive-soil-moisture", x: 0, y: 0, props: { moisture: 20 } },
        { id: "relay", type: "relay-module", x: 0, y: 0 },
        { id: "pump", type: "water-pump", x: 0, y: 0 },
      ],
      [
        ["soil.VCC", "uno.5V"],
        ["soil.GND", "uno.GND.1"],
        ["soil.AOUT", "uno.A0"],
        ["relay.VCC", "uno.5V"],
        ["relay.GND", "uno.GND.2"],
        ["relay.IN", "uno.D7"],
        ["relay.COM", "uno.5V"],
        ["relay.NO", "pump.POS"],
        ["pump.NEG", "uno.GND.3"],
      ],
    );
    sim.runFor(1500);
    expect(serialLines(sim)).toEqual(expect.arrayContaining(["watering"]));
    expect(Number(serialLines(sim)[0]!.split("=")[1])).toBeGreaterThan(500);
    expect(sim.partState("relay")).toMatchObject({ energized: true, clicks: 1 });
    expect(sim.partState("pump")!.running).toBe(true);
    sim.runFor(2000); // pump off at ~3 s
    const ml = Number(sim.partState("pump")!.pumpedMl);
    expect(sim.partState("relay")!.energized).toBe(false);
    expect(ml).toBeGreaterThan(80); // ~3 s at ~110 L/h on the Uno's 5 V
    expect(ml).toBeLessThan(110);
    sim.interact("soil", { kind: "set", value: 70 });
    sim.runFor(6000);
    expect(Number(sim.partState("pump")!.pumpedMl)).toBeCloseTo(ml, 0);
    expect(sim.partState("relay")!.clicks).toBe(1);
    expect(sim.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
  }, 120_000);
});
