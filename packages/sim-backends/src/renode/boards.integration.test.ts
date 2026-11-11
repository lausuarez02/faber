// Renode boards against real firmware (Docker + the jumper/renode image). Skipped, with the reason,
// when Docker or the image is missing, or a board's fixture is not built yet
// (scripts/build-renode-fixtures.ts). A board part is "available" only when its tests here pass.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { I2cBus, SpiBus } from "@jumper/sim-core";
import { describe, expect, it } from "vitest";
import { createRenodeBackend, type RenodeBackend } from "./backend.ts";
import { RENODE_BOARDS } from "./boards.ts";
import { renodeUnavailable } from "./launcher.ts";

const fixture = (f: string) => fileURLToPath(new URL(`../../fixtures/renode/${f}`, import.meta.url));
const why = renodeUnavailable();
const MS = (be: RenodeBackend, ms: number) => Math.round((be.cyclesPerSecond * ms) / 1000);

/** Run `ms` of virtual time in 1 ms steps (the Simulation's default chunk). */
function run(be: RenodeBackend, ms: number): void {
  const step = MS(be, 1);
  for (let i = 0; i < ms; i++) be.step(step);
}

function serialOf(be: RenodeBackend): { text: () => string } {
  let text = "";
  be.onSerial((b) => (text += String.fromCharCode(b)));
  return { text: () => text };
}

