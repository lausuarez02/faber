// Shared datasheet-style checks for the RP2040 boards. Imported by their model.test.ts.
import { describe, expect, it } from "vitest";
import { parseProject } from "@jumper/project-format";
import { GROUND, Simulation, type McuBackend, type PartDefinition, type PinState } from "@jumper/sim-core";
import { RP2040_BOARDS, type Rp2040BoardType } from "@jumper/sim-backends";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

/** A scripted RP2040 (pins GP0..GP29, 3.3 V) for model tests without firmware. */
export class ScriptedRp2040 implements McuBackend {
  readonly cyclesPerSecond = 125_000_000;
  readonly vcc = 3.3;
  readonly pinIds: readonly string[] = Array.from({ length: 30 }, (_, i) => `GP${i}`);
  cycles = 0;
  readonly inputs = new Map<string, number>();
  private pins = new Map<string, PinState>(this.pinIds.map((p) => [p, { mode: "input", value: 0 }]));
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
    if (p && p.mode !== "output") p.value = volts >= 2 ? 1 : 0;
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

export function describeRp2040Board(id: Rp2040BoardType, opts: { gnd: string; led?: { key: string; pin: string; activeLow: boolean } }): void {
  const def: PartDefinition = need(registry.get(id), id);
  const board = RP2040_BOARDS[id];

  describe(id, () => {
    it("declares the rp2040js backend, its FQBN, 3.3 V, and the physical data plan_device needs", () => {
      expect(def.spec.mcu).toEqual({ backend: "rp2040js", chip: "rp2040", clockHz: 125_000_000, vcc: 3.3, fqbn: board.fqbn });
      expect(def.spec.dimensions_mm).toBeDefined();
      expect(def.spec.mass_g).toBeGreaterThan(0);
      expect(def.spec.current_ma!.typ).toBeGreaterThan(0);
      expect(def.spec.price_usd).toBeGreaterThan(0);
      expect(def.spec.buy_links!.length).toBeGreaterThan(0);
      expect(def.spec.limits).toMatchObject({ maxCurrentmA: 12, max3v3mA: 300 });
    });

    it("exposes exactly the header GPIOs as GP<n> pins, 3.3 V max, PWM everywhere, ADC on GP26-GP29", () => {
      const gpios = def.spec.pins.filter((p) => /^GP\d+$/.test(p.id));
      expect(gpios.map((p) => Number(p.id.slice(2))).sort((a, b) => a - b)).toEqual([...board.headerGpios].sort((a, b) => a - b));
      for (const p of gpios) {
        expect(p.voltage, p.id).toEqual({ min: 0, max: 3.3 });
        expect(p.protocols, p.id).toContain("pwm");
        expect(p.protocols!.includes("adc"), p.id).toBe(Number(p.id.slice(2)) >= 26);
        expect(p.description, p.id).toMatch(/NOT 5 V tolerant/);
      }
      for (const power of ["VBUS", "3V3"]) expect(def.spec.pins.find((p) => p.id === power)?.type, power).toBe("power");
      expect(def.spec.pins.filter((p) => p.type === "ground").length).toBeGreaterThanOrEqual(1);
    });

    it("tags arduino-pico's default Wire / SPI / Serial1 pins, matching the backend", () => {
      const tagged = (proto: string) => def.spec.pins.filter((p) => p.protocols?.includes(proto)).map((p) => p.id);
      expect(tagged("i2c-sda")).toEqual([board.bus.i2c.sda]);
      expect(tagged("i2c-scl")).toEqual([board.bus.i2c.scl]);
      expect(tagged("spi-sck")).toEqual([board.bus.spi.sck]);
      expect(tagged("spi-mosi")).toEqual([board.bus.spi.mosi]);
      expect(tagged("spi-miso")).toEqual([board.bus.spi.miso]);
      expect(tagged("uart-tx")).toEqual([board.uart.tx]);
      expect(tagged("uart-rx")).toEqual([board.uart.rx]);
    });

    it("powers VBUS at 5 V and 3V3 at 3.3 V", () => {
      const b = mount(def);
      const r = b.solve();
      expect(r.voltage(b.ctx.node("VBUS"))).toBeCloseTo(5, 3);
      expect(r.voltage(b.ctx.node("3V3"))).toBeCloseTo(3.3, 3);
      expect(b.model.visualState()).toMatchObject({ powered: true, running: false });
    });

    it("drives an LED + 220 Ω at ~4.5 mA from a 3.3 V pin (50 Ω pad)", () => {
      const mcu = new ScriptedRp2040();
      mcu.drive("GP26", "output", 1);
      const led = mount(need(registry.get("led"), "led"), { id: "led1", wiring: { A: "a", C: GROUND } });
      const res = mount(need(registry.get("resistor"), "resistor"), { id: "r1", wiring: { "1": "p", "2": "a" } });
      const b = mount(def, { mcu, wiring: { GP26: "p" } });
      b.solve((c) => {
        res.model.stamp(c);
        led.model.stamp(c);
      });
      const mA = b.result!.current("d") * 1000;
      expect(mA).toBeGreaterThan(3.5);
      expect(mA).toBeLessThan(5.5);
      expect(b.result!.voltage("p")).toBeGreaterThan(3);
      expect(b.model.diagnostics!()).toEqual([]);
    });

    it("feeds INPUT_PULLUP (50 kΩ) back to the MCU: 3.3 V open, ~0 V with a button to GND", () => {
      const mcu = new ScriptedRp2040();
      mcu.drive("GP26", "input_pullup", 1);
      const b = mount(def, { mcu, wiring: { GP26: "in" } });
      b.solve((c) => void c.switch("in", GROUND, false));
      expect(mcu.inputs.get("GP26")).toBeCloseTo(3.3, 3);
      b.solve((c) => void c.switch("in", GROUND, true));
      expect(mcu.inputs.get("GP26")).toBeLessThan(0.01);
    });

    it("flags an LED wired straight to a pin (over 12 mA)", () => {
      const mcu = new ScriptedRp2040();
      mcu.drive("GP26", "output", 1);
      const b = mount(def, { mcu, wiring: { GP26: "p" } });
      b.solve((c) => void c.led("p", GROUND, { vf: 2, rOn: 5 }));
      expect(b.model.diagnostics!()).toMatchObject([{ severity: "error", code: "gpio-overcurrent", pin: "GP26" }]);
    });

    if (opts.led) {
      const led = opts.led;
      it(`lights the on-board LED '${led.key}' from ${led.pin} (${led.activeLow ? "active low" : "active high"})`, () => {
        const mcu = new ScriptedRp2040();
        mcu.drive(led.pin, "output", led.activeLow ? 0 : 1);
        const b = mount(def, { mcu });
        b.solve();
        expect(b.model.visualState()[led.key]).toBe(1);
        mcu.drive(led.pin, "output", led.activeLow ? 1 : 0);
        b.solve();
        expect(b.model.visualState()[led.key]).toBe(0);
      });
    }

    it("runs inside a Simulation with the parts registry", () => {
      const project = parseProject({
        format: "jumper/1",
        name: "rp2040-check",
        parts: [
          { id: "board", type: id, x: 0, y: 0 },
          { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 220 } },
          { id: "led1", type: "led", x: 0, y: 0 },
        ],
        wires: [
          { id: "w1", from: { part: "board", pin: "GP26" }, to: { part: "r1", pin: "1" } },
          { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" } },
          { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "board", pin: opts.gnd } },
        ],
        firmware: { board: "board", artifact: "firmware/none.hex" },
      });
      const mcu = new ScriptedRp2040();
      const sim = new Simulation({ project, registry, backendFactory: () => mcu, firmware: "" });
      expect(sim.diagnostics()).toEqual([]);
      mcu.drive("GP26", "output", 1);
      sim.solve();
      expect(sim.partState("led1")!.on).toBe(true);
      expect(sim.partState("board")).toMatchObject({ running: true, pin_GP26: 1 });
    });
  });
}
