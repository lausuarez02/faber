import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { parseProject } from "@faber/project-format";
import { Simulation } from "@faber/sim-core";
import { renodeBoardOf } from "@faber/sim-backends/renode";
import { BoardMcu, describeRenodeBoard } from "../../lib/renodeBoardSuite.ts";

describeRenodeBoard("seeed-xiao-nrf52840", { gnd: "GND.1", led: {"key": "led_r", "pin": "LED_RED", "activeLow": true} });

describe("seeed-xiao-nrf52840 data", () => {
  it("lists 16 pins, each with a description", () => {
    const spec = registry.get("seeed-xiao-nrf52840")!.spec;
    expect(spec.pins).toHaveLength(16);
    for (const p of spec.pins) expect(p.description?.length ?? 0).toBeGreaterThan(5);
  });
});

describe("seeed-xiao-nrf52840 built-in charger (BQ25101)", () => {
  const make = (usb: boolean, soc: number) =>
    parseProject({
      format: "faber/1",
      name: "xiao-lipo",
      parts: [
        { id: "board", type: "seeed-xiao-nrf52840", x: 0, y: 0 },
        { id: "cell", type: "lipo-battery", x: 0, y: 0, props: { capacity: 250, soc } },
      ],
      wires: [
        { id: "w1", from: { part: "cell", pin: "POS" }, to: { part: "board", pin: "BAT+" } },
        { id: "w2", from: { part: "cell", pin: "NEG" }, to: { part: "board", pin: "BAT-" } },
      ],
      firmware: { board: "board", artifact: "firmware/none.hex" },
      power: { usb },
    });

  it("charges a LiPo on BAT+ from USB at 50 mA, pulls ~CHG (P0.13 floating) LOW, and lights the charge LED", () => {
    const mcu = new BoardMcu(Object.keys(renodeBoardOf("seeed-xiao-nrf52840")!.pins));
    const sim = new Simulation({ project: make(true, 40), registry, backendFactory: () => mcu, firmware: "" });
    sim.solve();
    const st = sim.partState("board")!;
    expect(st.charging).toBe(1);
    expect(Number(st.chargemA)).toBeGreaterThan(45);
    expect(Number(st.chargemA)).toBeLessThan(55);
    expect(mcu.inputs.get("CHG")).toBe(0);
    mcu.drive("HICHG", "output", 0); // HICHG LOW: 100 mA
    sim.solve();
    sim.solve();
    expect(Number(sim.partState("board")!.chargemA)).toBeGreaterThan(90);
  });

  it("runs from the LiPo with USB unplugged, and P0.31 reads VBAT x 510k / 1510k while P0.14 is LOW", () => {
    const mcu = new BoardMcu(Object.keys(renodeBoardOf("seeed-xiao-nrf52840")!.pins));
    const sim = new Simulation({ project: make(false, 80), registry, backendFactory: () => mcu, firmware: "" });
    mcu.drive("VBAT_ENABLE", "output", 0);
    sim.solve();
    const st = sim.partState("board")!;
    expect(st.powered).toBe(true);
    expect(String(st.battery)).toMatch(/^on battery [34]\.\d\d V$/);
    const vbat = sim.pinVoltage("board", "BAT+");
    expect(mcu.inputs.get("VBAT")).toBeCloseTo((vbat * 510) / 1510, 2);
    expect(mcu.inputs.get("CHG")).toBeCloseTo(3.3, 3);
  });
});
