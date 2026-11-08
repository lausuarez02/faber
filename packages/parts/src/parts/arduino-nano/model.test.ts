import { describeAtmega328Board } from "../../lib/boardSuite.ts";
import { registry } from "../../registry.gen.ts";
import { describe, expect, it } from "vitest";

describeAtmega328Board("arduino-nano", "GND.2");

describe("arduino-nano specifics", () => {
  const spec = registry.get("arduino-nano")!.spec;
  it("is a DIP-30: 15 pins per side, rows 0.6 in (120 px) apart", () => {
    expect(spec.pins).toHaveLength(30);
    const xs = new Set(spec.pins.map((p) => p.x));
    expect([...xs].sort((a, b) => a - b)).toEqual([10, 130]);
    expect(spec.pins.filter((p) => p.x === 10)).toHaveLength(15);
  });
  it("has analog-only A6/A7 and the new-bootloader fqbn", () => {
    expect(spec.pins.find((p) => p.id === "A7")!.type).toBe("analog");
    expect(spec.mcu?.fqbn).toBe("arduino:avr:nano:cpu=atmega328");
  });
});
