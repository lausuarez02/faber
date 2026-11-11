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
  /**
   * What load() takes: "elf" (default; Renode finds the vector table from its symbols) or "ihex"
   * (Intel HEX, e.g. the Adafruit nRF52 build: Nordic's MBR + SoftDevice merged with the app).
   */
  firmware?: "elf" | "ihex";
  /** Flash ranges to fill with 0xFF before loading (erased flash; the MBR reads unwritten words). */
  erasedFlash?: readonly { start: number; size: number }[];
  /** Start from this vector table instead of the ELF's (0: the Nordic MBR at the bottom of flash). */
  vectorTableOffset?: number;
  /** Extra `sysbus.cpu <Property> <value>` settings for this board's runtime. */
  cpuSettings?: readonly string[];
  /** nRF52 "port.pin" (PWM PSEL as the bridge reports it) → board pin id. Built from `pins` when absent. */
  pwmPins?: Readonly<Record<string, string>>;
}

function port(prefix: string, gpio: string, pins: readonly number[]): Record<string, RenodePin> {
  const out: Record<string, RenodePin> = {};
  for (const i of pins) out[`${prefix}${i}`] = { gpio, pin: i };
  return out;
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function nrf(map: Record<string, string>): Record<string, RenodePin> {
  const out: Record<string, RenodePin> = {};
  for (const [id, pp] of Object.entries(map)) {
    const [portNo, pin] = pp.split(".").map(Number) as [number, number];
    out[id] = { gpio: `gpio${portNo}`, pin };
  }
  return out;
}

/** nRF52840 analog inputs: the P0 pin of each AIN (SAADC channel = AIN number). */
const NRF_AIN: Record<string, number> = { "0.02": 0, "0.03": 1, "0.04": 2, "0.05": 3, "0.28": 4, "0.29": 5, "0.30": 6, "0.31": 7 };
function nrfAdc(pins: Record<string, RenodePin>): Record<string, { adc: string; channel: number }> {
  const out: Record<string, { adc: string; channel: number }> = {};
  for (const [id, p] of Object.entries(pins)) {
    const key = `${p.gpio === "gpio1" ? 1 : 0}.${String(p.pin).padStart(2, "0")}`;
    if (p.gpio === "gpio0" && NRF_AIN[key] !== undefined) out[id] = { adc: "saadc", channel: NRF_AIN[key]! };
  }
  return out;
}

// Arduino Nano 33 BLE: D-numbers to nRF P0.xx / P1.xx from arduino:mbed_nano 4.4.1
// variants/ARDUINO_NANO33BLE/variant.cpp (D0 = P1.03 is Serial1 TX, D1 = P1.10 RX).
const NANO33BLE_PINS = nrf({
  D0: "1.03", D1: "1.10", D2: "1.11", D3: "1.12", D4: "1.15", D5: "1.13", D6: "1.14", D7: "0.23", D8: "0.21",
  D9: "0.27", D10: "1.02", D11: "1.01", D12: "1.08", D13: "0.13",
  A0: "0.04", A1: "0.05", A2: "0.30", A3: "0.29", A4: "0.31", A5: "0.02", A6: "0.28", A7: "0.03",
  LEDR: "0.24", LEDG: "0.16", LEDB: "0.06", LED_PWR: "1.09",
});

// Seeed XIAO nRF52840: Seeeduino:nrf52 1.1.13 variants/Seeed_XIAO_nRF52840/variant.cpp. On-board: RGB
// LED (active low), the BQ25101 charger's ~CHG (P0.17) and HICHG (P0.13), the battery divider
// (P0.31 = AIN7 reads VBAT x 510k / 1510k while P0.14 is LOW).
const XIAO_NRF_PINS = nrf({
  D0: "0.02", D1: "0.03", D2: "0.28", D3: "0.29", D4: "0.04", D5: "0.05", D6: "1.11", D7: "1.12", D8: "1.13", D9: "1.14", D10: "1.15",
  LED_RED: "0.26", LED_GREEN: "0.30", LED_BLUE: "0.06", VBAT_ENABLE: "0.14", HICHG: "0.13", CHG: "0.17", VBAT: "0.31",
});

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
  // WeAct "Black Pill" STM32F411CEU6 (100 MHz, 512 KB flash), STM32duino GenF4 BLACKPILL_F411CE.
  // Serial = USART1 (PA9 / PA10), Wire = I2C1 (PB7 / PB6), SPI = SPI1 (PA7 / PA6 / PA5, SS PA4),
  // LED PC13 (active low), KEY button PA0 (to GND).
  "stm32-blackpill-f411": {
    type: "stm32-blackpill-f411",
    chip: "stm32f411ce",
    platform: "/jumper/platforms/blackpill-f411.repl",
    console: "usart1",
    clockHz: 100_000_000,
    vcc: 3.3,
    pins: { ...port("PA", "gpioPortA", range(0, 15)), ...port("PB", "gpioPortB", [...range(0, 10), ...range(12, 15)]), ...port("PC", "gpioPortC", [13, 14, 15]) },
    adc: STM32_ADC1("adc1"),
    i2c: { controller: "i2c1", sda: "PB7", scl: "PB6" },
    spi: { controller: "spi1", mosi: "PA7", miso: "PA6", sck: "PA5", ss: "PA4" },
    fqbn: "STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F411CE",
  },
  // ST Nucleo-F401RE (84 MHz). Arduino headers: D0 PA3, D1 PA2 (Serial = USART2, through the ST-LINK
  // USB), D14 / D15 = PB9 / PB8 (Wire = I2C1), D11 / D12 / D13 = PA7 / PA6 / PA5 (SPI1, SS D10 = PB6),
  // LD2 = PA5, B1 = PC13 (active low).
  "stm32-nucleo-f401re": {
    type: "stm32-nucleo-f401re",
    chip: "stm32f401re",
    platform: "/jumper/platforms/nucleo-f401re.repl",
    console: "usart2",
    clockHz: 84_000_000,
    vcc: 3.3,
    pins: { ...port("PA", "gpioPortA", range(0, 15)), ...port("PB", "gpioPortB", range(0, 15)), ...port("PC", "gpioPortC", range(0, 15)), PD2: { gpio: "gpioPortD", pin: 2 } },
    adc: { ...STM32_ADC1("adc1"), PC0: { adc: "adc1", channel: 10 }, PC1: { adc: "adc1", channel: 11 }, PC2: { adc: "adc1", channel: 12 }, PC3: { adc: "adc1", channel: 13 }, PC4: { adc: "adc1", channel: 14 }, PC5: { adc: "adc1", channel: 15 } },
    i2c: { controller: "i2c1", sda: "PB9", scl: "PB8" },
    spi: { controller: "spi1", mosi: "PA7", miso: "PA6", sck: "PA5", ss: "PB6" },
    fqbn: "STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE",
  },
  // Arduino Nano 33 BLE (nRF52840, 64 MHz), arduino:mbed_nano. Serial is USB CDC on the real board;
  // the simulator build prints it on Serial1 (UARTE0 = Renode uart0, D0 / D1). Wire = TWI0 on A4 / A5,
  // SPI = SPIM2 on D11 / D12 / D13 (SS D10).
  "arduino-nano-33-ble": {
    type: "arduino-nano-33-ble",
    chip: "nrf52840",
    platform: "/jumper/platforms/nrf52840.repl",
    csharp: ["JumperNrf52.cs"],
    console: "uart0",
    clockHz: 64_000_000,
    vcc: 3.3,
    pins: NANO33BLE_PINS,
    adc: nrfAdc(NANO33BLE_PINS),
    i2c: { controller: "twi0", sda: "A4", scl: "A5" },
    spi: { controller: "spi2", mosi: "D11", miso: "D12", sck: "D13", ss: "D10" },
    fqbn: "arduino:mbed_nano:nano33ble",
  },
  // Seeed XIAO nRF52840 (64 MHz), Seeeduino:nrf52 (Adafruit nRF52 core). The build is Nordic's MBR +
  // S140 SoftDevice + the app as one Intel HEX, booted through the MBR like the real board (without
  // the UF2 bootloader). Serial is USB CDC on the real board; the simulator build prints it on Serial1
  // (UARTE0, D6 / D7). Wire = TWIM0 on D4 / D5, SPI = SPIM2 on D10 / D9 / D8.
  "seeed-xiao-nrf52840": {
    type: "seeed-xiao-nrf52840",
    chip: "nrf52840",
    platform: "/jumper/platforms/nrf52840.repl",
    csharp: ["JumperNrf52.cs"],
    console: "uart0",
    clockHz: 64_000_000,
    vcc: 3.3,
    pins: XIAO_NRF_PINS,
    adc: nrfAdc(XIAO_NRF_PINS),
    i2c: { controller: "twi0", sda: "D4", scl: "D5" },
    spi: { controller: "spi2", mosi: "D10", miso: "D9", sck: "D8", ss: "D7" },
    fqbn: "Seeeduino:nrf52:xiaonRF52840",
    firmware: "ihex",
    erasedFlash: [{ start: 0, size: 0x100000 }],
    vectorTableOffset: 0,
    // FreeRTOS's tickless idle waits in WFE for an interrupt the SoftDevice keeps masked; Renode does
    // not wake WFE for it, so WFE runs as a no-op (the idle loop spins: slower, same virtual timing).
    cpuSettings: ["WfeAndSevAsNop true"],
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
