// Round 11: the round 10 esp-periph Arduino fixtures (packages/sim-backends/fixtures/esp32), built at
// last (natively, no Docker: fixtures/esp32/build.ts) and run on every ESP chip in QEMU jb5. Arduino
// sketches written for the real board: LEDC (analogWrite, a 50 Hz servo, tone, ledcFade), a pin
// interrupt, the ADC, I2C on both controllers, SPI, UART1 / UART2 and WS2812 through the RMT.
// Needs the QEMU image (Docker) or the native QEMU (fabwright setup esp32); skipped otherwise.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { I2cBus, SpiBus } from "@fabwright/sim-core";
import { QemuEspBackend, qemuImageAvailable } from "@fabwright/sim-backends/qemu-esp";
import { buildFirmware, flashImageOf } from "../build.ts";
import { canBuildArduino } from "../runtime.ts";

const FIX = fileURLToPath(new URL("../../../../packages/sim-backends/fixtures/esp32/", import.meta.url));
const available = qemuImageAvailable() && existsSync(`${FIX}esp_io.esp32.bin.gz`);
type Chip = "esp32" | "esp32s3" | "esp32c3";
const CHIPS: Chip[] = ["esp32", "esp32s3", "esp32c3"];

/** fixtures/esp32/esp_pins.h */
const PINS: Record<Chip, { irq: number; led: number; servo: number; tone: number; adcA: number; adcB: number; u1tx: number; neo: number; wire1: boolean; serial2: boolean }> = {
  esp32: { irq: 4, led: 16, servo: 17, tone: 25, adcA: 34, adcB: 27, u1tx: 25, neo: 13, wire1: true, serial2: true },
  esp32s3: { irq: 7, led: 4, servo: 5, tone: 6, adcA: 1, adcB: 14, u1tx: 17, neo: 48, wire1: true, serial2: true },
  esp32c3: { irq: 6, led: 2, servo: 3, tone: 10, adcA: 0, adcB: 1, u1tx: 19, neo: 10, wire1: false, serial2: false },
};
/** Linear ADC model at 11 dB (docs/esp32-peripherals.md): full scale per chip, in mV. */
const FULL_SCALE_MV: Record<Chip, number> = { esp32: 3900, esp32s3: 3100, esp32c3: 2500 };

interface Edge {
  v: number;
  c: number;
}

function boot(chip: Chip, image: Uint8Array, setup: (be: QemuEspBackend) => void = () => {}) {
  const be = new QemuEspBackend({ chip, network: false });
  let serial = "";
  be.onSerial((b) => (serial += String.fromCharCode(b)));
  const edges = new Map<number, Edge[]>();
  be.onPinChange((pin, s, c) => {
    if (s.mode !== "output") return;
    const g = Number(pin.replace("GPIO", ""));
    let list = edges.get(g);
    if (!list) edges.set(g, (list = []));
    list.push({ v: s.value, c });
  });
  setup(be);
  be.load(image);
  const ms = (n: number) => {
    for (let i = 0; i < n; i++) be.step(Math.round(be.cyclesPerSecond / 1000));
  };
  const until = (text: string, max = 3000) => {
    for (let i = 0; i < max && !serial.includes(text); i++) ms(1);
    return serial.includes(text);
  };
  return { be, ms, until, serial: () => serial, edges: (g: number) => edges.get(g) ?? [] };
}

/** Period and high time (s) of the pulses on a pin after virtual cycle `from`. */
function pulses(be: QemuEspBackend, e: Edge[], from = 0): { n: number; period: number; high: number } {
  const after = e.filter((x) => x.c >= from);
  const rises = after.filter((x, i) => x.v === 1 && i > 0 && after[i - 1]!.v === 0);
  if (rises.length < 4) return { n: rises.length, period: 0, high: 0 };
  const k = Math.min(rises.length - 1, 12);
  const period = (rises[k]!.c - rises[1]!.c) / (k - 1) / be.cyclesPerSecond;
  const fall = after.find((x) => x.v === 0 && x.c > rises[1]!.c)!;
  return { n: rises.length, period, high: (fall.c - rises[1]!.c) / be.cyclesPerSecond };
}

const image = (name: string) => new Uint8Array(gunzipSync(readFileSync(`${FIX}${name}.bin.gz`)));

