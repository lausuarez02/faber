// Shared checks for the boards that run on the Renode backend (round 10). Imported by their
// model.test.ts. The part's data must agree with the backend's board data (pin ids, bus pins), and
// the pads behave like 3.3 V CMOS pins. The emulator itself is tested in
// packages/sim-backends/src/renode/boards.integration.test.ts (Docker).
import { describe, expect, it } from "vitest";
import { GROUND, type McuBackend, type PartDefinition, type PinState } from "@faber/sim-core";
import { renodeBoardOf } from "@faber/sim-backends/renode";
import { registry } from "../registry.gen.ts";
import { mount, need } from "./bench.ts";

/** A scripted MCU with the board's own pin ids (what firmware would do with pinMode / digitalWrite). */
export class BoardMcu implements McuBackend {
  readonly cyclesPerSecond: number;
  readonly vcc = 3.3;
  readonly pinIds: readonly string[];
  cycles = 0;
  readonly inputs = new Map<string, number>();
  private pins = new Map<string, PinState>();
  constructor(pinIds: readonly string[], hz = 64_000_000) {
    this.pinIds = pinIds;
    this.cyclesPerSecond = hz;
    for (const p of pinIds) this.pins.set(p, { mode: "input", value: 0 });
  }
  load(): void {}
  reset(): void {}
  step(n: number): void {
    this.cycles += n;
  }
  readPin(id: string): PinState {
    return { ...(this.pins.get(id) ?? { mode: "input", value: 0 }) };
  }
  setPinInput(id: string, volts: number): void {
    this.inputs.set(id, volts);
    const p = this.pins.get(id);
    if (p && p.mode !== "output") p.value = volts > this.vcc / 2 ? 1 : 0;
  }
  drive(id: string, mode: PinState["mode"], value: 0 | 1 = 0): void {
    this.pins.set(id, { mode, value });
  }
  onPinChange() {
    return () => {};
  }
  onSerial() {
    return () => {};
  }
}

export function describeRenodeBoard(id: string, o: { gnd: string; led: { key: string; pin: string; activeLow: boolean } }): void {
  const def: PartDefinition = need(registry.get(id), id);
  const board = renodeBoardOf(id);

  describe(`${id} (Renode board)`, () => {
    it("has board data in the Renode backend with the same clock, and every GPIO pin is a backend pin", () => {
      expect(board, `packages/sim-backends/src/renode/boards.ts has '${id}'`).toBeDefined();
      expect(def.spec.mcu).toMatchObject({ backend: "renode", clockHz: board!.clockHz, vcc: 3.3, fqbn: board!.fqbn });
      for (const p of def.spec.pins.filter((x) => x.type === "digital" || x.type === "analog")) {
        if (/^(NRST|RST)/.test(p.id)) continue;
        expect(board!.pins, `pin ${p.id}`).toHaveProperty(p.id);
      }
    });

    it("tags the default Wire / SPI pins with their protocols, and analog pins reach an ADC channel", () => {
      const has = (pin: string, proto: string) => def.spec.pins.find((p) => p.id === pin)?.protocols?.includes(proto);
      if (board!.i2c) {
        expect(has(board!.i2c.sda, "i2c-sda")).toBe(true);
        expect(has(board!.i2c.scl, "i2c-scl")).toBe(true);
      }
      if (board!.spi) {
        expect(has(board!.spi.mosi, "spi-mosi")).toBe(true);
        expect(has(board!.spi.miso, "spi-miso")).toBe(true);
        expect(has(board!.spi.sck, "spi-sck")).toBe(true);
      }
      for (const p of def.spec.pins.filter((x) => x.protocols?.includes("adc"))) expect(board!.adc, `${p.id} has an ADC channel`).toHaveProperty(p.id);
    });

    it("powers 3.3 V from USB and runs", () => {
      const mcu = new BoardMcu(Object.keys(board!.pins));
      const b = mount(def, { mcu });
      b.solve();
      expect(b.model.visualState()).toMatchObject({ powered: true, running: true });
    });

    it(`drives a pin as an output and lights the on-board LED (${o.led.pin})`, () => {
      const mcu = new BoardMcu(Object.keys(board!.pins));
      const gpio = def.spec.pins.find((p) => p.type === "digital" && board!.pins[p.id] && p.id !== o.led.pin)!;
      mcu.drive(gpio.id, "output", 1);
      mcu.drive(o.led.pin, "output", o.led.activeLow ? 0 : 1);
      const b = mount(def, { mcu, wiring: { [gpio.id]: "out" } });
      b.solve((c) => void c.resistor("out", GROUND, 10_000));
      expect(b.result!.voltage("out")).toBeGreaterThan(3.1);
      expect(b.model.visualState()).toMatchObject({ [o.led.key]: 1, [`pin_${gpio.id}`]: 1 });
    });

    it("feeds input voltages back to the emulator (INPUT_PULLUP + button to GND)", () => {
      const mcu = new BoardMcu(Object.keys(board!.pins));
      const gpio = def.spec.pins.find((p) => p.type === "digital" && board!.pins[p.id])!;
      mcu.drive(gpio.id, "input_pullup", 1);
      const b = mount(def, { mcu, wiring: { [gpio.id]: "in" } });
      b.solve((c) => void c.switch("in", GROUND, false));
      expect(mcu.inputs.get(gpio.id)).toBeGreaterThan(3.2);
      b.solve((c) => void c.switch("in", GROUND, true));
      expect(mcu.inputs.get(gpio.id)).toBeLessThan(0.05);
    });

    it(`has a ground pin '${o.gnd}' and says whether it can be placed`, () => {
      expect(def.spec.pins.find((p) => p.id === o.gnd)?.type).toBe("ground");
      expect(def.spec.availability?.reason.length ?? 0).toBeGreaterThan(10);
    });
  });
}
