import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("led"), "led");
const resistorDef = need(registry.get("resistor"), "resistor");

/** 5 V → resistor → LED → GND. Returns the LED bench. */
function ledWithResistor(ohms: number, color = "red", volts = 5) {
  const r = mount(resistorDef, { id: "r1", props: { resistance: ohms }, wiring: { "1": "vcc", "2": "a" } });
  const led = mount(def, { id: "led1", props: { color }, wiring: { A: "a", C: GROUND } });
  led.solve((c) => {
    r.model.stamp(c);
    c.voltageSource("vcc", GROUND, volts, 0.01);
  });
  return led;
}

describe("led", () => {
  it("red LED + 220 Ω at 5 V lights at ~13 mA (datasheet Vf ≈ 2.1 V)", () => {
    const led = ledWithResistor(220);
    const s = led.model.visualState();
    expect(s.currentmA).toBeGreaterThan(12.5);
    expect(s.currentmA).toBeLessThan(14);
    expect(s.on).toBe(true);
    expect(s.brightness).toBeGreaterThan(0.7);
    expect(s.brightness).toBeLessThan(1);
    const vf = led.result!.voltage("a");
    expect(vf).toBeGreaterThan(2.0);
    expect(vf).toBeLessThan(2.2);
    expect(led.model.diagnostics!()).toEqual([]);
  });

  it("forward voltage depends on colour: blue drops ~1 V more than red", () => {
    const red = ledWithResistor(220, "red").result!.voltage("a");
    const blue = ledWithResistor(220, "blue").result!.voltage("a");
    expect(blue - red).toBeGreaterThan(0.8);
    expect(blue).toBeGreaterThan(2.9);
    expect(blue).toBeLessThan(3.2);
  });

  it("is dark below 0.1 mA and saturates at 20 mA", () => {
    expect(ledWithResistor(100_000).model.visualState().brightness).toBe(0); // ~0.03 mA
    expect(ledWithResistor(1_000).model.visualState().brightness).toBeGreaterThan(0); // ~3 mA
    expect(ledWithResistor(100).model.visualState().brightness).toBe(1); // ~29 mA
  });

  it("does not light when reversed", () => {
    const led = mount(def, { wiring: { A: GROUND, C: "k" } });
    led.solve(supply("k", 5));
    expect(led.model.visualState().on).toBe(false);
    expect(led.model.visualState().currentmA).toBe(0);
  });

  it("warns above 20 mA and errors above 30 mA ('LED will burn out, add a resistor')", () => {
    const warm = ledWithResistor(120); // ~24 mA
    expect(warm.model.diagnostics!()).toMatchObject([{ severity: "warning", code: "led-overcurrent" }]);

    const direct = mount(def, { wiring: { A: "a", C: GROUND } });
    direct.solve((c) => void c.voltageSource("a", GROUND, 5, 25)); // straight on a GPIO
    expect(direct.model.visualState().currentmA).toBeCloseTo(100, 0);
    const d = direct.model.diagnostics!();
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("error");
    expect(d[0]!.code).toBe("led-overcurrent");
    expect(d[0]!.message).toMatch(/LED will burn out, add a resistor/);
  });

  it("switches colour with setProp", () => {
    const led = ledWithResistor(220);
    led.setProp("color", "green");
    expect(led.model.visualState().color).toBe("#5CF2A1");
    led.setProp("color", "not-a-colour");
    expect(led.model.visualState().color).toBe("#FF3B2F");
  });
});
