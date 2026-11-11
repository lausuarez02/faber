import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { describeRenodeBoard } from "../../lib/renodeBoardSuite.ts";

describeRenodeBoard("arduino-nano-33-ble", { gnd: "GND.1", led: {"key": "led", "pin": "D13", "activeLow": false} });

describe("arduino-nano-33-ble data", () => {
  it("lists 30 pins, each with a description", () => {
    const spec = registry.get("arduino-nano-33-ble")!.spec;
    expect(spec.pins).toHaveLength(30);
    for (const p of spec.pins) expect(p.description?.length ?? 0).toBeGreaterThan(5);
  });
});
