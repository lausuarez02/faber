// The ESP32 peripherals of QEMU image jb5 (round 10 esp-periph) on REAL firmware: the official
// MicroPython build drives LEDC PWM, a GPIO interrupt, UART1, the ADC and SPI, and each must reach
// Fabwright's pins and buses. MicroPython needs no Docker build (its image is composed in process), so
// this runs wherever the QEMU image (Docker) or a native jb5 build (FABWRIGHT_QEMU_ESP_RUNTIME=native) is.
import { afterAll, describe, expect, it } from "vitest";
import { SpiBus } from "@fabwright/sim-core";
import { QemuEspBackend, qemuImageAvailable } from "@fabwright/sim-backends/qemu-esp";
import { composeMicroPython } from "./micropython.ts";

const available = qemuImageAvailable();

const PINS = {
  esp32: { pwm: 25, irq: 27, adc: 34, sck: 14, mosi: 13, miso: 12, cs: 15, tx: 17, rx: 16 },
  esp32c3: { pwm: 6, irq: 7, adc: 0, sck: 4, mosi: 5, miso: 10, cs: 1, tx: 3, rx: 9 },
} as const;

/** Linear ADC model, full scale at 11 dB (docs/esp32-peripherals.md). */
const FULL_SCALE_11DB_MV = { esp32: 3900, esp32c3: 2500 } as const;

function run(be: QemuEspBackend, ms: number) {
  const end = be.cycles + Math.round((be.cyclesPerSecond * ms) / 1000);
  while (be.cycles < end) be.step(Math.round(be.cyclesPerSecond / 1000));
}

async function boot(chip: "esp32" | "esp32c3", main: string, setup: (be: QemuEspBackend) => void) {
  const out = await composeMicroPython({ chip, files: new Map([["main.py", main]]) });
  const be = new QemuEspBackend({ chip, network: false });
  let serial = "";
  be.onSerial((b) => (serial += String.fromCharCode(b)));
  setup(be);
  be.load(out.binary!);
  const until = (text: string, ms: number) => {
    for (let i = 0; i < ms / 10 && !serial.includes(text) && !serial.includes("Traceback"); i++) run(be, 10);
  };
  return { be, until, serial: () => serial };
}

describe.skipIf(!available)("ESP32 peripherals on real firmware (MicroPython, QEMU jb5)", { timeout: 180_000 }, () => {
  const backends: QemuEspBackend[] = [];
  afterAll(() => backends.forEach((b) => b.close()));

  for (const chip of ["esp32", "esp32c3"] as const) {
    const p = PINS[chip];

    it(`${chip}: PWM, a pin interrupt, UART1 and the ADC reach Fabwright`, async () => {
      const main = [
        "from machine import Pin, PWM, ADC, UART",
        "import time",
        `pwm = PWM(Pin(${p.pwm}), freq=1000, duty_u16=16384)`,
        "n = [0]",
        "def h(pin):",
        "    n[0] += 1",
        `btn = Pin(${p.irq}, Pin.IN, Pin.PULL_UP)`,
        "btn.irq(trigger=Pin.IRQ_FALLING, handler=h)",
        'print("ready")',
        "time.sleep_ms(300)",
        'print("irq", n[0])',
        `u = UART(1, baudrate=115200, tx=Pin(${p.tx}), rx=Pin(${p.rx}))`,
        "u.write(b'hi')",
        "time.sleep_ms(20)",
        `adc = ADC(Pin(${p.adc}))`,
        "adc.atten(ADC.ATTN_11DB)",
        // read_u16, not read_uv: QEMU's eFuse has no ADC calibration, so read_uv raises.
        'print("adc_u16", adc.read_u16())',
        'print("done")',
        "",
      ].join("\n");
      const uart: number[] = [];
      const pwmEdges: { v: number; c: number }[] = [];
      const { be, until, serial } = await boot(chip, main, (be) => {
        be.onUart((u, bytes) => u === 1 && uart.push(...bytes));
        be.onPinChange((pin, s, c) => pin === `GPIO${p.pwm}` && s.mode === "output" && pwmEdges.push({ v: s.value, c }));
        be.setPinInput(`GPIO${p.irq}`, 3.3);
        be.setPinInput(`GPIO${p.adc}`, 1.25); // set before the boot: must survive it
      });
      backends.push(be);
      until("ready", 4000);
      expect(serial()).toContain("ready");
      for (let k = 0; k < 3; k++) {
        run(be, 20);
        be.setPinInput(`GPIO${p.irq}`, 0);
        run(be, 20);
        be.setPinInput(`GPIO${p.irq}`, 3.3);
      }
      until("done", 3000);
      expect(serial()).toContain("done");
      // Pin interrupt: three falling edges, three calls.
      expect(serial()).toMatch(/irq 3\b/);
      // PWM: 1 kHz, 25 % duty on the pin, drawn as edges.
      const rises = pwmEdges.filter((e, i) => e.v === 1 && i > 0 && pwmEdges[i - 1]!.v === 0);
      expect(rises.length).toBeGreaterThan(50);
      const period = (rises[40]!.c - rises[10]!.c) / 30 / be.cyclesPerSecond;
      expect(Math.abs(period - 1e-3)).toBeLessThan(2e-5);
      const fall = pwmEdges.find((e) => e.v === 0 && e.c > rises[10]!.c)!;
      expect(Math.abs((fall.c - rises[10]!.c) / be.cyclesPerSecond - 0.25e-3)).toBeLessThan(2e-5);
      // UART1 bytes
      expect(String.fromCharCode(...uart)).toBe("hi");
      // ADC: the linear model at 11 dB, within 3 %.
      const u16 = Number(serial().match(/adc_u16 (\d+)/)?.[1]);
      expect(Math.abs(u16 / 65535 - 1250 / FULL_SCALE_11DB_MV[chip])).toBeLessThan(0.03);
      expect(be.capabilities).toEqual(expect.arrayContaining(["pwm", "irq", "uart", "adc"]));
    });

    // Known gap (round 10 integration): MicroPython's SPI (spi_master, DMA) does not come through
    // the jb5 SPI model: on the C3 the transaction arrives with MOSI 00 00 and MISO is not used; on
    // the ESP32 the transfer never returns. it.fails: this turns red when the model is fixed.
    it.fails(`${chip}: SPI write_readinto reaches the SPI bus (known gap)`, async () => {
      const main = [
        "from machine import Pin, SPI",
        `spi = SPI(1, baudrate=1000000, sck=Pin(${p.sck}), mosi=Pin(${p.mosi}), miso=Pin(${p.miso}))`,
        `cs = Pin(${p.cs}, Pin.OUT, value=1)`,
        "r = bytearray(2)",
        "cs(0)",
        "spi.write_readinto(b'\\x9f\\x00', r)",
        "cs(1)",
        'print("spi", r[0], r[1])',
        "",
      ].join("\n");
      const mosi: number[] = [];
      const { be, until, serial } = await boot(chip, main, (be) => {
        const spi = new SpiBus();
        spi.attach("flash", { spiTransfer: (b) => (mosi.push(b), mosi.length === 1 ? 0xff : 0xef) }, () => true);
        be.attachSpi(spi);
      });
      backends.push(be);
      until("spi ", 3000);
      expect(mosi.slice(0, 2)).toEqual([0x9f, 0x00]);
      expect(serial()).toContain("spi 255 239");
    });
  }
});
