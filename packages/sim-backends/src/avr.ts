// avr8js-backed McuBackend for ATmega328P boards (Arduino Uno / Nano).
// Deterministic: time is the CPU cycle counter only; no wall clock, no randomness.
import {
  AVRADC,
  AVRClock,
  AVREEPROM,
  AVRIOPort,
  AVRSPI,
  AVRTWI,
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
  spiConfig,
  twiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  watchdogConfig,
} from "avr8js";
import {
  parseIntelHex,
  type I2cBus,
  type McuBackend,
  type McuBusPins,
  type PinMode,
  type PinState,
  type SpiBus,
  type Unsubscribe,
} from "@jumper/sim-core";
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
    spi: true,
    twi: true,
  },
  /** TWI (I2C master) timing: each START/STOP takes one SCL period, each address/data byte nine. */
  twiBitsPerByte: 9,
} as const;

/** ATmega328P hardware bus pins (Uno and Nano names). */
const BUS_PINS: McuBusPins = {
  i2c: { sda: "A4", scl: "A5" },
  spi: { mosi: "D11", miso: "D12", sck: "D13", ss: "D10" },
};

interface Machine {
  cpu: CPU;
  ports: { B: AVRIOPort; C: AVRIOPort; D: AVRIOPort };
  adc: AVRADC;
  usart: AVRUSART;
  twi: AVRTWI;
  spi: AVRSPI;
}

type PinListener = (pinId: string, state: PinState, cycle: number) => void;
type SerialListener = (byte: number, cycle: number) => void;

