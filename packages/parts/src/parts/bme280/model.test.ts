import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { i2cWires, serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { Bme280, compH, compP, compT, rawFor, tFine } from "./model.ts";

const def = need(registry.get("bme280"), "bme280");

describe("bme280: compensation", () => {
  it("matches the datasheet's worked example for temperature", () => {
    // BMP280/BME280 datasheet example: adc_T = 519888 with the example calibration → 25.08 °C
    expect(compT(519888)).toBe(2508);
    // t_fine is 128422.29 in the datasheet's float example; Adafruit's division form gives 128423
    // (the shift form 128422): C division truncates toward zero for the negative T3 term.
    expect(tFine(519888)).toBe(128423);
    // and adc_P = 415148 → 100653.27 Pa
    expect(compP(415148, 128422) / 256).toBeCloseTo(100653.27, 0);
  });

  it("inverts the formulas for any target in range", () => {
    for (const [t, p, h] of [[22.5, 1013.25, 45], [-10, 900, 5], [40.25, 1050, 95.5], [0, 300, 0], [85, 1100, 100]] as const) {
      const r = rawFor(t, p * 100, h);
      const tf = tFine(r.t);
      expect(compT(r.t) / 100).toBeCloseTo(t, 2);
      expect(compP(r.p, tf) / 25600).toBeCloseTo(p, 1);
      expect(compH(r.h, tf) / 1024).toBeCloseTo(h, 1);
    }
  });
});

describe("bme280: registers", () => {
  const regRead = (chip: Bme280, reg: number, n: number) => {
    chip.connect(false);
    chip.write(reg);
    chip.connect(true);
    return Array.from({ length: n }, () => chip.read());
  };

  it("chip id, reset values and skipped measurements", () => {
    const chip = new Bme280();
    expect(regRead(chip, 0xd0, 1)).toEqual([0x60]);
    expect(regRead(chip, 0xf7, 8)).toEqual([0x80, 0, 0, 0x80, 0, 0, 0x80, 0]);
    expect(chip.mode).toBe("sleep");
  });

  it("forced mode measures once and returns to sleep", () => {
    const chip = new Bme280();
    chip.connect(false);
    chip.write(0xf2);
    chip.write(0x01);
    chip.write(0xf4);
    chip.write(0b001_001_01);
    expect(chip.mode).toBe("sleep");
    const d = regRead(chip, 0xf7, 8);
    const adcT = (d[3]! << 12) | (d[4]! << 4) | (d[5]! >> 4);
    expect(compT(adcT)).toBe(2250);
  });

  it("does not answer without power", () => {
    const b = mount(def, { id: "bme" });
    b.solve();
    expect(b.model.i2c!.i2cConnect(false, false)).toBe(false);
    expect(b.model.diagnostics!()[0]!.code).toBe("i2c-module-unpowered");
  });

  it("visual state follows the props", () => {
    const b = mount(def, { id: "bme", wiring: { VIN: "v", GND: GROUND } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    b.setProp("temperature", 31.4);
    b.interact({ kind: "set", key: "humidity", value: 60 });
    const v = b.model.visualState();
    expect(v).toMatchObject({ temperature: 31.4, label: "31.4°C 60%" });
    expect(v.humidity).toBeCloseTo(60, 1);
  });
});

describe("bme280: real firmware (Adafruit_BME280)", { timeout: 120_000 }, () => {
  it("reads back the values set on the part, and follows changes", () => {
    const sim = unoBench({
      parts: [{ id: "bme", type: "bme280", x: 0, y: 0, props: { temperature: 23.7, humidity: 51.5, pressure: 1002.4 } }],
      wires: i2cWires("bme", { gnd: "GND", vcc: "VIN", sda: "SDA", scl: "SCL" }),
      hex: "./example.hex",
      base: import.meta.url,
    });
    sim.runFor(700);
    const parse = (l: string) => l.match(/^T=(-?[\d.]+) P=([\d.]+) H=([\d.]+)$/)!.slice(1).map(Number);
    const [t, p, h] = parse(serialLines(sim)[0]!);
    expect(t).toBeCloseTo(23.7, 2);
    expect(p).toBeCloseTo(1002.4, 1);
    expect(h).toBeCloseTo(51.5, 1);
    sim.setProp("bme", "temperature", -5.5);
    sim.runFor(600);
    expect(parse(serialLines(sim).at(-1)!)[0]).toBeCloseTo(-5.5, 2);
  });

  it("reports a sensor at the other address", () => {
    const sim = unoBench({
      parts: [{ id: "bme", type: "bme280", x: 0, y: 0, props: { address: "0x77" } }],
      wires: i2cWires("bme", { gnd: "GND", vcc: "VIN", sda: "SDA", scl: "SCL" }),
      hex: "./example.hex",
      base: import.meta.url,
    });
    sim.runFor(300);
    expect(serialLines(sim)[0]).toBe("BME280 not found at 0x76: check wiring and address");
  });
});
