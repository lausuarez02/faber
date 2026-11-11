// Boards the Renode backend runs, as data: which platform file, which UART is Serial, how Jumper
// pin ids map to Renode GPIO peripherals, which pins reach which ADC channel, and the bus
// controllers Wire / SPI use. Visuals, physical data and fidelity live in the board part
// (packages/parts/src/parts/<type>). A board is listed in the parts library only when its fixture
// test (packages/sim-backends/src/renode/boards.integration.test.ts) boots real firmware on it.
import type { McuBusPins } from "@jumper/sim-core";

/** A Jumper pin id → the Renode GPIO peripheral (path under sysbus) and pin number on it. */
export interface RenodePin {
  gpio: string;
  pin: number;
}

export interface RenodeBoard {
  type: string;
  /** Chip, for messages and fidelity ("stm32f103c8"). */
  chip: string;
  /** Platform description: ours ("/jumper/platforms/…", from ./platforms) or Renode's ("platforms/…"). */
  platform: string;
  /** C# models compiled into Renode before the platform loads (files in ./platforms). */
  csharp?: readonly string[];
  /** UART that `Serial` prints to (path under sysbus). */
  console: string;
  /** Core clock: McuBackend.cycles counts these. The platform's SysTick runs at the same rate. */
  clockHz: number;
  vcc: number;
  pins: Readonly<Record<string, RenodePin>>;
  /** Pins that reach an ADC channel: the Renode ADC peripheral (path under sysbus) and channel. */
  adc?: Readonly<Record<string, { adc: string; channel: number }>>;
  /** The controller `Wire` uses and its pins. */
  i2c?: { controller: string; sda: string; scl: string };
  /** The controller `SPI` uses and its pins. */
  spi?: { controller: string; mosi: string; miso: string; sck: string; ss: string };
  /** Arduino FQBN that builds firmware for it (the Jumper build image is picked from its prefix). */
  fqbn: string;
}

function port(prefix: string, gpio: string, pins: readonly number[]): Record<string, RenodePin> {
  const out: Record<string, RenodePin> = {};
  for (const i of pins) out[`${prefix}${i}`] = { gpio, pin: i };
  return out;
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** STM32F1 / F4 ADC1 channels 0..9 on PA0..PA7, PB0, PB1 (same on F103, F401, F411). */
const STM32_ADC1 = (adc: string) => ({
  PA0: { adc, channel: 0 }, PA1: { adc, channel: 1 }, PA2: { adc, channel: 2 }, PA3: { adc, channel: 3 },
  PA4: { adc, channel: 4 }, PA5: { adc, channel: 5 }, PA6: { adc, channel: 6 }, PA7: { adc, channel: 7 },
  PB0: { adc, channel: 8 }, PB1: { adc, channel: 9 },
});

export const RENODE_BOARDS = {
  // STM32 "Blue Pill" (STM32F103C8T6), STM32duino GenF1. Serial = USART1 (PA9 TX / PA10 RX), Wire =
  // I2C1 (PB7 SDA / PB6 SCL), SPI = SPI1 (PA7 / PA6 / PA5, SS PA4), LED PC13 (active low).
  "stm32-bluepill": {
    type: "stm32-bluepill",
    chip: "stm32f103c8",
    platform: "/jumper/platforms/bluepill.repl",
    csharp: ["JumperStm32F1Adc.cs"],
    console: "usart1",
    clockHz: 72_000_000,
    vcc: 3.3,
    pins: { ...port("PA", "gpioPortA", range(0, 15)), ...port("PB", "gpioPortB", range(0, 15)), ...port("PC", "gpioPortC", [13, 14, 15]) },
    adc: STM32_ADC1("adc1"),
    i2c: { controller: "i2c1", sda: "PB7", scl: "PB6" },
    spi: { controller: "spi1", mosi: "PA7", miso: "PA6", sck: "PA5", ss: "PA4" },
    fqbn: "STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8",
  },
} as const satisfies Record<string, RenodeBoard>;

export type RenodeBoardType = keyof typeof RENODE_BOARDS;

export function renodeBoardOf(type: string): RenodeBoard | undefined {
  return (RENODE_BOARDS as Record<string, RenodeBoard>)[type];
}

export function renodeBusPins(b: RenodeBoard): McuBusPins {
  return {
    ...(b.i2c ? { i2c: { sda: b.i2c.sda, scl: b.i2c.scl } } : {}),
    ...(b.spi ? { spi: { mosi: b.spi.mosi, miso: b.spi.miso, sck: b.spi.sck, ss: b.spi.ss } } : {}),
  };
}
