import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { describeRp2040Board } from "./rp2040-board-suite.ts";

describeRp2040Board("raspberry-pi-pico", { gnd: "GND.1", led: { key: "led", pin: "GP25", activeLow: false } });

describe("raspberry-pi-pico specifics", () => {
  const spec = registry.get("raspberry-pi-pico")!.spec;
  it("is the 40-pin module: 2 × 20 pins, rows 0.7 in (140 px) apart, pin 1 = GP0, pin 40 = VBUS", () => {
    expect(spec.pins).toHaveLength(40);
    expect([...new Set(spec.pins.map((p) => p.x))].sort((a, b) => a - b)).toEqual([13, 153]);
    const at = (id: string) => spec.pins.find((p) => p.id === id)!;
    expect(at("GP0")).toMatchObject({ x: 13, y: 11 });
    expect(at("VBUS")).toMatchObject({ x: 153, y: 11 });
    expect(at("GP16")).toMatchObject({ x: 153, y: 391 });
    expect(spec.pins.map((p) => p.id)).toEqual(expect.arrayContaining(["VSYS", "3V3_EN", "ADC_VREF", "AGND", "RUN"]));
  });
});
