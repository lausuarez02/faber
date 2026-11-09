import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { describeRp2040Board } from "../raspberry-pi-pico/rp2040-board-suite.ts";

describeRp2040Board("waveshare-rp2040-zero", { gnd: "GND.1" });

describe("waveshare-rp2040-zero specifics", () => {
  const spec = registry.get("waveshare-rp2040-zero")!.spec;
  it("has 23 edge pins: 9 per long side and GP9-GP13 on the short edge", () => {
    expect(spec.pins).toHaveLength(23);
    const bottom = spec.pins.filter((p) => p.y === 178).map((p) => p.id);
    expect(bottom).toEqual(["GP13", "GP12", "GP11", "GP10", "GP9"]);
  });
});
