import type { I2cBus, McuBusPins, SpiBus } from "./bus.ts";
import type { I2sBus } from "./i2s.ts";

export type PinMode = "input" | "input_pullup" | "output" | "analog";

export interface PinState {
  mode: PinMode;
  /** Digital level. For "output" the driven level; for inputs the level the MCU currently reads. */
  value: 0 | 1;
}

export type Unsubscribe = () => void;

/**
 * A CPU emulator adapter (implemented in @jumper/sim-backends, e.g. avr8js).
 * All time is in MCU cycles; backends never read the wall clock.
 */
export interface McuBackend {
  /** Clock frequency, e.g. 16_000_000 for an Uno. */
  readonly cyclesPerSecond: number;
  /** Cycles executed since the last reset(). */
  readonly cycles: number;
  /** Logic supply voltage used for thresholds and output levels, e.g. 5. */
  readonly vcc: number;
  /** GPIO pin ids this backend exposes, e.g. ["D0", …, "D13", "A0", …, "A5"]. Board part pin ids use the same names. */
  readonly pinIds: readonly string[];
  /** Load a program: Intel HEX text, or a raw flash image. Resets the CPU. */
  load(firmware: Uint8Array | string): void;
  /** Run for `cycles` cycles. May overshoot by the length of the last instruction; read `cycles` after. */
  step(cycles: number): void;
  readPin(pinId: string): PinState;
  /** Drive an input pin with a voltage. The backend thresholds it to a logic level and/or feeds the ADC. */
  setPinInput(pinId: string, volts: number): void;
  /** Called synchronously (inside step) whenever a pin's mode or output value changes. */
  onPinChange(cb: (pinId: string, state: PinState, cycle: number) => void): Unsubscribe;
  /** Called synchronously for every byte the firmware transmits on the default UART. */
  onSerial(cb: (byte: number, cycle: number) => void): Unsubscribe;
  /** Optional: feed a byte into the default UART RX. */
  writeSerial?(byte: number): void;
  /** Reset CPU and peripherals, keep the loaded program, cycles → 0. */
  reset(): void;
  /** Optional: which pins the hardware I2C / SPI peripherals use (McuBackend pin ids). */
  readonly busPins?: McuBusPins;
  /**
   * Optional: connect the MCU's I2C master (e.g. AVR TWI) to a bus. The Simulation calls this once
   * after creating the backend; the backend keeps using the bus across reset().
   */
  attachI2c?(bus: I2cBus): void;
  /** Optional: connect the MCU's SPI master to a bus. Same lifetime as attachI2c. */
  attachSpi?(bus: SpiBus): void;
  /** Optional: connect the MCU's I2S peripheral (audio frames out and in). Same lifetime as attachI2c. */
  attachI2s?(bus: I2sBus): void;
  /**
   * Optional: which peripherals this backend actually emulates and carries to the circuit
   * ("gpio", "irq", "uart", "i2c", "spi", "pwm", "adc", "rmt", "i2s", "net"), so the fidelity
   * report and design checks can say "I2S is not emulated on this board" up front. Undefined means
   * the long-standing set of the in-process backends (gpio, uart, i2c, spi, pwm, adc).
   */
  readonly capabilities?: readonly string[];
  /**
   * Optional: end the step() in progress at `cycle` (or as soon as possible after it) instead of its
   * original target. The Simulation calls it, from inside a pin-change callback, when a part
   * schedules an event earlier than the end of the current step (an HC-SR04 raising ECHO 460 µs
   * after the trigger), so the firmware sees the change at the right cycle. Without it the event
   * still runs, but only after the step ends (up to chunkMs late).
   */
  stopAt?(cycle: number): void;
  /**
   * Optional (round 7 voice): the Simulation tells the backend that a part listens to the edges of
   * this pin (ctx.watch). The AVR backend then puts its hardware USART on D1 and reads D0 bit by
   * bit, so a part wired to the board's TX / RX hears Serial (without a listener the bytes only go
   * to the serial monitor and no pin toggles, which keeps plain Serial.print cheap).
   */
  pinWatched?(pinId: string): void;
}

/** Creates a backend for a board part. `spec.mcu.backend` says which one (e.g. "avr8js"). */
export type BackendFactory = (board: {
  partId: string;
  type: string;
  mcu: { backend: string; chip: string; clockHz: number; vcc: number; fqbn?: string | undefined };
}) => McuBackend;
