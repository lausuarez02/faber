// ESP32-family chips the Fabwright QEMU image (Espressif's QEMU fork + Fabwright's bridge patch) runs.
// Pin and signal numbers are from ESP-IDF v5.5 soc/<chip>/gpio_sig_map.h and the datasheets; the
// peripherals each chip has (and Fabwright bridges) are listed per chip so the fidelity report and
// design checks can say what works on which board. See docs/esp32-emulator.md.

import type { McuCapability } from "@fabwright/sim-core";

export type EspChip = "esp32" | "esp32s3" | "esp32c3";

/** Peripherals a backend carries across the bridge (decision 0006 "capabilities"). */
export type EspCapability = Extract<McuCapability, "gpio" | "pulls" | "irq" | "uart" | "i2c" | "spi" | "pwm" | "adc" | "rmt" | "i2s" | "net" | "camera">;

export interface EspSignals {
  /** GPIO matrix output selector meaning "plain GPIO_OUT register". */
  gpioOut: number;
  /** LEDC channel 0 output; channel n is base + n (ESP32: HS 0-7 then LS 8-15). */
  ledc: number;
  ledcChannels: number;
  /** RMT channel 0 output; channel n is base + n. */
  rmt: number;
  rmtTxChannels: number;
  /** UART TX / RX signal per UART index. */
  uartTx: readonly number[];
  uartRx: readonly number[];
  /** SPI master signals per host (2 = SPI2, 3 = SPI3): clk, d (MOSI), q (MISO), cs0. */
  spi: Partial<Record<2 | 3, { clk: number; mosi: number; miso: number; cs0: number }>>;
  /** I2S port 0: bit clock, word select, data out, data in (output / input signal numbers). */
  i2s0?: { bck: number; ws: number; dout: number; din: number };
}

