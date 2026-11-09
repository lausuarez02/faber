// RP2040 boards: which GPIOs each one wires to its headers and on-board parts, and the default pins
// of arduino-pico's Wire / SPI / Serial1 (from each variant's pins_arduino.h in arduino-pico 6.3.1).
// Pin ids are "GP0".."GP29"; the arduino-pico pin number is the GPIO number (decision 0003, C1).
import type { McuBusPins } from "@jumper/sim-core";

export type Rp2040BoardType = "raspberry-pi-pico" | "seeed-xiao-rp2040" | "waveshare-rp2040-zero";

export interface Rp2040Board {
  type: Rp2040BoardType;
  /** arduino-pico FQBN. */
  fqbn: string;
  /** Default Wire / SPI pins (the board part tags them with the same protocols). */
  bus: Required<McuBusPins>;
  /** Default Serial1 (UART0) pins. */
  uart: { tx: string; rx: string };
  /** GPIOs that come out on the board's headers or pads. */
  headerGpios: readonly number[];
  /** On-board LEDs driven by a GPIO; `activeLow` LEDs light when the pin is LOW. */
  leds: readonly { key: string; gpio: number; activeLow: boolean }[];
  /** GPIOs the board wires to something fixed (inputs the backend drives), e.g. the Pico's VBUS sense. */
  fixedInputs: readonly { gpio: number; volts: number; what: string }[];
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const RP2040_BOARDS: Record<Rp2040BoardType, Rp2040Board> = {
  "raspberry-pi-pico": {
    type: "raspberry-pi-pico",
    fqbn: "rp2040:rp2040:rpipico",
    bus: { i2c: { sda: "GP4", scl: "GP5" }, spi: { miso: "GP16", ss: "GP17", sck: "GP18", mosi: "GP19" } },
    uart: { tx: "GP0", rx: "GP1" },
    headerGpios: [...range(0, 22), 26, 27, 28],
    leds: [{ key: "led", gpio: 25, activeLow: false }],
    // GP24 senses VBUS (high on USB power); GP29 / ADC3 reads VSYS through a 3:1 divider.
    fixedInputs: [
      { gpio: 24, volts: 3.3, what: "VBUS sense (USB connected)" },
      { gpio: 29, volts: 4.7 / 3, what: "VSYS / 3 (ADC3)" },
    ],
  },
  "seeed-xiao-rp2040": {
    type: "seeed-xiao-rp2040",
    fqbn: "rp2040:rp2040:seeed_xiao_rp2040",
    // Wire is I2C1 on GP6/GP7 (D4/D5); SPI0 on GP2/GP3/GP4 (D8/D10/D9). SS is not pinned out on the
    // XIAO; D7 (GP1) is the silkscreened CS.
    bus: { i2c: { sda: "GP6", scl: "GP7" }, spi: { sck: "GP2", mosi: "GP3", miso: "GP4", ss: "GP1" } },
    uart: { tx: "GP0", rx: "GP1" },
    headerGpios: [26, 27, 28, 29, 6, 7, 0, 1, 2, 4, 3],
    // The user LED is an RGB LED, each colour active low (arduino-pico: LED_BUILTIN = GP17, red).
    // The WS2812 on GP12 (power GP11) is not drawn.
    leds: [
      { key: "led_r", gpio: 17, activeLow: true },
      { key: "led_g", gpio: 16, activeLow: true },
      { key: "led_b", gpio: 25, activeLow: true },
    ],
    fixedInputs: [],
  },
  "waveshare-rp2040-zero": {
    type: "waveshare-rp2040-zero",
    fqbn: "rp2040:rp2040:waveshare_rp2040_zero",
    bus: { i2c: { sda: "GP4", scl: "GP5" }, spi: { miso: "GP4", ss: "GP5", sck: "GP2", mosi: "GP3" } },
    uart: { tx: "GP0", rx: "GP1" },
    // Edge pins GP0-GP15 and GP26-GP29 (the underside pads are not modelled as pins).
    headerGpios: [...range(0, 15), 26, 27, 28, 29],
    // The only LED is a WS2812 on GP16 (not drawn).
    leds: [],
    fixedInputs: [],
  },
};

/** Board for a part type id, if it is an RP2040 board. */
export function rp2040BoardOf(partType: string): Rp2040Board | undefined {
  return (RP2040_BOARDS as Record<string, Rp2040Board>)[partType.toLowerCase()];
}

export const RP2040_PIN_IDS: readonly string[] = range(0, 29).map((i) => `GP${i}`);
