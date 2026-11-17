// Shared datasheet-style checks for ATmega328P boards (Uno, Nano). Imported by their model.test.ts.
import { describe, expect, it } from "vitest";
import { parseProject } from "@faber/project-format";
import { GROUND, Simulation, type PartDefinition } from "@faber/sim-core";
import { registry } from "../registry.gen.ts";
import { mount, need, ScriptedMcu } from "./bench.ts";

const ARDUINO_GPIO = [...Array.from({ length: 14 }, (_, i) => `D${i}`), ...Array.from({ length: 6 }, (_, i) => `A${i}`)];

export function describeAtmega328Board(id: string, gnd: string): void {
  const def: PartDefinition = need(registry.get(id), id);

  describe(id, () => {
    it("exposes every Arduino GPIO with its Arduino id, plus 5V, 3V3, VIN, AREF, RESET and GND", () => {
      const ids = new Set(def.spec.pins.map((p) => p.id));
      for (const g of ARDUINO_GPIO) expect(ids, g).toContain(g);
      for (const p of ["5V", "3V3", "VIN", "AREF"]) expect(ids).toContain(p);
      expect([...ids].some((p) => p.startsWith("RESET"))).toBe(true);
      expect(def.spec.pins.filter((p) => p.type === "ground").length).toBeGreaterThanOrEqual(2);
      expect(def.spec.mcu).toMatchObject({ backend: "avr8js", chip: "atmega328p", clockHz: 16_000_000, vcc: 5 });
      for (const p of ["D3", "D5", "D6", "D9", "D10", "D11"]) expect(def.spec.pins.find((x) => x.id === p)!.protocols).toContain("pwm");
    });

    it("powers the 5 V and 3.3 V rails", () => {
      const b = mount(def);
      const r = b.solve();
      expect(r.voltage(b.ctx.node("5V"))).toBeCloseTo(5, 3);
      expect(r.voltage(b.ctx.node("3V3"))).toBeCloseTo(3.3, 3);
      expect(b.model.visualState()).toMatchObject({ powered: true, running: false, led_l: 0 });
    });

    it("drives D13 HIGH through 25 Ω: L LED on, external LED + 220 Ω at ~12 mA", () => {
      const mcu = new ScriptedMcu();
      mcu.drive("D13", "output", 1);
      const led = mount(need(registry.get("led"), "led"), { id: "led1", wiring: { A: "a", C: GROUND } });
      const res = mount(need(registry.get("resistor"), "resistor"), { id: "r1", wiring: { "1": "d13", "2": "a" } });
      const board = mount(def, { mcu, wiring: { D13: "d13" } });
      board.solve((c) => {
        res.model.stamp(c);
        led.model.stamp(c);
      });
      // re-read the LED through its own (unscoped) element id
      const mA = board.result!.current("d") * 1000;
      expect(mA).toBeGreaterThan(11);
      expect(mA).toBeLessThan(13);
      expect(board.result!.voltage("d13")).toBeGreaterThan(4.6);
      expect(board.model.visualState()).toMatchObject({ running: true, led_l: 1, pin_D13: 1 });
      expect(board.model.diagnostics!()).toEqual([]);
      mcu.drive("D13", "output", 0);
      board.solve();
      expect(board.model.visualState().led_l).toBe(0);
    });

    it("feeds input voltages back to the MCU (INPUT_PULLUP + button to GND)", () => {
      const mcu = new ScriptedMcu();
      mcu.drive("D2", "input_pullup", 1);
      const board = mount(def, { mcu, wiring: { D2: "d2" } });
      board.solve((c) => void c.switch("d2", GROUND, false));
      expect(mcu.inputs.get("D2")).toBeCloseTo(5, 3);
      expect(mcu.readPin("D2").value).toBe(1);
      board.solve((c) => void c.switch("d2", GROUND, true));
      expect(mcu.inputs.get("D2")).toBeLessThan(0.01);
      expect(mcu.readPin("D2").value).toBe(0);
    });

    it("flags an LED wired straight to a pin (100 mA > 40 mA)", () => {
      const mcu = new ScriptedMcu();
      mcu.drive("D9", "output", 1);
      const board = mount(def, { mcu, wiring: { D9: "d9" } });
      board.solve((c) => void c.led("d9", GROUND, { vf: 2, rOn: 5 }));
      expect(board.model.diagnostics!()).toMatchObject([{ severity: "error", code: "gpio-overcurrent", pin: "D9" }]);
    });

    it("runs inside a Simulation with the parts registry", () => {
      const project = parseProject({
        format: "faber/1",
        name: "blink-check",
        parts: [
          { id: "board", type: id, x: 0, y: 0 },
          { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 220 } },
          { id: "led1", type: "led", x: 0, y: 0 },
        ],
        wires: [
          { id: "w1", from: { part: "board", pin: "D13" }, to: { part: "r1", pin: "1" } },
          { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" } },
          { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "board", pin: gnd } },
        ],
        firmware: { board: "board", artifact: "firmware/none.hex" },
      });
      const mcu = new ScriptedMcu();
      const sim = new Simulation({ project, registry, backendFactory: () => mcu, firmware: "" });
      expect(sim.diagnostics()).toEqual([]);
      expect(sim.partState("led1")).toMatchObject({ on: false });
      mcu.drive("D13", "output", 1);
      sim.solve();
      expect(sim.partState("led1")!.on).toBe(true);
      expect(sim.partState("board")).toMatchObject({ led_l: 1, running: true });
      expect(sim.pinVoltage("led1", "A")).toBeGreaterThan(2);
    });
  });
}
