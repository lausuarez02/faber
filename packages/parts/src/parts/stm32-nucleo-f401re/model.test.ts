import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { describeRenodeBoard } from "../../lib/renodeBoardSuite.ts";

describeRenodeBoard("stm32-nucleo-f401re", { gnd: "GND.1", led: {"key": "led", "pin": "PA5", "activeLow": false} });

describe("stm32-nucleo-f401re data", () => {
  it("lists 29 pins, each with a description", () => {
    const spec = registry.get("stm32-nucleo-f401re")!.spec;
    expect(spec.pins).toHaveLength(29);
    for (const p of spec.pins) expect(p.description?.length ?? 0).toBeGreaterThan(5);
  });
});
