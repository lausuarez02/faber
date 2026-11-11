import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { describeRenodeBoard } from "../../lib/renodeBoardSuite.ts";

describeRenodeBoard("stm32-bluepill", { gnd: "GND.1", led: {"key": "led", "pin": "PC13", "activeLow": true} });

describe("stm32-bluepill data", () => {
  it("lists 40 pins, each with a description", () => {
    const spec = registry.get("stm32-bluepill")!.spec;
    expect(spec.pins).toHaveLength(40);
    for (const p of spec.pins) expect(p.description?.length ?? 0).toBeGreaterThan(5);
  });
});
