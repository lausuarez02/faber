// Boards the Renode backend can run. A board here is what Jumper needs on top of Renode's own
// platform (.repl): which platform file, which UART is the console, and how Jumper pin ids map onto
// Renode GPIO peripherals. Visuals and pin positions stay in the board part (packages/parts).

/** A Jumper pin id → the Renode GPIO peripheral (path under sysbus) and pin number on it. */
export interface RenodePin {
  gpio: string;
  pin: number;
}

export interface RenodeBoard {
  type: string;
  /** Platform description: a path inside the Renode install ("platforms/…"), or one of ours ("/jumper/platforms/…"). */
  platform: string;
  /** Console UART, path under sysbus. */
  uart: string;
  /** Nominal core clock, only used to express Renode's ns time as cycles for McuBackend.cycles. */
  clockHz: number;
  vcc: number;
  pins: Readonly<Record<string, RenodePin>>;
  /** Input levels to hold at reset, e.g. the I2C pull-ups a real board has (Jumper's circuit solver would drive these). */
  pullUps?: readonly string[];
  /** Arduino FQBN that builds firmware for it. */
  fqbn: string;
  /** Verified in the round 9 spike (boot + UART seen), or listed only. */
  verified: boolean;
}

function port(prefix: string, gpio: string, from: number, to: number): Record<string, RenodePin> {
  const out: Record<string, RenodePin> = {};
  for (let i = from; i <= to; i++) out[`${prefix}${i}`] = { gpio, pin: i };
  return out;
}

export const RENODE_BOARDS = {
  "bluepill-f103c8": {
    type: "bluepill-f103c8",
    platform: "/jumper/platforms/bluepill.repl",
    uart: "usart1",
    clockHz: 72_000_000,
    vcc: 3.3,
    pins: { ...port("PA", "gpioPortA", 0, 15), ...port("PB", "gpioPortB", 0, 15), ...port("PC", "gpioPortC", 13, 15) },
    pullUps: ["PB6", "PB7"],
    fqbn: "STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8",
    verified: true,
  },
  // Arduino Nano 33 BLE (nRF52840), arduino:mbed_nano. Pin map from the core's variant
  // (D0..D13, A0..A7, LEDs); D-numbers to nRF P0.xx/P1.xx. Renode's board file wires LEDs and the
  // LSM9DS1 IMU on twi0. Serial1 = UARTE0 = Renode uart0.
  "arduino-nano-33-ble": {
    type: "arduino-nano-33-ble",
    platform: "platforms/boards/arduino_nano_33_ble.repl",
    uart: "uart0",
    clockHz: 64_000_000,
    vcc: 3.3,
    pins: {
      D0: { gpio: "gpio1", pin: 3 },
      D1: { gpio: "gpio1", pin: 10 },
      D2: { gpio: "gpio1", pin: 11 },
      D3: { gpio: "gpio1", pin: 12 },
      D4: { gpio: "gpio1", pin: 15 },
      D5: { gpio: "gpio1", pin: 13 },
      D6: { gpio: "gpio1", pin: 14 },
      D7: { gpio: "gpio0", pin: 23 },
      D8: { gpio: "gpio0", pin: 21 },
      D9: { gpio: "gpio0", pin: 27 },
      D10: { gpio: "gpio1", pin: 2 },
      D11: { gpio: "gpio1", pin: 1 },
      D12: { gpio: "gpio1", pin: 8 },
      D13: { gpio: "gpio0", pin: 13 },
      A0: { gpio: "gpio0", pin: 4 },
      A1: { gpio: "gpio0", pin: 5 },
      A2: { gpio: "gpio0", pin: 30 },
      A3: { gpio: "gpio0", pin: 29 },
      A4: { gpio: "gpio0", pin: 31 },
      A5: { gpio: "gpio0", pin: 2 },
      A6: { gpio: "gpio0", pin: 28 },
      A7: { gpio: "gpio0", pin: 3 },
      LEDR: { gpio: "gpio0", pin: 24 },
      LEDG: { gpio: "gpio0", pin: 16 },
      LEDB: { gpio: "gpio0", pin: 6 },
    },
    fqbn: "arduino:mbed_nano:nano33ble",
    verified: true,
  },
} as const satisfies Record<string, RenodeBoard>;

export type RenodeBoardType = keyof typeof RENODE_BOARDS;

export function renodeBoardOf(type: string): RenodeBoard | undefined {
  return (RENODE_BOARDS as Record<string, RenodeBoard>)[type];
}
