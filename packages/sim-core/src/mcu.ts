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
}

/** Creates a backend for a board part. `spec.mcu.backend` says which one (e.g. "avr8js"). */
export type BackendFactory = (board: {
  partId: string;
  type: string;
  mcu: { backend: string; chip: string; clockHz: number; vcc: number; fqbn?: string | undefined };
}) => McuBackend;
