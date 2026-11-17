// The fidelity card is what people read to decide whether to trust the simulator. For every
// board that runs on the AVR backend, check its fidelity.json and pin descriptions against what
// @faber/sim-backends actually does (AVR_BACKEND_FACTS and the pin map), so they cannot drift.
import { describe, expect, it } from "vitest";
import { AVR_BACKEND_FACTS, boardPinMap, boardTypeOf } from "@faber/sim-backends";
import { partDefinitions } from "./index.ts";

const PERIPHERAL_NAMES: Record<keyof typeof AVR_BACKEND_FACTS.peripherals, RegExp> = {
  gpio: /\bGPIO\b/i,
  timers: /\btimers?\b(?! modes)/i, // "some timer modes" are a known partial gap, not a missing peripheral
  usart: /\b(USART|UART)\b/i,
  adc: /\bADC\b/i,
  watchdog: /\bwatchdog\b/i,
  spi: /\bSPI\b/,
  twi: /\b(TWI|I2C)\b/,
};
/** A clause that says something is missing. */
const NEGATIVE = /\b(not|no|lacks?|without|missing)\b/i;

const avrBoards = partDefinitions.filter((d) => d.spec.mcu?.backend === "avr8js");

/** Every sentence (or list item) of a fidelity file, with where it came from. */
function sentences(f: (typeof avrBoards)[number]["fidelity"]): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const [area, a] of Object.entries(f.areas)) {
    for (const s of a.note.split(/(?<=\.)\s+|;\s*/)) out.push({ where: `areas.${area}.note`, text: s });
  }
  for (const s of f.emulates) out.push({ where: "emulates", text: s });
  return out;
}

describe("board fidelity matches the AVR backend", () => {
  it("covers every avr8js board", () => {
    expect(avrBoards.map((d) => d.spec.id).sort()).toEqual(["arduino-nano", "arduino-uno"]);
  });

  for (const def of avrBoards) {
    const f = def.fidelity;
    const all = [...sentences(f), ...f.doesNotEmulate.map((text) => ({ where: "doesNotEmulate", text }))];

    describe(def.spec.id, () => {
      it("states the digital input thresholds the backend uses, with hysteresis", () => {
        const { low, high } = AVR_BACKEND_FACTS.inputThresholds;
        expect(f.areas.analog.note).toContain(`${low}·VCC`);
        expect(f.areas.analog.note).toContain(`${high}·VCC`);
        expect(f.areas.analog.note).toMatch(/keep their last level/);
        for (const s of all) {
          expect(s.text, s.where).not.toMatch(/VCC\/2/);
          expect(s.text, s.where).not.toMatch(/hysteresis/i);
        }
      });

      for (const [name, emulated] of Object.entries(AVR_BACKEND_FACTS.peripherals)) {
        const re = PERIPHERAL_NAMES[name as keyof typeof PERIPHERAL_NAMES];
        if (emulated) {
          it(`does not claim ${name} is missing (the backend emulates it)`, () => {
            for (const s of all) {
              const missing = s.where === "doesNotEmulate" || (NEGATIVE.test(s.text) && !/\bnot emulated yet\b/.test(s.text));
              if (missing) expect(s.text, `${s.where}: "${s.text}"`).not.toMatch(re);
            }
          });
        } else {
          it(`lists ${name} under doesNotEmulate (the backend lacks it)`, () => {
            expect(f.doesNotEmulate.some((t) => re.test(t))).toBe(true);
            for (const s of sentences(f)) {
              if (re.test(s.text)) expect(s.text, `${s.where} mentions ${name} as if it worked`).toMatch(NEGATIVE);
            }
          });
        }
      }

      it("describes exactly the pins the backend exposes", () => {
        const board = boardTypeOf(def.spec.id)!;
        expect(board).toBeDefined();
        const ids = new Set(def.spec.pins.map((p) => p.id));
        for (const bp of boardPinMap(board)) {
          expect(ids, bp.id).toContain(bp.id);
          const pin = def.spec.pins.find((p) => p.id === bp.id)!;
          if (bp.port === undefined) {
            // analog-only pin (Nano A6/A7): no digital buffer on the chip
            expect(pin.type, bp.id).toBe("analog");
            expect(pin.description ?? "", bp.id).not.toMatch(/digital I\/O|PC6|PC7/);
            expect(pin.description ?? "", bp.id).toMatch(/analog input only/);
          }
        }
        for (const s of all) expect(s.text, s.where).not.toMatch(/not exposed/i);
      });
    });
  }
});
