// avr8js-backed McuBackend for ATmega328P boards (Arduino Uno / Nano).
// Deterministic: time is the CPU cycle counter only; no wall clock, no randomness.
import {
  AVRADC,
  AVRClock,
  AVREEPROM,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  AVRWatchdog,
  CPU,
  EEPROMMemoryBackend,
  adcConfig,
  avrInstruction,
  clockConfig,
  eepromConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  watchdogConfig,
} from "avr8js";
import { parseIntelHex, type McuBackend, type PinMode, type PinState, type Unsubscribe } from "@jumper/sim-core";
import { boardPinMap, type BoardPin, type BoardType } from "./pins.ts";

export interface AvrBackendOptions {
  /** Only "atmega328p" (Uno/Nano) in M0. */
  chip?: "atmega328p";
  /** Default 16_000_000. */
  clockHz?: number;
  /** Default 5. Also used as AVCC for the ADC. */
  vcc?: number;
  /** Pin naming. Default "uno" (D0..D13, A0..A5); "nano" adds analog-only A6/A7. */
  board?: BoardType;
}

const FLASH_BYTES = 32 * 1024;
const SRAM_BYTES = 2048;
const EEPROM_BYTES = 1024;
/** ATmega328P datasheet input thresholds at 5 V: VIL max 0.3·VCC, VIH min 0.6·VCC. Between them the pin keeps its last level (hysteresis). */
const VIL = 0.3;
const VIH = 0.6;

/**
 * What this backend models, as data. The board parts' fidelity.json files are checked against
 * it (packages/parts/src/fidelity.crosscheck.test.ts), so the user-facing fidelity card cannot
 * drift from the code. Change both together.
 */
export const AVR_BACKEND_FACTS = {
  /** Digital input thresholds as fractions of VCC; between them the last level is kept. */
  inputThresholds: { low: VIL, high: VIH, hysteresis: true },
  peripherals: {
    gpio: true,
    timers: true,
    usart: true,
    adc: true,
    watchdog: true,
    spi: false,
    twi: false,
  },
} as const;

interface Machine {
  cpu: CPU;
  ports: { B: AVRIOPort; C: AVRIOPort; D: AVRIOPort };
  adc: AVRADC;
  usart: AVRUSART;
}

type PinListener = (pinId: string, state: PinState, cycle: number) => void;
type SerialListener = (byte: number, cycle: number) => void;

