import { describe, expect, it } from "vitest";
import { Circuit, gaussianSolve } from "./circuit.ts";

const RED_LED = { vf: 2.0, rOn: 5 };

describe("Circuit", () => {
  it("solves a voltage divider", () => {
    const c = new Circuit();
    c.voltageSource("vcc", "0", 5);
    const r1 = c.resistor("vcc", "mid", 10_000);
    c.resistor("mid", "0", 10_000);
    const r = c.solve();
    expect(r.voltage("vcc")).toBeCloseTo(5, 4);
    expect(r.voltage("mid")).toBeCloseTo(2.5, 4);
    expect(r.current(r1)).toBeCloseTo(0.25e-3, 7);
    expect(r.isFloating("mid")).toBe(false);
  });

  it("LED + 220 Ω from 5 V draws ~13-14 mA", () => {
    const c = new Circuit();
    const src = c.voltageSource("vcc", "0", 5);
    c.resistor("vcc", "a", 220);
    const led = c.led("a", "0", RED_LED);
    const r = c.solve();
    expect(r.converged).toBe(true);
    expect(r.isOn(led)).toBe(true);
    const mA = r.current(led) * 1000;
    expect(mA).toBeGreaterThan(13);
    expect(mA).toBeLessThan(14);
    expect(r.current(src)).toBeCloseTo(r.current(led), 6);
  });

  it("LED with no resistor on a 25 Ω GPIO draws far too much current", () => {
    const c = new Circuit();
    c.voltageSource("pin", "0", 5, 25);
    const led = c.led("pin", "0", RED_LED);
    const mA = c.solve().current(led) * 1000;
    expect(mA).toBeGreaterThan(50);
  });

  it("reverse-biased LED stays off", () => {
    const c = new Circuit();
    c.voltageSource("vcc", "0", 5);
    c.resistor("vcc", "k", 220);
    const led = c.led("0", "k", RED_LED);
    const r = c.solve();
    expect(r.isOn(led)).toBe(false);
    expect(Math.abs(r.current(led))).toBeLessThan(1e-6);
  });

  it("two LEDs in series need enough voltage", () => {
    const c = new Circuit();
    c.voltageSource("vcc", "0", 3.3);
    c.resistor("vcc", "a", 100);
    const d1 = c.led("a", "m", RED_LED);
    const d2 = c.led("m", "0", RED_LED);
    const r = c.solve();
    expect(r.isOn(d1) && r.isOn(d2)).toBe(false);
  });

  it("detects floating nodes behind an open switch", () => {
    const c = new Circuit();
    c.voltageSource("vcc", "0", 5);
    const sw = c.switch("vcc", "in", false);
    c.resistor("in", "x", 1000); // in and x only connect to each other
    let r = c.solve();
    expect(r.isFloating("in")).toBe(true);
    expect(r.isFloating("x")).toBe(true);
    expect(Math.abs(r.voltage("in"))).toBeLessThan(1e-3);
    expect(r.isFloating("vcc")).toBe(false);

    c.clear();
    c.voltageSource("vcc", "0", 5);
    c.switch("vcc", "in", true);
    c.resistor("in", "0", 10_000);
    r = c.solve();
    expect(r.isFloating("in")).toBe(false);
    expect(r.voltage("in")).toBeCloseTo(5, 2);
    expect(sw).toBe("e1");
  });

  it("pull-up modelled as a 35 kΩ source reads HIGH until a button pulls it low", () => {
    const c = new Circuit();
    c.voltageSource("pin", "0", 5, 35_000);
    c.switch("pin", "0", false);
    expect(c.solve().voltage("pin")).toBeCloseTo(5, 3);
    c.clear();
    c.voltageSource("pin", "0", 5, 35_000);
    c.switch("pin", "0", true);
    expect(c.solve().voltage("pin")).toBeLessThan(0.01);
  });

  it("rejects duplicate ids and bad values", () => {
    const c = new Circuit();
    c.resistor("a", "0", 1, { id: "r" });
    expect(() => c.resistor("a", "0", 1, { id: "r" })).toThrow(/duplicate/);
    expect(() => c.resistor("a", "0", 0)).toThrow();
  });

  it("gaussianSolve pivots", () => {
    // [0 1 | 2; 1 0 | 3]
    const m = new Float64Array([0, 1, 2, 1, 0, 3]);
    expect(Array.from(gaussianSolve(m, 2))).toEqual([3, 2]);
  });
});
