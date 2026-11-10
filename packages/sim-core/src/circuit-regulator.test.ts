// Round 6 (power): the regulator element and diodes in a power path.
import { describe, expect, it } from "vitest";
import { Circuit, GROUND } from "./circuit.ts";

const SCHOTTKY = { vf: 0.3, rOn: 0.15 };

describe("Circuit regulator (round 6, power)", () => {
  it("an LDO holds its output and takes the load current (+ iq) from its input", () => {
    const c = new Circuit();
    c.voltageSource("bat", GROUND, 4.0, 0.15, { id: "cell" });
    c.regulator("bat", "3v3", { volts: 3.3, dropout: 0.25, iq: 0.001 }, { id: "ldo" });
    c.resistor("3v3", GROUND, 33, { id: "load" }); // 100 mA
    const r = c.solve();
    expect(r.converged).toBe(true);
    expect(r.regulatorState?.("ldo")).toBe("regulating");
    expect(r.voltage("3v3")).toBeCloseTo(3.3, 1);
    expect(r.current("ldo") * 1000).toBeCloseTo(100, 0);
    expect(r.current("ldo:in") * 1000).toBeCloseTo(101, 0);
    // The cell delivers exactly what the regulator takes.
    expect(r.current("cell") * 1000).toBeCloseTo(101, 0);
  });

  it("an LDO in dropout tracks its input minus the dropout", () => {
    const c = new Circuit();
    c.voltageSource("bat", GROUND, 3.4, 0, { id: "cell" });
    c.regulator("bat", "out", { volts: 3.3, dropout: 0.25 }, { id: "ldo" });
    c.resistor("out", GROUND, 100);
    const r = c.solve();
    expect(r.regulatorState?.("ldo")).toBe("tracking");
    expect(r.voltage("out")).toBeCloseTo(3.15, 2);
    expect(r.current("cell")).toBeCloseTo(r.current("ldo"), 6);
  });

  it("a regulator with no input is off and its output reads 0 V", () => {
    const c = new Circuit();
    c.regulator("vin", "out", { volts: 3.3 }, { id: "ldo" });
    c.resistor("out", GROUND, 100);
    c.resistor("vin", GROUND, 1e6);
    const r = c.solve();
    expect(r.regulatorState?.("ldo")).toBe("off");
    expect(r.voltage("out")).toBeCloseTo(0, 3);
    expect(r.isOn("ldo")).toBe(false);
  });

  it("does not sink current when another source holds its output higher", () => {
    const c = new Circuit();
    c.voltageSource("vin", GROUND, 5, 0.01);
    c.regulator("vin", "out", { volts: 3.3 }, { id: "ldo" });
    c.voltageSource("out", GROUND, 3.6, 0.01, { id: "ext" });
    const r = c.solve();
    expect(r.regulatorState?.("ldo")).toBe("off");
    expect(r.voltage("out")).toBeCloseTo(3.6, 2);
    expect(r.current("ldo")).toBe(0);
  });

  it("a boost converter makes 5 V from a 3.7 V cell, drawing Pout / efficiency from it", () => {
    const c = new Circuit();
    c.voltageSource("bat", GROUND, 3.7, 0.1, { id: "cell" });
    c.regulator("bat", "5v", { volts: 5, kind: "switching", efficiency: 0.9, minIn: 2 }, { id: "boost" });
    c.resistor("5v", GROUND, 50); // 100 mA at 5 V = 0.5 W
    const r = c.solve();
    expect(r.converged).toBe(true);
    expect(r.regulatorState?.("boost")).toBe("regulating");
    expect(r.voltage("5v")).toBeCloseTo(5, 1);
    const vin = r.voltage("bat");
    expect(r.current("cell")).toBeCloseTo(0.5 / 0.9 / vin, 3);
    expect(r.current("cell")).toBeGreaterThan(0.14);
  });

  it("a boost converter is off below its UVLO", () => {
    const c = new Circuit();
    c.voltageSource("bat", GROUND, 1.5, 0.1);
    c.regulator("bat", "5v", { volts: 5, kind: "switching", minIn: 2 }, { id: "boost" });
    c.resistor("5v", GROUND, 50);
    expect(c.solve().regulatorState?.("boost")).toBe("off");
  });

  it("battery → schottky → LDO: the diode passes the load current and drops ~0.3 V", () => {
    const c = new Circuit();
    c.voltageSource("bat", GROUND, 4.0, 0.15, { id: "cell" });
    c.diode("bat", "vbus", SCHOTTKY, { id: "d" });
    c.regulator("vbus", "3v3", { volts: 3.3, dropout: 0.25 }, { id: "ldo" });
    c.resistor("3v3", GROUND, 66); // 50 mA
    const r = c.solve();
    expect(r.isOn("d")).toBe(true);
    expect(r.voltage("vbus")).toBeGreaterThan(3.6);
    expect(r.voltage("vbus")).toBeLessThan(3.75);
    expect(r.voltage("3v3")).toBeCloseTo(3.3, 1);
    expect(r.current("cell") * 1000).toBeCloseTo(50, 0);
  });

  it("USB on VBUS reverse-biases the battery diode: the cell gives nothing", () => {
    const c = new Circuit();
    c.voltageSource("bat", GROUND, 4.0, 0.15, { id: "cell" });
    c.diode("bat", "vbus", SCHOTTKY, { id: "d" });
    c.voltageSource("usbsrc", GROUND, 5, 0.05);
    c.diode("usbsrc", "vbus", { vf: 0.001, rOn: 0.01 }, { id: "usb" });
    c.regulator("vbus", "3v3", { volts: 3.3 }, { id: "ldo" });
    c.resistor("3v3", GROUND, 66);
    const r = c.solve();
    expect(r.isOn("d")).toBe(false);
    expect(Math.abs(r.current("cell"))).toBeLessThan(1e-6);
    expect(r.voltage("vbus")).toBeGreaterThan(4.9);
  });

  it("is deterministic and warm-starts across solves", () => {
    const build = () => {
      const c = new Circuit();
      c.voltageSource("bat", GROUND, 3.9, 0.15);
      c.regulator("bat", "3v3", { volts: 3.3 }, { id: "ldo" });
      c.resistor("3v3", GROUND, 50);
      return c;
    };
    const a = build().solve();
    const b = build();
    b.solve();
    const b2 = b.solve();
    expect(b2.voltage("3v3")).toBeCloseTo(a.voltage("3v3"), 9);
    expect(b2.iterations).toBeLessThanOrEqual(a.iterations);
  });
});
