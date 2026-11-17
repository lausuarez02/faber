import { describe, expect, it } from "vitest";
import { GROUND, type CircuitBuilder } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { timedMount } from "../../lib/timedBench.ts";

const def = need(registry.get("relay-module"), "relay-module");
const wiring = { VCC: "vcc", IN: "in", COM: "com", NO: "no", NC: "nc", GND: GROUND };

/** 12 V load supply → COM; a 60 Ω load from NO to GND (200 mA). */
const circuit = (inVolts: number | undefined, vcc = 5) => (c: CircuitBuilder) => {
  c.voltageSource("vcc", GROUND, vcc, 0.01);
  if (inVolts !== undefined) c.voltageSource("in", GROUND, inVolts, 25, { id: "gpio" });
  c.voltageSource("com", GROUND, 12, 0.01);
  c.resistor("no", GROUND, 60);
};

describe("relay-module", () => {
  it("active low: IN LOW switches the load on through NO, HIGH switches it off", () => {
    const b = mount(def, { wiring });
    b.solve(circuit(5));
    expect(b.model.visualState()).toMatchObject({ energized: false, contact: "NC", loadmA: 0 });
    b.solve(circuit(0));
    const s = b.model.visualState();
    expect(s).toMatchObject({ energized: true, contact: "NO", clicks: 1 });
    expect(Number(s.loadmA)).toBeCloseTo(200, 0);
    expect(Number(s.coilmA)).toBeCloseTo(71, 0);
    expect(b.result!.voltage("no")).toBeCloseTo(12, 1);
    b.solve(circuit(5));
    expect(b.model.visualState().energized).toBe(false);
  });

  it("sinks ~3.8 mA into the pin while on (the optocoupler LED)", () => {
    const b = mount(def, { wiring });
    const r = b.solve(circuit(0));
    expect(-r.current("gpio") * 1000).toBeGreaterThan(3);
    expect(-r.current("gpio") * 1000).toBeLessThan(4.5);
  });

  it("active high: IN HIGH switches it on, also from a 3.3 V GPIO", () => {
    const b = mount(def, { wiring, props: { trigger: "high" } });
    b.solve(circuit(3.3));
    expect(b.model.visualState().energized).toBe(true);
    b.solve(circuit(0));
    expect(b.model.visualState().energized).toBe(false);
  });

  it("stays off when IN floats", () => {
    const b = mount(def, { wiring });
    b.solve(circuit(undefined));
    expect(b.model.visualState().energized).toBe(false);
  });

  it("does not pull in on 3.3 V and says so", () => {
    const b = mount(def, { wiring });
    b.solve(circuit(0, 3.3));
    expect(b.model.visualState().energized).toBe(false);
    const d = b.model.diagnostics!();
    expect(d.map((x) => x.code)).toContain("relay-undervoltage");
    expect(d.find((x) => x.code === "relay-undervoltage")!.message).toMatch(/3\.75 V/);
  });

  it("warns that a 3.3 V HIGH may not turn an active-low module off", () => {
    const b = mount(def, { wiring });
    b.solve(circuit(3.3));
    expect(b.model.diagnostics!().map((x) => x.code)).toContain("relay-3v3-input");
  });

  it("switches 10 ms after the input and releases 5 ms after", () => {
    const t = timedMount(def, { wiring });
    t.extra((c) => {
      c.voltageSource("com", GROUND, 12, 0.01);
      c.resistor("no", GROUND, 60);
    });
    t.set("vcc", 5);
    t.set("in", 0);
    t.advance(9);
    expect(t.model.visualState().energized).toBe(false);
    t.advance(2);
    expect(t.model.visualState().energized).toBe(true);
    t.set("in", 5);
    t.advance(4);
    expect(t.model.visualState().energized).toBe(true);
    t.advance(2);
    expect(t.model.visualState().energized).toBe(false);
  });

  it("flags contact overcurrent", () => {
    const b = mount(def, { wiring });
    b.solve((c) => {
      c.voltageSource("vcc", GROUND, 5, 0.01);
      c.voltageSource("in", GROUND, 0, 25);
      c.voltageSource("com", GROUND, 12, 0.01);
      c.resistor("no", GROUND, 0.5);
    });
    expect(b.model.diagnostics!().map((x) => x.code)).toContain("relay-contact-overcurrent");
  });
});
