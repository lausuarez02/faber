// Like fidelity.crosscheck.test.ts for AVR: every rp2040js board's fidelity.json and pins are
// checked against what @jumper/sim-backends actually does, so the card people read cannot drift.
import { describe, expect, it } from "vitest";
import { RP2040_BACKEND_FACTS, RP2040_BOARDS, ROM_FUNCTION_NAMES, type Rp2040BoardType } from "@jumper/sim-backends";
import { partDefinitions } from "./index.ts";

const NAMES: Record<keyof typeof RP2040_BACKEND_FACTS.peripherals, RegExp> = {
  gpio: /\bGPIO\b/,
  pwm: /\bPWM\b/,
  adc: /\bADC\b/,
  uart: /\b(UART|Serial1)\b/,
  i2c: /\b(I2C|Wire)\b/,
  spi: /\bSPI\b/,
  pio: /\bPIO\b/,
  usb: /\bUSB serial\b/,
  timers: /\btimers?\b/i,
  dma: /\bDMA\b/,
  core1: /\b(core 1|second core)\b/i,
};

const boards = partDefinitions.filter((d) => d.spec.mcu?.backend === "rp2040js");

describe("RP2040 board fidelity matches the rp2040js backend", () => {
  it("covers the three RP2040 boards", () => {
    expect(boards.map((d) => d.spec.id).sort()).toEqual(Object.keys(RP2040_BOARDS).sort());
  });

  for (const def of boards) {
    const f = def.fidelity;
    const positive = [...Object.values(f.areas).map((a) => a.note), ...f.emulates].join("\n");
    describe(def.spec.id, () => {
      it("states the 0.8 V / 2.0 V thresholds and the 12-bit ADC the backend uses", () => {
        const { low, high } = RP2040_BACKEND_FACTS.inputThresholds;
        expect(f.areas.analog.note).toContain(`${low} V`);
        expect(f.areas.analog.note).toContain(`${high.toFixed(1)} V`);
        expect(f.areas.analog.note).toMatch(/keep their last level/);
        expect(f.areas.analog.note).toContain(`${RP2040_BACKEND_FACTS.adc.bits}-bit`);
      });

      for (const [name, emulated] of Object.entries(RP2040_BACKEND_FACTS.peripherals)) {
        const re = NAMES[name as keyof typeof NAMES];
        if (emulated) {
          it(`claims ${name} works and never lists it as missing`, () => {
            expect(positive).toMatch(re);
            // Partial gaps may name it ("Target (slave) mode … Wire.begin(address)"), but no entry
            // may start with it, i.e. say the peripheral itself is missing.
            const head = new RegExp(`^(the )?${re.source}`, "i");
            for (const s of f.doesNotEmulate) expect(s, s).not.toMatch(head);
          });
        } else {
          it(`lists ${name} under doesNotEmulate`, () => {
            expect(f.doesNotEmulate.some((s) => re.test(s))).toBe(true);
          });
        }
      }

      it("says the boot ROM is Jumper's own and that transcendental maths may differ", () => {
        expect(ROM_FUNCTION_NAMES).toEqual(expect.arrayContaining(["fsin", "dsin", "memcpy", "flash_range_erase"]));
        expect(f.areas.logic.note).toMatch(/not Raspberry Pi's ROM code/);
        expect(f.doesNotEmulate.join("\n")).toMatch(/last bit/);
      });

      it("names the board's LEDs exactly as the backend knows them", () => {
        const b = RP2040_BOARDS[def.spec.id as Rp2040BoardType];
        for (const led of b.leds) expect(positive, led.key).toMatch(new RegExp(`GP${led.gpio}\\b`));
      });
    });
  }
});