class AvrBackend implements McuBackend {
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];

  private readonly pins: readonly BoardPin[];
  private readonly pinById: ReadonlyMap<string, BoardPin>;
  private program = new Uint16Array(FLASH_BYTES / 2);
  private m: Machine;
  /** Last reported state per pin id (to report only real changes). */
  private reported = new Map<string, string>();
  /** Last input level per pin id (for threshold hysteresis); survives reset like the outside world does. */
  private inputLevel = new Map<string, boolean>();
  private inputVolts = new Map<string, number>();
  private pinListeners = new Set<PinListener>();
  private serialListeners = new Set<SerialListener>();

  constructor(opts: AvrBackendOptions) {
    if (opts.chip !== undefined && opts.chip !== "atmega328p") {
      throw new Error(`avr8js backend: chip '${String(opts.chip)}' is not supported yet (only atmega328p)`);
    }
    this.cyclesPerSecond = opts.clockHz ?? 16_000_000;
    this.vcc = opts.vcc ?? 5;
    this.pins = boardPinMap(opts.board ?? "uno");
    this.pinIds = this.pins.map((p) => p.id);
    this.pinById = new Map(this.pins.map((p) => [p.id, p]));
    this.m = this.build();
  }

  get cycles(): number {
    return this.m.cpu.cycles;
  }

  load(firmware: Uint8Array | string): void {
    const image = typeof firmware === "string" ? parseIntelHex(firmware) : firmware;
    if (image.length > FLASH_BYTES) {
      throw new Error(`firmware is ${image.length} bytes but the ATmega328P has ${FLASH_BYTES} bytes of flash`);
    }
    const bytes = new Uint8Array(FLASH_BYTES).fill(0xff);
    bytes.set(image);
    this.program = new Uint16Array(bytes.buffer);
    this.reset();
  }

  reset(): void {
    this.m = this.build();
  }

  step(cycles: number): void {
    const cpu = this.m.cpu;
    const target = cpu.cycles + Math.max(0, Math.floor(cycles));
    while (cpu.cycles < target) {
      avrInstruction(cpu);
      cpu.tick();
    }
  }

  readPin(pinId: string): PinState {
    return this.stateOf(this.pin(pinId));
  }

  setPinInput(pinId: string, volts: number): void {
    const pin = this.pin(pinId);
    this.inputVolts.set(pin.id, volts);
    if (pin.adc !== undefined) this.m.adc.channelValues[pin.adc] = clampVolts(volts, this.vcc);
    if (pin.port === undefined || pin.bit === undefined) return;
    const prev = this.inputLevel.get(pin.id) ?? false;
    const level = volts >= VIH * this.vcc ? true : volts <= VIL * this.vcc ? false : prev;
    this.inputLevel.set(pin.id, level);
    // setPin only updates the PIN register (and pin-change / external interrupts); it never calls
    // the GPIO listeners, so this does not fire onPinChange (contract).
    this.m.ports[pin.port].setPin(pin.bit, level);
  }

  onPinChange(cb: PinListener): Unsubscribe {
    this.pinListeners.add(cb);
    return () => void this.pinListeners.delete(cb);
  }

  onSerial(cb: SerialListener): Unsubscribe {
    this.serialListeners.add(cb);
    return () => void this.serialListeners.delete(cb);
  }

  writeSerial(byte: number): void {
    this.m.usart.writeByte(byte & 0xff);
  }

  // ---------------------------------------------------------------- internals

  private pin(pinId: string): BoardPin {
    const pin = this.pinById.get(pinId);
    if (!pin) throw new Error(`avr8js backend: unknown pin '${pinId}' (pins: ${this.pinIds.join(", ")})`);
    return pin;
  }

  private stateOf(pin: BoardPin): PinState {
    if (pin.port === undefined || pin.bit === undefined) {
      // Analog-only pin (Nano A6/A7): no digital buffer.
      return { mode: "analog", value: 0 };
    }
    const { cpu, ports } = this.m;
    const cfg = ports[pin.port].portConfig;
    const mask = 1 << pin.bit;
    const ddr = cpu.data[cfg.DDR]! & mask;
    let mode: PinMode;
    let value: 0 | 1;
    if (ddr) {
      mode = "output";
      // pinState() includes timer compare-output overrides (PWM), unlike the PORT register.
      value = ports[pin.port].pinState(pin.bit) === 1 ? 1 : 0;
    } else {
      mode = cpu.data[cfg.PORT]! & mask ? "input_pullup" : "input";
      value = cpu.data[cfg.PIN]! & mask ? 1 : 0;
    }
    return { mode, value };
  }

  private build(): Machine {
    const cpu = new CPU(new Uint16Array(this.program), SRAM_BYTES);
    const ports = {
      B: new AVRIOPort(cpu, portBConfig),
      C: new AVRIOPort(cpu, portCConfig),
      D: new AVRIOPort(cpu, portDConfig),
    };
    const clock = new AVRClock(cpu, this.cyclesPerSecond, clockConfig);
    new AVRTimer(cpu, timer0Config);
    new AVRTimer(cpu, timer1Config);
    new AVRTimer(cpu, timer2Config);
    new AVREEPROM(cpu, new EEPROMMemoryBackend(EEPROM_BYTES), eepromConfig);
    new AVRWatchdog(cpu, watchdogConfig, clock);
    const adc = new AVRADC(cpu, adcConfig);
    adc.avcc = this.vcc;
    const usart = new AVRUSART(cpu, usart0Config, this.cyclesPerSecond);
    usart.onByteTransmit = (byte: number) => {
      const cycle = cpu.cycles;
      for (const cb of this.serialListeners) cb(byte, cycle);
    };

    // Re-apply what the outside world drives onto the fresh chip.
    for (const pin of this.pins) {
      if (pin.adc !== undefined) adc.channelValues[pin.adc] = clampVolts(this.inputVolts.get(pin.id) ?? 0, this.vcc);
      if (pin.port !== undefined && pin.bit !== undefined && this.inputLevel.get(pin.id)) ports[pin.port].setPin(pin.bit, true);
    }

    const m: Machine = { cpu, ports, adc, usart };
    this.m = m;
    this.reported.clear();
    for (const pin of this.pins) this.reported.set(pin.id, key(this.stateOf(pin)));

    for (const name of ["B", "C", "D"] as const) {
      const portPins = this.pins.filter((p) => p.port === name);
      ports[name].addListener(() => {
        if (this.m !== m) return;
        for (const pin of portPins) {
          const state = this.stateOf(pin);
          const k = key(state);
          if (this.reported.get(pin.id) === k) continue;
          this.reported.set(pin.id, k);
          const cycle = cpu.cycles;
          for (const cb of this.pinListeners) cb(pin.id, state, cycle);
        }
      });
    }
    return m;
  }
}

/** Change key: outputs change on level, inputs only on mode (input levels come from setPinInput, which must not fire). */
function key(s: PinState): string {
  return s.mode === "output" ? `output:${s.value}` : s.mode;
}

function clampVolts(v: number, vcc: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), vcc) : 0;
}

/** avr8js-backed McuBackend (Arduino Uno pin names: D0..D13, A0..A5). */
export function createAvrBackend(opts: AvrBackendOptions = {}): McuBackend {
  return new AvrBackend(opts);
}
