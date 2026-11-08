import { describeAtmega328Board } from "../../lib/boardSuite.ts";
import { registry } from "../../registry.gen.ts";
import { describe, expect, it } from "vitest";

describeAtmega328Board("arduino-uno", "GND.1");

describe("arduino-uno specifics", () => {
  const spec = registry.get("arduino-uno")!.spec;
  it("has the three GND pins and IOREF of the R3 headers, and the pin ids the Blink example uses", () => {
    expect(spec.pins.filter((p) => p.type === "ground").map((p) => p.id)).toEqual(["GND.1", "GND.2", "GND.3"]);
    expect(spec.pins.map((p) => p.id)).toEqual(expect.arrayContaining(["IOREF", "RESET", "D13"]));
    expect(spec.mcu?.fqbn).toBe("arduino:avr:uno");
  });
  it("puts the digital header on top at 0.1 in pitch (D0 rightmost)", () => {
    const at = (id: string) => spec.pins.find((p) => p.id === id)!;
    expect(at("D0").y).toBe(at("D13").y);
    expect(at("D0").x - at("D1").x).toBe(20);
    expect(at("A0").y).toBeGreaterThan(at("D0").y);
  });
});
