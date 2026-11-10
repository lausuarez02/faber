import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { describeRp2040Board } from "../raspberry-pi-pico/rp2040-board-suite.ts";

describeRp2040Board("seeed-xiao-rp2040", { gnd: "GND.1", led: { key: "led_r", pin: "GP17", activeLow: true } });

describe("seeed-xiao-rp2040 specifics", () => {
  const spec = registry.get("seeed-xiao-rp2040")!.spec;
  it("has 14 pins with the silkscreen names as labels (D0/A0 = GP26 … D10/MOSI = GP3)", () => {
    expect(spec.pins).toHaveLength(14);
    const label = (id: string) => spec.pins.find((p) => p.id === id)!.label;
    expect(label("GP26")).toBe("D0/A0");
    expect(label("GP6")).toBe("D4/SDA");
    expect(label("GP7")).toBe("D5/SCL");
    expect(label("GP3")).toBe("D10/MOSI");
    expect(label("VBUS")).toBe("5V");
  });
});