/** Pins the pinprobe sketch exercises, in its order (fixtures/renode/pinprobe/pins.h). */
const PROBE_PINS: Record<string, string[]> = {
  "stm32-bluepill": ["PB12", "PB13", "PB14", "PB15", "PA8", "PA11", "PA12", "PA15", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8", "PB9", "PB11", "PB10", "PB1", "PB0", "PA7", "PA6", "PA5", "PA4", "PA3", "PA2", "PA1", "PA0", "PC15", "PC14", "PC13"],
  "stm32-blackpill-f411": ["PB12", "PB13", "PB14", "PB15", "PA8", "PA11", "PA12", "PA15", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8", "PB9", "PC13", "PC14", "PC15", "PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PB0", "PB1", "PB2", "PB10"],
  "stm32-nucleo-f401re": ["PB8", "PB9", "PA5", "PA6", "PA7", "PB6", "PC7", "PA9", "PA8", "PB10", "PB4", "PB5", "PB3", "PA10", "PA0", "PA1", "PA4", "PB0", "PC1", "PC0", "PC13"],
  "arduino-nano-33-ble": ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7"],
  "seeed-xiao-nrf52840": ["D0", "D1", "D2", "D3", "D4", "D5", "D8", "D9", "D10"],
};
/** What a board's test checks is still missing (docs/renode.md), so the suite fails when it starts working. */
const KNOWN_GAPS: Record<string, string[]> = { "arduino-nano-33-ble": ["serial-rx"], "stm32-nucleo-f401re": ["pin-irq"] };

/** busprobe's pins per board (fixtures/renode/busprobe/busprobe.ino). */
const BUS_PINS: Record<string, { adc: string; pwm: string; irq: string }> = {
  "stm32-bluepill": { adc: "PA0", pwm: "PB8", irq: "PB12" },
  "stm32-blackpill-f411": { adc: "PA0", pwm: "PB8", irq: "PB12" },
  "stm32-nucleo-f401re": { adc: "PA0", pwm: "PB10", irq: "PA8" },
  "arduino-nano-33-ble": { adc: "A0", pwm: "D9", irq: "D2" },
  "seeed-xiao-nrf52840": { adc: "D0", pwm: "D2", irq: "D3" },
};

describe.skipIf(!!why)(`Renode bridge (round 9 Blue Pill ELF)${why ? ` [skipped: ${why}]` : ""}`, () => {
  it("UART per byte, button in, LED out, I2C to an I2cBus device, SPI to an SpiBus device", { timeout: 120_000 }, () => {
    const be = createRenodeBackend({ board: "stm32-bluepill" });
    try {
      const i2c = new I2cBus("i2c0", () => be.cycles);
      let reg = -1;
      i2c.attach("sensor", { i2cAddress: () => 0x48, i2cConnect: () => true, i2cWrite: (b) => ((reg = b), true), i2cRead: () => (reg === 0 ? 0x12 : 0x34), i2cStop: () => {} });
      const spi = new SpiBus();
      const mosi: number[] = [];
      spi.attach("dev", { spiTransfer: (b) => (mosi.push(b), 0x5a) }, () => true);
      be.attachI2c(i2c);
      be.attachSpi(spi);
      be.load(new Uint8Array(readFileSync(fixture("bridge_bluepill.elf"))));
      const serial = serialOf(be);
      const led: { v: number; c: number }[] = [];
      be.onPinChange((p, s, c) => p === "PC13" && led.push({ v: s.value, c }));
      be.setPinInput("PB0", 3.3);
      run(be, 200);
      be.setPinInput("PB0", 0);
      const pressed = be.cycles;
      run(be, 200);
      expect(serial.text()).toContain("bridge up");
      expect(serial.text()).toMatch(/btn=1 i2c_err=0 got=2 raw=0x1212 spi=0x5A/);
      expect(serial.text()).toMatch(/btn=0 i2c_err=0 got=2 raw=0x1212 spi=0x5A/);
      expect(mosi.length).toBeGreaterThan(4);
      expect(mosi.every((b) => b === 0x9f)).toBe(true);
      const fall = led.find((e) => e.v === 0 && e.c >= pressed);
      expect(fall).toBeDefined();
      expect((fall!.c - pressed) / 72_000).toBeLessThan(60); // within one 50 ms loop
      expect(i2c.transactions().some((t) => t.address === 0x48 && t.read && t.ack)).toBe(true);
    } finally {
      be.dispose();
    }
  });
});

for (const board of Object.keys(RENODE_BOARDS)) {
  const pinHex = fixture(`pinprobe-${board}.hex`);
  const busHex = fixture(`busprobe-${board}.hex`);
  const missing = !existsSync(pinHex) || !existsSync(busHex);
  const skip = why ?? (missing ? `fixture not built (node --import tsx scripts/build-renode-fixtures.ts; needs Docker)` : undefined);

  describe.skipIf(!!skip)(`${board} on Renode${skip ? ` [skipped: ${skip}]` : ""}`, () => {
    it("boots real firmware; every listed pin works as an output, then as an input", { timeout: 240_000 }, () => {
      const be = createRenodeBackend({ board });
      try {
        const pins = PROBE_PINS[board]!;
        const rose: string[] = [];
        be.onPinChange((p, s) => s.mode === "output" && s.value === 1 && pins.includes(p) && !rose.includes(p) && rose.push(p));
        be.load(readFileSync(pinHex, "latin1"));
        const serial = serialOf(be);
        for (let t = 0; t < 3000 && !serial.text().includes("ready"); t += 10) run(be, 10);
        expect(serial.text()).toContain(`ready ${pins.length}`);
        expect(rose).toEqual(pins);
        for (const pattern of [pins.map(() => 0), pins.map(() => 1), pins.map((_, i) => i % 2), pins.map((_, i) => (i + 1) % 2)]) {
          pins.forEach((p, i) => be.setPinInput(p, pattern[i] ? 3.3 : 0));
          run(be, 30);
          const last = serial.text().trim().split("\n").filter((l) => l.startsWith("in ")).at(-1);
          expect(last?.trim(), `pattern ${pattern.join("")}`).toBe(`in ${pattern.join("")}`);
        }
        console.log(`${board}: start ${be.startupMs} ms`);
      } finally {
        be.dispose();
      }
    });

    it("Wire, SPI, analogRead, analogWrite, attachInterrupt and Serial reach Jumper", { timeout: 240_000 }, () => {
      const be = createRenodeBackend({ board });
      try {
        const p = BUS_PINS[board]!;
        const i2c = new I2cBus("i2c0", () => be.cycles);
        // Register 0x00 holds 0x0C80 (big endian), read from a register pointer like a TMP102.
        let ptr = 0;
        i2c.attach("sensor", { i2cAddress: () => 0x48, i2cConnect: () => true, i2cWrite: (b) => ((ptr = b === 0 ? 0 : 99), true), i2cRead: () => [0x0c, 0x80][ptr++] ?? 0xff, i2cStop: () => {} });
        const spi = new SpiBus();
        let n = 0;
        spi.attach("dev", { spiTransfer: () => (n++ % 2 === 0 ? 0xa5 : 0x5a) }, () => true);
        be.attachI2c(i2c);
        be.attachSpi(spi);
        const edges: { v: number; c: number }[] = [];
        be.onPinChange((pin, s, c) => pin === p.pwm && edges.push({ v: s.value, c }));
        be.load(readFileSync(busHex, "latin1"));
        const serial = serialOf(be);
        be.setPinInput(p.adc, 1.65);
        be.setPinInput(p.irq, 3.3);
        // setup() scans 4 I2C addresses first: on STM32 each absent one costs ~130 ms (docs/renode.md).
        for (let t = 0; t < 3000 && !serial.text().includes("bus up"); t += 10) run(be, 10);
        run(be, 50);
        for (let i = 0; i < 3; i++) {
          be.setPinInput(p.irq, 0);
          run(be, 10);
          be.setPinInput(p.irq, 3.3);
          run(be, 10);
        }
        for (const ch of "hello\n") be.writeSerial(ch.charCodeAt(0));
        run(be, 100);
        const text = serial.text();
        expect(text).toContain("i2c 0x48");
        expect(text).toContain("bus up");
        if (process.env.JUMPER_DEBUG) console.log(`${board}: ${text.split("\n").filter((l) => l.includes("presses")).at(-1)} ${text.includes("rx hello") ? "rx ok" : "no rx"}`);
        expect(text).toMatch(/i2c_err=0 got=2 raw=0xC80 spi=A5,5A/);
        const last = text.split("\n").filter((l) => l.includes("adc=")).at(-1) ?? "";
        const adc = Number(/adc=(\d+)/.exec(last)?.[1]);
        // 1.65 V at 12 bits: STM32 and Mbed read against 3.3 V (2048); the Adafruit nRF52 core's default
        // reference is 3.6 V (gain 1/6 of the internal 0.6 V), so 1877.
        const expected = Math.round((1.65 / (board === "seeed-xiao-nrf52840" ? 3.6 : 3.3)) * 4096);
        expect(Math.abs(adc - expected)).toBeLessThan(40);
        // Known gap: attachInterrupt never fires on the Nucleo-F401RE in Renode (why it stays planned).
        if (KNOWN_GAPS[board]?.includes("pin-irq")) expect(last).toMatch(/presses=0\b/);
        else expect(last).toMatch(/presses=3\b/);
        // Known gap: Serial1 RX on the Nano 33 BLE (Mbed's UARTE receive through Renode's UART model) never delivers bytes.
        if (KNOWN_GAPS[board]?.includes("serial-rx")) expect(text).not.toContain("rx hello");
        else expect(text).toContain("rx hello");
        // analogWrite(…, 64): high about 25 % of each period.
        const rises = edges.filter((e) => e.v === 1);
        expect(rises.length).toBeGreaterThan(10);
        const highs: number[] = [];
        for (let i = 0; i + 1 < edges.length; i++) if (edges[i]!.v === 1 && edges[i + 1]!.v === 0) highs.push(edges[i + 1]!.c - edges[i]!.c);
        const period = rises.at(-1)!.c - rises.at(-2)!.c;
        expect(highs.at(-1)! / period).toBeGreaterThan(0.2);
        expect(highs.at(-1)! / period).toBeLessThan(0.3);
      } finally {
        be.dispose();
      }
    });
  });
}