export interface EspChipInfo {
  chip: EspChip;
  /** QEMU system emulator and machine. */
  qemu: "qemu-system-xtensa" | "qemu-system-riscv32";
  machine: EspChip;
  /** QOM type of the GPIO block that carries the bridge chardev. */
  gpioType: string;
  /** Nominal CPU clock: McuBackend.cycles counts these (a time base, as in the RP2040 backend). */
  cpuHz: number;
  /** GPIO numbers that exist on the chip, exposed as pin ids "GPIO<n>". */
  gpios: readonly number[];
  /** Hardware I2C0 default pins in arduino-esp32 (Wire.begin() with no arguments). */
  i2cPins?: { sda: number; scl: number };
  /** Default SPI pins of arduino-esp32's SPI object (SPI.begin() with no arguments). */
  spiPins?: { sck: number; miso: number; mosi: number; ss: number };
  /** arduino-cli FQBN for builds that boot in QEMU (DIO flash mode). */
  fqbn: string;
  /** I2C controllers / UARTs / SPI masters the chip has. */
  i2cBuses: number;
  uarts: number;
  spiHosts: readonly (2 | 3)[];
  /** ADC pins: unit (1 or 2) and channel per GPIO. */
  adc: Readonly<Record<number, { unit: 1 | 2; channel: number }>>;
  /** Full-scale input (mV) per attenuation 0 / 2.5 / 6 / 11-12 dB, as the QEMU ADC model uses. */
  adcFullScaleMv: readonly [number, number, number, number];
  /** Capacitive touch pins (not bridged; listed for the fidelity report). */
  touchPins: readonly number[];
  signals: EspSignals;
  /** What Fabwright bridges on this chip with a version-3 image. */
  capabilities: readonly EspCapability[];
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const adcMap = (unit: 1 | 2, gpios: readonly number[]) => Object.fromEntries(gpios.map((g, ch) => [g, { unit, channel: ch }]));

const ALL: readonly EspCapability[] = ["gpio", "pulls", "irq", "uart", "i2c", "spi", "pwm", "adc", "rmt", "i2s", "net"];

export const ESP_CHIPS: Record<EspChip, EspChipInfo> = {
  esp32: {
    chip: "esp32",
    qemu: "qemu-system-xtensa",
    machine: "esp32",
    gpioType: "esp32.gpio",
    cpuHz: 240_000_000,
    // 20, 24 and 28–31 do not exist on the ESP32.
    gpios: [...range(0, 19), 21, 22, 23, 25, 26, 27, ...range(32, 39)],
    i2cPins: { sda: 21, scl: 22 },
    spiPins: { sck: 18, miso: 19, mosi: 23, ss: 5 },
    fqbn: "esp32:esp32:esp32:FlashMode=dio",
    i2cBuses: 2,
    uarts: 3,
    spiHosts: [2, 3],
    adc: { ...adcMap(1, [36, 37, 38, 39, 32, 33, 34, 35]), ...adcMap(2, [4, 0, 2, 15, 13, 12, 14, 27, 25, 26]) },
    adcFullScaleMv: [1100, 1500, 2200, 3900],
    touchPins: [4, 0, 2, 15, 13, 12, 14, 27, 33, 32],
    signals: {
      gpioOut: 256,
      ledc: 71,
      ledcChannels: 16,
      rmt: 87,
      rmtTxChannels: 8,
      uartTx: [14, 17, 198],
      uartRx: [14, 17, 198],
      spi: { 2: { clk: 8, miso: 9, mosi: 10, cs0: 11 }, 3: { clk: 63, miso: 64, mosi: 65, cs0: 68 } },
      // Standard (Philips) mode uses the 24-bit parallel lane 23 for data out and lane 15 for data in.
      i2s0: { bck: 23, ws: 25, dout: 163, din: 155 },
    },
    capabilities: [...ALL, "camera"],
  },
  esp32s3: {
    chip: "esp32s3",
    qemu: "qemu-system-xtensa",
    machine: "esp32s3",
    gpioType: "esp32s3.gpio",
    cpuHz: 240_000_000,
    gpios: [...range(0, 21), ...range(26, 48)],
    i2cPins: { sda: 8, scl: 9 },
    spiPins: { sck: 12, miso: 13, mosi: 11, ss: 10 },
    fqbn: "esp32:esp32:esp32s3:FlashMode=dio",
    i2cBuses: 2,
    uarts: 3,
    spiHosts: [2, 3],
    adc: { ...adcMap(1, range(1, 10)), ...adcMap(2, range(11, 20)) },
    adcFullScaleMv: [950, 1250, 1750, 3100],
    touchPins: range(1, 14),
    signals: {
      gpioOut: 256,
      ledc: 73,
      ledcChannels: 8,
      rmt: 81,
      rmtTxChannels: 4,
      uartTx: [12, 15, 18],
      uartRx: [12, 15, 18],
      spi: { 2: { clk: 101, miso: 102, mosi: 103, cs0: 110 }, 3: { clk: 66, miso: 67, mosi: 68, cs0: 71 } },
      i2s0: { bck: 22, ws: 24, dout: 25, din: 25 },
    },
    capabilities: [...ALL, "camera"],
  },
  esp32c3: {
    chip: "esp32c3",
    qemu: "qemu-system-riscv32",
    machine: "esp32c3",
    gpioType: "esp32c3.gpio",
    cpuHz: 160_000_000,
    gpios: range(0, 21),
    i2cPins: { sda: 8, scl: 9 },
    spiPins: { sck: 4, miso: 5, mosi: 6, ss: 7 },
    fqbn: "esp32:esp32:esp32c3:FlashMode=dio",
    i2cBuses: 1,
    uarts: 2,
    spiHosts: [2],
    adc: { ...adcMap(1, range(0, 4)), ...adcMap(2, [5]) },
    adcFullScaleMv: [750, 1050, 1300, 2500],
    touchPins: [],
    signals: {
      gpioOut: 128,
      ledc: 45,
      ledcChannels: 6,
      rmt: 51,
      rmtTxChannels: 2,
      uartTx: [6, 9],
      uartRx: [6, 9],
      spi: { 2: { clk: 63, miso: 64, mosi: 65, cs0: 68 } },
      i2s0: { bck: 13, ws: 14, dout: 15, din: 15 },
    },
    capabilities: ALL,
  },
};

export const espPinId = (gpio: number) => `GPIO${gpio}`;

export function espGpioOf(pinId: string): number | undefined {
  const m = /^GPIO(\d+)$/.exec(pinId);
  return m ? Number(m[1]) : undefined;
}

/** What a GPIO-matrix output selector drives on this chip, for routing and the fidelity report. */
export type EspOutputSource =
  | { kind: "gpio" }
  | { kind: "ledc"; ch: number }
  | { kind: "rmt"; ch: number }
  | { kind: "uart-tx"; uart: number }
  | { kind: "spi"; host: 2 | 3; line: "clk" | "mosi" | "miso" | "cs0" }
  | { kind: "i2s"; line: "bck" | "ws" | "dout" }
  | { kind: "other"; signal: number };

export function espOutputSource(info: EspChipInfo, signal: number): EspOutputSource {
  const s = info.signals;
  if (signal === s.gpioOut) return { kind: "gpio" };
  if (signal >= s.ledc && signal < s.ledc + s.ledcChannels) return { kind: "ledc", ch: signal - s.ledc };
  if (signal >= s.rmt && signal < s.rmt + s.rmtTxChannels) return { kind: "rmt", ch: signal - s.rmt };
  const u = s.uartTx.indexOf(signal);
  if (u >= 0) return { kind: "uart-tx", uart: u };
  for (const host of [2, 3] as const) {
    const p = s.spi[host];
    if (!p) continue;
    for (const line of ["clk", "mosi", "miso", "cs0"] as const) if (p[line] === signal) return { kind: "spi", host, line };
  }
  if (s.i2s0) for (const line of ["bck", "ws", "dout"] as const) if (s.i2s0[line] === signal) return { kind: "i2s", line };
  return { kind: "other", signal };
}