describe.skipIf(!available)("ESP32 Arduino peripheral fixtures on QEMU jb5 (esp_io, esp_bus, esp_neopixel)", { timeout: 240_000 }, () => {
  const backends: QemuEspBackend[] = [];
  afterAll(() => backends.forEach((b) => b.close()));

  for (const chip of CHIPS) {
    const p = PINS[chip];

    it(`${chip}: esp_io: LEDC PWM, a 50 Hz servo, tone, ledcFade, a pin interrupt and the ADC`, () => {
      const s = boot(chip, image(`esp_io.${chip}`), (be) => {
        be.setPinInput(`GPIO${p.adcA}`, 1.0); // set before the boot: must survive it
        be.setPinInput(`GPIO${p.adcB}`, 2.0);
        be.setPinInput(`GPIO${p.irq}`, 0);
      });
      backends.push(s.be);
      expect(s.until("io ready"), s.serial()).toBe(true);
      s.ms(120);
      // analogWrite(LED, 64): 1 kHz, 25 %. Servo: 50 Hz, 1.5 ms. tone(2000): 0.5 ms period, 50 %.
      const led = pulses(s.be, s.edges(p.led));
      expect(led.period).toBeCloseTo(1e-3, 5);
      expect(led.high).toBeCloseTo(0.25e-3, 5);
      const servo = pulses(s.be, s.edges(p.servo));
      expect(servo.period).toBeCloseTo(20e-3, 4);
      expect(servo.high).toBeCloseTo(1.5e-3, 4);
      const tone = pulses(s.be, s.edges(p.tone));
      expect(tone.period).toBeCloseTo(0.5e-3, 5);
      // Three rising edges on the interrupt pin.
      for (let k = 0; k < 3; k++) {
        s.be.setPinInput(`GPIO${p.irq}`, 3.3);
        s.ms(5);
        s.be.setPinInput(`GPIO${p.irq}`, 0);
        s.ms(5);
      }
      expect(s.until("changed")).toBe(true);
      const changedAt = s.be.cycles;
      s.ms(150); // the fade starts 200 ms after "changed"
      expect(s.serial()).toMatch(/irq=3 /);
      // ADC raw, 12 bit, the linear model within 3 %.
      const m = s.serial().match(/adc=(\d+) mv=(-?\d+) adcb=(\d+)/)!;
      expect(Math.abs(Number(m[1]) / 4095 - 1000 / FULL_SCALE_MV[chip])).toBeLessThan(0.03);
      expect(Math.abs(Number(m[3]) / 4095 - Math.min(1, 2000 / FULL_SCALE_MV[chip]))).toBeLessThan(0.03);
      // After "changed": LED 75 %, servo 2.0 ms, tone off.
      const led2 = pulses(s.be, s.edges(p.led), changedAt + s.be.cyclesPerSecond * 0.005);
      expect(led2.high).toBeCloseTo(0.75e-3, 5);
      const servo2 = pulses(s.be, s.edges(p.servo), changedAt + s.be.cyclesPerSecond * 0.025);
      expect(servo2.high).toBeCloseTo(2.0e-3, 4);
      expect(s.edges(p.tone).filter((e) => e.c > changedAt + s.be.cyclesPerSecond * 0.002)).toHaveLength(0);
      // ledcFade(LED, 192 -> 0, 200 ms): the duty falls, then the pin stays low.
      expect(s.until("fading")).toBe(true);
      const fadeAt = s.be.cycles;
      s.ms(400);
      const early = pulses(s.be, s.edges(p.led), fadeAt + s.be.cyclesPerSecond * 0.02).high;
      const late = s.edges(p.led).filter((e) => e.c > fadeAt + s.be.cyclesPerSecond * 0.3);
      expect(early).toBeLessThan(0.75e-3);
      expect(late.filter((e) => e.v === 1)).toHaveLength(0);
      expect(s.be.readPin(`GPIO${p.led}`).value).toBe(0);
    });

    // Known gap: analogReadMilliVolts needs the chip's ADC calibration eFuses, which QEMU leaves
    // blank: ESP32 / S3 return 0 ("default vref didn't set" / "eFuse bits not burnt"), the C3 uses its
    // fallback curve (1123 mV for 1.0 V). analogRead (raw) is right. Turns red when it is fixed.
    it.fails(`${chip}: analogReadMilliVolts matches the pin voltage (known gap: no ADC calibration eFuses)`, () => {
      const s = boot(chip, image(`esp_io.${chip}`), (be) => be.setPinInput(`GPIO${p.adcA}`, 1.0));
      backends.push(s.be);
      expect(s.until("mv=")).toBe(true);
      s.ms(5);
      const mv = Number(s.serial().match(/mv=(-?\d+)/)![1]);
      expect(Math.abs(mv - 1000)).toBeLessThan(30);
    });

    it(`${chip}: esp_bus: I2C${p.wire1 ? " on both controllers" : ""}, SPI and UART1${p.serial2 ? " / UART2" : ""} in both directions`, () => {
      const regs = Array.from({ length: 16 }, (_, i) => 0x10 + i);
      let ptr = 0;
      let first = true;
      const mosi: number[] = [];
      const uart = new Map<number, string>();
      const s = boot(chip, image(`esp_bus.${chip}`), (be) => {
        const i2c0 = new I2cBus("i2c0", () => be.cycles);
        i2c0.attach("fake", {
          i2cAddress: () => 0x3c,
          i2cConnect: (read) => ((first = !read), true),
          i2cWrite: (b) => {
            if (first) ptr = b & 15;
            else regs[ptr++ & 15] = b;
            first = false;
            return true;
          },
          i2cRead: () => regs[ptr++ & 15]!,
          i2cStop: () => {},
        });
        const i2c1 = new I2cBus("i2c1", () => be.cycles);
        let t = 0;
        i2c1.attach("tmp", { i2cAddress: () => 0x48, i2cConnect: () => true, i2cWrite: () => true, i2cRead: () => [0x19, 0x00][t++ % 2]!, i2cStop: () => {} });
        be.attachI2cBus(0, i2c0);
        be.attachI2cBus(1, i2c1);
        const spi = new SpiBus();
        spi.attach("flash", { spiTransfer: (b) => (mosi.push(b), [0xff, 0xef, 0x40][mosi.length - 1] ?? 0) }, () => true);
        be.attachSpi(spi);
        be.onUart((u, bytes) => uart.set(u, (uart.get(u) ?? "") + String.fromCharCode(...bytes)));
      });
      backends.push(s.be);
      expect(s.until("bus ready"), s.serial()).toBe(true);
      expect(s.serial()).toContain("i2c0 scan: 3c\r\n");
      expect(s.serial()).toContain("write 0x3c -> 0");
      expect(s.serial()).toContain("read 0x3c n=4: 12 13 aa 15"); // repeated START, register 4 written above
      expect(regs[4]).toBe(0xaa);
      if (p.wire1) {
        expect(s.serial()).toContain("i2c1 scan: 48\r\n");
        expect(s.serial()).toContain("i2c1 0x48 n=2: 19 00");
      }
      // SPI (Arduino's SPI class, polled): 9F 00 00 answered FF EF 40, then a 100-byte write.
      expect(s.serial()).toContain("spi ff ef 40");
      expect(mosi.slice(0, 3)).toEqual([0x9f, 0x00, 0x00]);
      expect(mosi.slice(3)).toEqual(Array.from({ length: 100 }, (_, i) => i));
      s.ms(20);
      expect(uart.get(1)).toBe("AT\r\n");
      if (p.serial2) expect(uart.get(2)).toBe("U2\r\n");
      s.be.writeUart(1, Buffer.from("OK\r\n"));
      if (p.serial2) s.be.writeUart(2, Buffer.from("PONG\r\n"));
      expect(s.until("rx1 OK", 500)).toBe(true);
      if (p.serial2) expect(s.until("rx2 PONG", 500)).toBe(true);
    });
  }

  // Adafruit NeoPixel is LGPL-3.0, so no binary linking it is committed (NOTICE): built here when a
  // toolchain is ready (Docker image or `fabwright setup esp32`), then run.
  const neoBuild = canBuildArduino("esp32:esp32:esp32");
  for (const chip of CHIPS) {
    it.skipIf(!neoBuild.ok)(`${chip}: esp_neopixel: Adafruit NeoPixel through the RMT sends the right colours`, async () => {
      const { cpSync, mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const work = mkdtempSync(join(tmpdir(), "fabwright-neo-"));
      cpSync(`${FIX}esp_neopixel`, join(work, "esp_neopixel"), { recursive: true });
      cpSync(`${FIX}esp_pins.h`, join(work, "esp_neopixel", "esp_pins.h"));
      const r = await buildFirmware({ sketchDir: join(work, "esp_neopixel"), fqbn: `esp32:esp32:${chip}:FlashMode=dio`, libraries: ["Adafruit NeoPixel"] });
      rmSync(work, { recursive: true, force: true });
      expect(r.ok, r.logTail).toBe(true);
      const s = boot(chip, flashImageOf(r)!);
      backends.push(s.be);
      expect(s.until("shown 2")).toBe(true);
      s.ms(5);
      // WS2812: a bit is a pulse, 0.4 µs high = 0, 0.8 µs = 1; frames are split by the latch gap.
      const e = s.edges(PINS[chip].neo);
      const frames: number[][] = [[]];
      for (let i = 1; i + 1 < e.length; i++) {
        if (e[i]!.v !== 1 || e[i - 1]!.v !== 0) continue;
        const prevFall = e[i - 1]!.c;
        if (frames.at(-1)!.length && (e[i]!.c - prevFall) / s.be.cyclesPerSecond > 50e-6) frames.push([]);
        frames.at(-1)!.push((e[i + 1]!.c - e[i]!.c) / s.be.cyclesPerSecond > 0.6e-6 ? 1 : 0);
      }
      const colours = frames.map((bits) => {
        const out: string[] = [];
        for (let o = 0; o + 24 <= bits.length; o += 24) {
          const v = bits.slice(o, o + 24).reduce((a, b) => a * 2 + b, 0);
          const [g, r, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
          out.push([r, g, b].map((x) => x.toString(16).padStart(2, "0")).join(""));
        }
        return out.join(" ");
      });
      expect(colours).toEqual([
        "ff0000 00ff00 0000ff 000000 000000 000000 000000 102030",
        Array.from({ length: 8 }, (_, i) => [i * 10, 255 - i * 30, 7].map((x) => x.toString(16).padStart(2, "0")).join("")).join(" "),
      ]);
    });
  }
});