class AvrBackend implements McuBackend {
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];
  readonly busPins: McuBusPins = BUS_PINS;
  private i2cBus: I2cBus | undefined;
  private spiBus: SpiBus | undefined;

  private readonly pins: readonly BoardPin[];
  private readonly pinById: ReadonlyMap<string, BoardPin>;
  private program = new Uint16Array(FLASH_BYTES / 2);
  /** Target cycle of the step() in progress (0 outside step); lowered by stopAt(). */
  private stepEnd = 0;
  private m: Machine;
  /** Last reported state per pin id (to report only real changes). */
  private reported = new Map<string, string>();
  /** Last input level per pin id (for threshold hysteresis); survives reset like the outside world does. */
  private inputLevel = new Map<string, boolean>();
  private inputVolts = new Map<string, number>();
  private pinListeners = new Set<PinListener>();
  private serialListeners = new Set<SerialListener>();
  /**
   * Round 7 (voice): the hardware USART on its pins. Off until a part listens to D1 (pinWatched),
   * then every transmitted byte is also put on D1 bit by bit (start, 8 data bits LSB first, stop)
   * at the USART's baud rate, and edges on D0 are decoded into the receiver. Survives reset (the
   * wiring does not change).
   */
  private uartPins = false;
  private uartTx: { queue: number[]; bits: number[]; level: 0 | 1; busy: boolean } = { queue: [], bits: [], level: 1, busy: false };
  private uartRx: { start: number; edges: [number, 0 | 1][] } = { start: -1, edges: [] };

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
    // A transfer cut off by the reset ends the transaction on the bus too.
    this.i2cBus?.stop();
    this.m = this.build();
  }

  step(cycles: number): void {
    const cpu = this.m.cpu;
    this.stepEnd = cpu.cycles + Math.max(0, Math.floor(cycles));
    while (cpu.cycles < this.stepEnd) {
      avrInstruction(cpu);
      cpu.tick();
    }
    this.stepEnd = 0;
  }

  /** End the current step() at `cycle` (see McuBackend.stopAt). No-op outside step() or for a later cycle. */
  stopAt(cycle: number): void {
    if (cycle < this.stepEnd) this.stepEnd = Math.max(this.m.cpu.cycles, Math.floor(cycle));
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
    if (this.uartPins && pin.id === "D0" && level !== prev) this.uartRxEdge(level ? 1 : 0);
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

  attachI2c(bus: I2cBus): void {
    this.i2cBus = bus;
  }

  attachSpi(bus: SpiBus): void {
    this.spiBus = bus;
  }

  writeSerial(byte: number): void {
    this.m.usart.writeByte(byte & 0xff);
  }

  /** Round 7 (voice): a part listens to D1 (the USART's TX pin), so put Serial on the pins from now on. */
  pinWatched(pinId: string): void {
    if (pinId !== "D1" || this.uartPins) return;
    this.uartPins = true;
    this.reportPin(this.pin("D1"));
  }

  // ---------------------------------------------------------------- USART on pins (round 7 voice)

  private uartTxByte(byte: number): void {
    const tx = this.uartTx;
    tx.queue.push(byte & 0xff);
    if (!tx.busy) {
      tx.busy = true;
      this.uartNextBit();
    }
  }

  private uartNextBit(): void {
    const m = this.m;
    const tx = this.uartTx;
    const baud = m.usart.baudRate;
    if (tx.bits.length === 0) {
      const b = tx.queue.shift();
      if (b === undefined || !Number.isFinite(baud) || baud <= 0) {
        tx.queue = [];
        tx.busy = false;
        return;
      }
      tx.bits = [0, ...Array.from({ length: 8 }, (_, i) => (b >> i) & 1), 1];
    }
    tx.level = tx.bits.shift() === 1 ? 1 : 0;
    this.reportPin(this.pin("D1"));
    m.cpu.addClockEvent(() => {
      if (this.m === m) this.uartNextBit();
    }, Math.max(1, Math.round(this.cyclesPerSecond / baud)));
  }

  private uartRxEdge(level: 0 | 1): void {
    const m = this.m;
    const rx = this.uartRx;
    const now = m.cpu.cycles;
    if (rx.start >= 0) {
      rx.edges.push([now, level]);
      return;
    }
    if (level !== 0) return;
    const baud = m.usart.baudRate;
    if (!Number.isFinite(baud) || baud <= 0) return;
    rx.start = now;
    rx.edges = [];
    const bit = this.cyclesPerSecond / baud;
    m.cpu.addClockEvent(() => {
      if (this.m !== m) return;
      const at = (t: number): 0 | 1 => {
        let l: 0 | 1 = 0;
        for (const [et, v] of rx.edges) {
          if (et > t) break;
          l = v;
        }
        return l;
      };
      let byte = 0;
      for (let i = 0; i < 8; i++) if (at(rx.start + (1.5 + i) * bit)) byte |= 1 << i;
      const stopOk = at(rx.start + 9.5 * bit) === 1;
      const last = rx.edges[rx.edges.length - 1];
      rx.start = -1;
      rx.edges = [];
      if (stopOk && m.usart.rxEnable) m.usart.writeByte(byte, true);
      // The line fell again inside this frame's stop bit: that edge was the next start bit.
      if (!stopOk && last && last[1] === 0) this.uartRxEdge(0);
    }, Math.max(1, Math.round(9.5 * bit)));
  }

  /** Report a pin's state to the listeners when it changed (outside the port listeners). */
  private reportPin(pin: BoardPin): void {
    const state = this.stateOf(pin);
    const k = key(state);
    if (this.reported.get(pin.id) === k) return;
    this.reported.set(pin.id, k);
    const cycle = this.m.cpu.cycles;
    for (const cb of this.pinListeners) cb(pin.id, state, cycle);
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
    // Round 7 (voice): with the USART on its pins, D1 is the transmitter's output while TXEN is set.
    if (this.uartPins && pin.id === "D1" && this.m.usart.txEnable) return { mode: "output", value: this.uartTx.level };
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

  private twiHandler(cpu: CPU, twi: AVRTWI): TwiHandler {
    // SCL period in CPU cycles: 16 + 2·TWBR·prescaler (ATmega328P datasheet, 22.5.2). Wire's
    // default 100 kHz is TWBR = 72 → 160 cycles per bit at 16 MHz, 1440 cycles (90 µs) per byte.
    const bit = () => Math.max(1, Math.round(this.cyclesPerSecond / twi.sclFrequency));
    const later = (cycles: number, fn: () => void) =>
      cpu.addClockEvent(() => {
        if (this.m.cpu === cpu) fn();
      }, cycles);
    const bytes = AVR_BACKEND_FACTS.twiBitsPerByte;
    return {
      start: (repeated) =>
        later(bit(), () => {
          this.i2cBus?.start(repeated);
          twi.completeStart();
        }),
      stop: () =>
        later(bit(), () => {
          this.i2cBus?.stop();
          twi.completeStop();
        }),
      connectToSlave: (addr, write) =>
        later(bytes * bit(), () => {
          twi.completeConnect(this.i2cBus ? this.i2cBus.connect(addr, !write) : false);
        }),
      writeByte: (value) =>
        later(bytes * bit(), () => {
          twi.completeWrite(this.i2cBus ? this.i2cBus.write(value) : false);
        }),
      readByte: (ack) =>
        later(bytes * bit(), () => {
          twi.completeRead(this.i2cBus ? this.i2cBus.read(ack) : 0xff);
        }),
    };
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
      if (this.uartPins && this.m.cpu === cpu) this.uartTxByte(byte);
    };
    // Round 7 (voice): a fresh chip has an idle line; Serial.begin() sets TXEN, which drives D1 high.
    this.uartTx = { queue: [], bits: [], level: 1, busy: false };
    this.uartRx = { start: -1, edges: [] };
    usart.onConfigurationChange = () => {
      if (this.uartPins && this.m.cpu === cpu) this.reportPin(this.pin("D1"));
    };

    // Re-apply what the outside world drives onto the fresh chip.
    for (const pin of this.pins) {
      if (pin.adc !== undefined) adc.channelValues[pin.adc] = clampVolts(this.inputVolts.get(pin.id) ?? 0, this.vcc);
      if (pin.port !== undefined && pin.bit !== undefined && this.inputLevel.get(pin.id)) ports[pin.port].setPin(pin.bit, true);
    }

    const twi = new AVRTWI(cpu, twiConfig, this.cyclesPerSecond);
    twi.eventHandler = this.twiHandler(cpu, twi);
    const spi = new AVRSPI(cpu, spiConfig, this.cyclesPerSecond);
    spi.onByte = (value: number) => {
      // The byte is on the wire for transferCycles (8 SCK periods); the device answers at the end.
      cpu.addClockEvent(() => {
        if (this.m.cpu !== cpu) return;
        const miso = this.spiBus ? this.spiBus.transfer(value) : 0xff;
        spi.completeTransfer(miso);
      }, spi.transferCycles);
    };

    const m: Machine = { cpu, ports, adc, usart, twi, spi };
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

/** Drives the logical I2C bus from the TWI peripheral, with the time each step takes on the wire. */
export interface TwiHandler {
  start(repeated: boolean): void;
  stop(): void;
  connectToSlave(addr: number, write: boolean): void;
  writeByte(value: number): void;
  readByte(ack: boolean): void;
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
