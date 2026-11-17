// Shared datasheet-style checks for the ESP32-family boards (round 10). Imported by their model.test.ts.
import { describe, expect, it } from "vitest";
import { GROUND, PartSpecSchema, type McuBackend, type PartDefinition, type PinState } from "@fabwright/sim-core";
import { registry } from "../registry.gen.ts";
import { mount, need } from "./bench.ts";
import { ESP_PULL_OHMS } from "./espBoard.ts";

/** A scriptable ESP-like MCU: GPIO<n> pins at 3.3 V. */
class EspMcu implements McuBackend {
  readonly cyclesPerSecond = 240_000_000;
  readonly vcc = 3.3;
  readonly kind = "process" as const;
  cycles = 0;
  readonly inputs = new Map<string, number>();
  private pins: Map<string, PinState>;
  constructor(readonly pinIds: readonly string[]) {
    this.pins = new Map(pinIds.map((p) => [p, { mode: "input", value: 0 }]));
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
  onPinChange(): () => void {
    return () => {};
  }
  onSerial(): () => void {
    return () => {};
  }
}

export interface EspBoardSuiteOptions {
  gnd: string;
  led?: { key: string; pin: string; activeLow: boolean };
  /** The board has a Li-ion charger on its BAT pad: fast-charge current (mA). */
  charger?: { mA: number };
}

export function describeEspBoard(id: string, opts: EspBoardSuiteOptions): void {
  const def: PartDefinition = need(registry.get(id), id);
  const spec = def.spec;
  const gpios = spec.pins.filter((p) => /^GPIO\d+$/.test(p.id)).map((p) => p.id);
  const mcu = () => new EspMcu(gpios);

  describe(`${id} (ESP32 family)`, () => {
    it("is a qemu-esp board described as data: chip, clock, flash, bus pins, toolchain and its fixture test", () => {
      expect(PartSpecSchema.parse(spec).mcu?.backend).toBe("qemu-esp");
      const m = spec.mcu!;
      expect(["esp32", "esp32s3", "esp32c3"]).toContain(m.chip);
      expect(m.vcc).toBe(3.3);
      expect(m.fqbn).toMatch(/^esp32:esp32:/);
      expect(m.toolchain?.simFqbn ?? m.fqbn).toMatch(/FlashMode=dio/);
      expect(m.flash?.sizeMB).toBeGreaterThanOrEqual(4);
      expect(m.verified).toMatch(/boards\.integration\.test\.ts/);
      const ids = new Set(spec.pins.map((p) => p.id));
      for (const bus of Object.values(m.busPins ?? {})) for (const pin of Object.values(bus ?? {})) expect(ids, `bus pin ${pin}`).toContain(pin);
      for (const s of m.strapping ?? []) expect(ids, `strapping pin ${s.pin}`).toContain(s.pin);
      for (const p of [...(m.inputOnly ?? []), ...(m.adc2 ?? []), ...(m.reserved ?? []).map((r) => r.pin)]) expect(ids, p).toContain(p);
      for (const p of ["5V", "3V3"]) expect(spec.pins.find((x) => x.id === p)?.type, p).toBe("power");
      for (const g of gpios) expect(spec.pins.find((x) => x.id === g)!.voltage?.max, g).toBe(3.3);
    });

    it("has physical data for cases and the factory pack", () => {
      expect(spec.dimensions_mm).toBeDefined();
      expect(spec.mass_g).toBeGreaterThan(0);
      expect(spec.current_ma?.typ).toBeGreaterThan(0);
      expect(spec.price_usd).toBeGreaterThan(0);
      expect(spec.buy_links?.length).toBeGreaterThan(0);
      expect(spec.mechanical?.features?.some((f) => f.kind === "connector")).toBe(true);
      expect(spec.sourcing?.generic).toBeTruthy();
    });

    it("makes 3.3 V from USB and holds the firmware in reset without power", () => {
      const b = mount(def);
      const r = b.solve();
      expect(r.voltage(b.ctx.node("5V"))).toBeCloseTo(5, 1);
      expect(r.voltage(b.ctx.node("3V3"))).toBeCloseTo(3.3, 2);
      expect(b.model.visualState()).toMatchObject({ powered: true });
      const off = mount(def, { power: { usb: false } });
      off.solve();
      expect(off.model.visualState()).toMatchObject({ powered: false });
    });

    it("drives an output through ~30 Ω and reads INPUT_PULLUP / INPUT_PULLDOWN with 45 kΩ", () => {
      const m = mcu();
      const out = gpios[gpios.length - 1]!;
      const pin = gpios[0]!;
      m.drive(out, "output", 1);
      m.drive(pin, "input_pullup", 1);
      const b = mount(def, { mcu: m, wiring: { [out]: "o", [pin]: "p" } });
      b.solve((c) => void c.switch("p", GROUND, false));
      expect(b.result!.voltage("o")).toBeCloseTo(3.3, 1);
      expect(m.inputs.get(pin)).toBeCloseTo(3.3, 1);
      b.solve((c) => void c.switch("p", GROUND, true));
      expect(m.inputs.get(pin)).toBeLessThan(0.01);
      m.drive(pin, "input_pulldown", 0);
      b.solve((c) => {
        c.resistor("p", "rail", ESP_PULL_OHMS, { id: "ext" });
        c.voltageSource("rail", GROUND, 3.3, 0.01, { id: "rail" });
      });
      expect(m.inputs.get(pin)).toBeCloseTo(1.65, 1);
    });

    if (opts.led) {
      const led = opts.led;
      it(`lights its on-board LED (${led.pin}, active ${led.activeLow ? "low" : "high"})`, () => {
        const m = mcu();
        m.drive(led.pin, "output", led.activeLow ? 0 : 1);
        const b = mount(def, { mcu: m });
        b.solve();
        expect(b.model.visualState()[led.key]).toBe(1);
        m.drive(led.pin, "output", led.activeLow ? 1 : 0);
        b.solve();
        expect(b.model.visualState()[led.key]).toBe(0);
      });
    }

    if (opts.charger) {
      const ch = opts.charger;
      it(`charges a cell on BAT from USB at ${ch.mA} mA and runs from it without USB`, () => {
        // A 3.7 V cell with 0.15 Ω inside, on the BAT pad.
        const b = mount(def, { wiring: { BAT: "bat" } });
        b.solve((c) => void c.voltageSource("bat", GROUND, 3.7, 0.15, { id: "cell" }));
        b.solve();
        const s = b.model.visualState();
        expect(s.charging).toBe(true);
        expect(s.chargeMode).toBe("CC");
        expect(Number(s.chargemA)).toBeCloseTo(ch.mA, 0);
        // The cell never feeds USB back, and the LDO runs from USB while it is plugged.
        expect(b.result!.voltage(b.ctx.node("3V3"))).toBeCloseTo(3.3, 2);
        const off = mount(def, { power: { usb: false }, wiring: { BAT: "bat" } });
        off.solve((c) => void c.voltageSource("bat", GROUND, 3.9, 0.15, { id: "cell" }));
        off.solve();
        expect(off.model.visualState()).toMatchObject({ powered: true, charging: false });
        expect(off.result!.voltage(off.ctx.node("3V3"))).toBeGreaterThan(3.2);
        expect(off.result!.voltage(off.ctx.node("5V"))).toBeLessThan(0.5);
      });

      it("does not charge with no cell on BAT", () => {
        const b = mount(def);
        b.solve();
        b.solve();
        expect(b.model.visualState()).toMatchObject({ charging: false });
      });
    }
  });
}
