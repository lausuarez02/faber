// rp2040js-backed McuBackend for RP2040 boards (Raspberry Pi Pico, Seeed XIAO RP2040,
// Waveshare RP2040-Zero). Decision 0003, C1.
//
// Deterministic: the only time is VirtualClock, advanced by step() by the time each executed
// instruction takes at the firmware's clk_sys. `cycles` counts reference cycles at
// cyclesPerSecond (125 MHz), i.e. it is a time base: 125 000 cycles = 1 ms whatever clk_sys the
// firmware picks.
//
// What reaches the circuit:
//   GPIO (SIO), PWM slices and PIO drive pin levels; inputs come back through setPinInput with the
//   RP2040's thresholds (VIL 0.8 V, VIH 2.0 V, Schmitt trigger keeps the last level in between).
//   ADC0-3 (GP26-GP29) read the solved pin voltage against 3.3 V, 12 bits.
//   USB CDC (arduino-pico's `Serial`) is the console: onSerial / writeSerial.
//   UART0/1 (`Serial1`/`Serial2`) are bit-banged onto their TX pins at the configured baud rate and
//   decoded from their RX pins, so parts hear them through the wires like on hardware.
//   I2C0/1 and SPI0/1 carry whole bytes to the simulation's I2C / SPI bus when their pins are
//   muxed onto the board's bus pins (the ones the board part tags with i2c-sda, spi-sck…).
import { GPIOPinState, RP2040, USBCDC, type Logger } from "rp2040js";
import type { I2cBus, McuBackend, McuBusPins, PinMode, PinState, SpiBus, Unsubscribe } from "@jumper/sim-core";
import { RP2040_BOARDS, RP2040_PIN_IDS, type Rp2040Board, type Rp2040BoardType } from "./boards.ts";
import { VirtualClock } from "./clock.ts";
import { FLASH_BYTES, FirmwareImageError, parseRp2040Hex } from "./hex.ts";
import { PioClock } from "./pio.ts";
import { installRom } from "./rom.ts";
import { SoftI2cTarget } from "./soft-i2c.ts";

export interface Rp2040BackendOptions {
  /** Pin naming and default bus pins. Default "raspberry-pi-pico". */
  board?: Rp2040BoardType;
  /** Reference clock for `cycles` (Hz). Default 125 MHz (the RP2040's nominal clk_sys). */
  clockHz?: number;
  /** IOVDD. Default 3.3. */
  vcc?: number;
}

/** RP2040 datasheet, GPIO electrical characteristics at IOVDD = 3.3 V. */
const VIL = 0.8;
const VIH = 2.0;
const ADC_VREF = 3.3;
const ADC_MAX = 4095;
/** On-chip temperature sensor at 27 °C (datasheet 4.9.5): 0.706 V. */
const TEMP_SENSOR_VOLTS = 0.706;

const FUNC_SPI = 1;
const FUNC_UART = 2;
const FUNC_I2C = 3;
const FUNC_NULL = 0x1f;
/** IC_RAW_INTR_STAT.TX_EMPTY. */
const I2C_R_TX_EMPTY = 1 << 4;

/**
 * What this backend models, as data. The RP2040 boards' fidelity.json files are checked against it
 * (packages/parts/src/fidelity.crosscheck.test.ts). Change both together.
 */
export const RP2040_BACKEND_FACTS = {
  /** Digital input thresholds in volts at IOVDD 3.3 V; between them the last level is kept. */
  inputThresholds: { low: VIL, high: VIH, hysteresis: true },
  adc: { bits: 12, vref: ADC_VREF, channels: ["GP26", "GP27", "GP28", "GP29"] },
  peripherals: {
    gpio: true,
    pwm: true,
    adc: true,
    uart: true,
    i2c: true,
    spi: true,
    pio: true,
    usb: true,
    timers: true,
    dma: true,
    /** rp2040js emulates core 0 only: setup1()/loop1() never run. */
    core1: false,
  },
  /** I2C timing: START/STOP take one SCL period, each address/data byte nine. */
  i2cBitsPerByte: 9,
} as const;

type PinListener = (pinId: string, state: PinState, cycle: number) => void;
type SerialListener = (byte: number, cycle: number) => void;

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Which UART / SPI / I2C instance a GPIO's function belongs to (RP2040 datasheet 2.19.2 function table). */
const uartOf = (g: number) => ((g + 4) >> 3) & 1;
const spiOf = (g: number) => (g >> 3) & 1;
const i2cOf = (g: number) => (g >> 1) & 1;

interface UartTx {
  queue: number[];
  /** Bits left of the byte on the wire (start, 8 data, stop), LSB first. */
  bits: number[];
  level: 0 | 1;
  /** A bit is on the wire (an alarm will put the next one). */
  busy: boolean;
}

interface UartRx {
  start: number;
  edges: [number, 0 | 1][];
  alarm: { schedule(ns: number): void; cancel(): void } | undefined;
}

interface Machine {
  mcu: RP2040;
  clock: VirtualClock;
  cdc: USBCDC;
  /** Bit-banged I2C on the board's SDA/SCL pins (arduino-pico's address probe, software I2C). */
  soft: SoftI2cTarget;
  softActive: boolean;
  pio: PioClock;
  tx: [UartTx, UartTx];
  rx: Map<number, UartRx>;
}

class Rp2040Backend implements McuBackend {
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds = RP2040_PIN_IDS;
  readonly busPins: McuBusPins;
  readonly board: Rp2040Board;

  private readonly sdaG: number;
  private readonly sclG: number;
  private readonly nsPerCycle: number;
  private image: Uint8Array | undefined;
  private m: Machine;
  private i2cBus: I2cBus | undefined;
  private spiBus: SpiBus | undefined;
  private stepEndNs = 0;
  private romCycles = 0;
  /** Why the CPU stopped (a firmware BKPT / panic, reboot to BOOTSEL), or undefined while it runs. */
  halted: string | undefined;
  private reported = new Map<number, string>();
  private inputLevel = new Map<number, boolean>();
  private inputVolts = new Map<number, number>();
  private pinListeners = new Set<PinListener>();
  private serialListeners = new Set<SerialListener>();

  constructor(opts: Rp2040BackendOptions) {
    this.board = RP2040_BOARDS[opts.board ?? "raspberry-pi-pico"];
    this.busPins = this.board.bus;
    this.sdaG = Number(this.board.bus.i2c.sda.slice(2));
    this.sclG = Number(this.board.bus.i2c.scl.slice(2));
    this.cyclesPerSecond = opts.clockHz ?? 125_000_000;
    this.vcc = opts.vcc ?? 3.3;
    this.nsPerCycle = 1e9 / this.cyclesPerSecond;
    this.m = this.build();
  }

  get cycles(): number {
    return Math.floor(this.m.clock.nanos / this.nsPerCycle + 1e-6);
  }

  load(firmware: Uint8Array | string): void {
    if (typeof firmware === "string") {
      this.image = parseRp2040Hex(firmware).image;
    } else {
      if (firmware.length > FLASH_BYTES) throw new FirmwareImageError(`the firmware image is ${firmware.length} bytes, larger than the 2 MB flash. Why: it is not an RP2040 flash image. Fix: build the sketch for the board and load the .hex.`);
      const img = new Uint8Array(FLASH_BYTES).fill(0xff);
      img.set(firmware);
      this.image = img;
    }
    this.reset();
  }

  reset(): void {
    this.i2cBus?.stop();
    this.m = this.build();
  }

  step(cycles: number): void {
    const { mcu, clock } = this.m;
    const core = mcu.core;
    this.stepEndNs = (this.cycles + Math.max(0, Math.floor(cycles))) * this.nsPerCycle;
    const pio = this.m.pio;
    while (clock.nanos < this.stepEndNs) {
      if (this.halted !== undefined || core.waiting || this.image === undefined) {
        // WFI/WFE (delay(), idle loops) or a stopped CPU: jump to the next alarm or PIO instruction
        // instead of spinning.
        const next = Math.min(clock.nextAlarmAt ?? Infinity, pio.nextAt, this.stepEndNs);
        pio.runUntil(next);
        clock.advanceTo(next);
        continue;
      }
      const c = core.executeInstruction();
      const extra = this.romCycles;
      this.romCycles = 0;
      const t = clock.nanos + ((c + extra) * 1e9) / mcu.clkSys;
      if (pio.nextAt <= t) pio.runUntil(t);
      clock.advanceTo(t);
    }
    this.stepEndNs = 0;
  }

  stopAt(cycle: number): void {
    const ns = cycle * this.nsPerCycle;
    if (ns < this.stepEndNs) this.stepEndNs = Math.max(this.m.clock.nanos, ns);
  }

  readPin(pinId: string): PinState {
    return this.stateOf(this.gpio(pinId));
  }

  setPinInput(pinId: string, volts: number): void {
    this.applyInput(this.gpio(pinId), volts);
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
    this.m.cdc.sendSerialByte(byte & 0xff);
  }

  attachI2c(bus: I2cBus): void {
    this.i2cBus = bus;
  }

  attachSpi(bus: SpiBus): void {
    this.spiBus = bus;
  }

  // ---------------------------------------------------------------- internals

  private gpio(pinId: string): number {
    const m = /^GP(\d{1,2})$/.exec(pinId);
    const n = m ? Number(m[1]) : -1;
    if (n < 0 || n > 29) throw new Error(`rp2040js backend: unknown pin '${pinId}'. Why: RP2040 pins are named GP0 to GP29 (the arduino-pico pin number is the GPIO number). Fix: use e.g. "GP25".`);
    return n;
  }

  private applyInput(g: number, volts: number): void {
    const { mcu } = this.m;
    this.inputVolts.set(g, volts);
    if (g >= 26) mcu.adc.channelValues[g - 26] = adcCode(volts);
    const prev = this.inputLevel.get(g) ?? false;
    const level = volts >= VIH ? true : volts <= VIL ? false : prev;
    this.inputLevel.set(g, level);
    if (level !== prev && mcu.gpio[g]!.functionSelect === FUNC_UART && g % 4 === 1) this.uartRxEdge(g, level ? 1 : 0);
    if ((g === this.sdaG || g === this.sclG) && this.softPins()) return;
    // setInputValue updates the input register, interrupts, PWM gates and PIO waits; it never
    // changes what the pin drives, so it does not fire onPinChange (contract).
    mcu.gpio[g]!.setInputValue(level);
    this.m.pio.wake();
  }

  private stateOf(g: number): PinState {
    const { mcu } = this.m;
    const pin = mcu.gpio[g]!;
    const fs = pin.functionSelect;
    if (fs === FUNC_UART && g % 4 === 0) return { mode: "output", value: this.m.tx[uartOf(g) as 0 | 1].level };
    if (fs === FUNC_SPI) {
      // Bytes travel on the SPI bus model; the clock and data outputs idle low, CSn high.
      const role = g % 4;
      if (role === 2 || role === 3) return { mode: "output", value: 0 };
      if (role === 1) return { mode: "output", value: 1 };
    }
    if (fs === FUNC_NULL && !pin.inputEnable && !pin.outputEnable) return { mode: "analog", value: 0 };
    const v = pin.value;
    if (v === GPIOPinState.High) return { mode: "output", value: 1 };
    if (v === GPIOPinState.Low) return { mode: "output", value: 0 };
    const mode: PinMode = v === GPIOPinState.InputPullUp ? "input_pullup" : "input";
    return { mode, value: this.inputLevel.get(g) ? 1 : 0 };
  }

  private report(g: number): void {
    const state = this.stateOf(g);
    const k = key(state);
    if (this.reported.get(g) === k) return;
    this.reported.set(g, k);
    const cycle = this.cycles;
    const id = `GP${g}`;
    for (const cb of this.pinListeners) cb(id, state, cycle);
  }

  /** What the MCU itself does to a line: 0 when it drives it low, 1 when it drives it high or lets go. */
  private mcuLevel(g: number): 0 | 1 {
    const st = this.stateOf(g);
    return st.mode === "output" ? st.value : 1;
  }

  /**
   * While SDA and SCL are plain GPIOs (or PIO) and an I2C part is on the bus, decode the bits the
   * firmware bit-bangs and answer like the device would. The MCU then reads the bus lines from the
   * decoder (its own drive plus the device's ACK / data), not from the circuit solve, which may
   * average fast edges. Returns true while it owns the two inputs.
   */
  private softPins(): boolean {
    const m = this.m;
    const fs = (g: number) => m.mcu.gpio[g]!.functionSelect;
    const sio = (g: number) => fs(g) >= 5 && fs(g) <= 7;
    const active = sio(this.sdaG) && sio(this.sclG) && (this.i2cBus?.list().length ?? 0) > 0;
    if (!active) {
      if (m.softActive) {
        m.softActive = false;
        m.soft.reset();
        for (const g of [this.sdaG, this.sclG]) m.mcu.gpio[g]!.setInputValue(this.inputLevel.get(g) ?? false);
      }
      return false;
    }
    if (!m.softActive) {
      m.softActive = true;
      m.soft.reset();
    }
    const sda = this.mcuLevel(this.sdaG);
    const scl = this.mcuLevel(this.sclG);
    m.soft.update(sda, scl);
    m.mcu.gpio[this.sdaG]!.setInputValue(m.soft.line(sda) === 1);
    m.mcu.gpio[this.sclG]!.setInputValue(scl === 1);
    return true;
  }

  private later(ns: number, fn: () => void): void {
    const m = this.m;
    m.clock
      .createAlarm(() => {
        if (this.m === m) fn();
      })
      .schedule(ns);
  }

  private i2cOnBus(k: number): boolean {
    const g = Number(this.busPins.i2c!.sda.slice(2));
    return this.m.mcu.gpio[g]!.functionSelect === FUNC_I2C && i2cOf(g) === k;
  }

  private spiOnBus(k: number): boolean {
    const g = Number(this.busPins.spi!.sck.slice(2));
    return this.m.mcu.gpio[g]!.functionSelect === FUNC_SPI && spiOf(g) === k;
  }

  // ------------------------------------------------------------- UART on pins

  private uartTxByte(k: 0 | 1, byte: number): void {
    const tx = this.m.tx[k];
    tx.queue.push(byte & 0xff);
    if (!tx.busy) {
      tx.busy = true;
      this.uartNextBit(k);
    }
  }

  /** Put the next bit on the TX pins (start, 8 data bits LSB first, stop), each for one bit time at the UART's baud rate. */
  private uartNextBit(k: 0 | 1): void {
    const m = this.m;
    const tx = m.tx[k];
    const baud = m.mcu.uart[k]!.baudRate;
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
    for (let g = 0; g < 30; g++) if (g % 4 === 0 && uartOf(g) === k && m.mcu.gpio[g]!.functionSelect === FUNC_UART) this.report(g);
    this.later(1e9 / baud, () => this.uartNextBit(k));
  }

  private uartRxEdge(g: number, level: 0 | 1): void {
    const m = this.m;
    let rx = m.rx.get(g);
    if (!rx) {
      rx = { start: -1, edges: [], alarm: undefined };
      m.rx.set(g, rx);
    }
    const now = m.clock.nanos;
    if (rx.start < 0) {
      if (level !== 0) return;
      const k = uartOf(g);
      const baud = m.mcu.uart[k]!.baudRate;
      if (!Number.isFinite(baud) || baud <= 0) return;
      rx.start = now;
      rx.edges = [];
      const bit = 1e9 / baud;
      const r = rx;
      const alarm = m.clock.createAlarm(() => {
        if (this.m !== m) return;
        let byte = 0;
        for (let i = 0; i < 8; i++) if (levelAt(r, r.start + (1.5 + i) * bit)) byte |= 1 << i;
        const stopOk = levelAt(r, r.start + 9.5 * bit) === 1;
        r.start = -1;
        r.alarm = undefined;
        if (stopOk && m.mcu.uart[k]!.rxEnabled) m.mcu.uart[k]!.feedByte(byte);
      });
      rx.alarm = alarm;
      alarm.schedule(9.5 * bit);
      return;
    }
    rx.edges.push([now, level]);
  }

  // ------------------------------------------------------------- build

  private build(): Machine {
    const clock = new VirtualClock();
    const mcu = new RP2040(clock);
    mcu.logger = SILENT;
    // FIFO_ST (0x50) is the inter-core FIFO status; arduino-pico clears its sticky flags at boot.
    // rp2040js has no core 1 and warns on the console; the write has no effect either way.
    const sioWrite = mcu.sio.writeUint32.bind(mcu.sio);
    mcu.sio.writeUint32 = (offset: number, value: number) => {
      if (offset !== 0x50) sioWrite(offset, value);
    };
    this.halted = undefined;
    this.romCycles = 0;
    installRom(mcu, {
      cost: (c) => void (this.romCycles += c),
      halt: (reason) => void (this.halted ??= reason),
    });
    // loadBootrom() reset the chip and erased the flash; now program it.
    if (this.image) mcu.flash.set(this.image);
    mcu.core.reset();

    const cdc = new USBCDC(mcu.usbCtrl);
    const m: Machine = {
      mcu,
      clock,
      cdc,
      soft: new SoftI2cTarget(() => this.i2cBus),
      softActive: false,
      pio: new PioClock(mcu, () => clock.nanos),
      tx: [
        { queue: [], bits: [], level: 1, busy: false },
        { queue: [], bits: [], level: 1, busy: false },
      ],
      rx: new Map(),
    };
    this.m = m;
    cdc.onSerialData = (buf) => {
      if (this.m !== m) return;
      const cycle = this.cycles;
      for (const b of buf) for (const cb of this.serialListeners) cb(b, cycle);
    };

    for (const k of [0, 1] as const) {
      mcu.uart[k]!.onByte = (b) => {
        if (this.m === m) this.uartTxByte(k, b);
      };
      const i2c = mcu.i2c[k]!;
      // rp2040js 1.4.1: an abort (address or data NACK) flushes the TX FIFO but never raises
      // TX_EMPTY, so the pico-sdk's write loop waits for it forever. On the chip the flushed FIFO is
      // empty and TX_EMPTY is set; do the same.
      const abortable = i2c as unknown as { abort(reason: number): void; setInterrupts(mask: number): void };
      const abort = abortable.abort.bind(i2c);
      abortable.abort = (reason: number) => {
        abort(reason);
        abortable.setInterrupts(I2C_R_TX_EMPTY);
      };
      const bit = () => {
        const p = i2c.sclLowPeriod + i2c.sclHighPeriod;
        return p > 0 ? (p * 1e9) / mcu.clkSys : 10_000;
      };
      const bytes = RP2040_BACKEND_FACTS.i2cBitsPerByte;
      const bus = () => (this.i2cOnBus(k) ? this.i2cBus : undefined);
      i2c.onStart = (repeated) =>
        this.later(bit(), () => {
          bus()?.start(repeated);
          i2c.completeStart();
        });
      i2c.onConnect = (address, mode) =>
        this.later(bytes * bit(), () => {
          const b = bus();
          i2c.completeConnect(b ? b.connect(address, mode === 1) : false);
        });
      i2c.onWriteByte = (value) =>
        this.later(bytes * bit(), () => {
          const b = bus();
          i2c.completeWrite(b ? b.write(value) : false);
        });
      i2c.onReadByte = (ack) =>
        this.later(bytes * bit(), () => {
          const b = bus();
          i2c.completeRead(b ? b.read(ack) : 0xff);
        });
      i2c.onStop = () =>
        this.later(bit(), () => {
          bus()?.stop();
          i2c.completeStop();
        });

      const spi = mcu.spi[k]!;
      spi.onTransmit = (value) => {
        const hz = spi.clockFrequency;
        const nbits = spi.dataBits;
        this.later(hz > 0 ? (nbits * 1e9) / hz : 8_000, () => {
          const b = this.spiOnBus(k) ? this.spiBus : undefined;
          let miso: number;
          if (!b) miso = (1 << nbits) - 1;
          else if (nbits > 8) miso = ((b.transfer((value >> 8) & 0xff) << 8) | b.transfer(value & 0xff)) & ((1 << nbits) - 1);
          else miso = b.transfer(value & 0xff);
          spi.completeTransmit(miso);
        });
      };
    }

    // The outside world, re-applied to the fresh chip.
    mcu.adc.channelValues[4] = adcCode(TEMP_SENSOR_VOLTS);
    for (const f of this.board.fixedInputs) this.inputVolts.set(f.gpio, f.volts);
    for (const [g, v] of this.inputVolts) {
      this.inputLevel.delete(g);
      this.applyInput(g, v);
    }

    this.reported.clear();
    for (let g = 0; g < 30; g++) {
      this.reported.set(g, key(this.stateOf(g)));
      const pin = mcu.gpio[g]!;
      const orig = pin.checkForUpdates.bind(pin);
      // Function-select, pad and SIO writes all end here: report what the circuit sees.
      const busLine = g === this.sdaG || g === this.sclG;
      pin.checkForUpdates = () => {
        orig();
        if (this.m !== m) return;
        this.report(g);
        if (busLine) this.softPins();
      };
    }
    return m;
  }
}

function levelAt(rx: UartRx, t: number): 0 | 1 {
  let level: 0 | 1 = 0;
  for (const [et, l] of rx.edges) {
    if (et > t) break;
    level = l;
  }
  return level;
}

function adcCode(volts: number): number {
  const v = Number.isFinite(volts) ? Math.min(Math.max(volts, 0), ADC_VREF) : 0;
  return Math.round((v / ADC_VREF) * ADC_MAX);
}

/** Change key: outputs change on level, inputs only on mode (input levels come from setPinInput, which must not fire). */
function key(s: PinState): string {
  return s.mode === "output" ? `output:${s.value}` : s.mode;
}

/** rp2040js-backed McuBackend (pins GP0..GP29). */
export function createRp2040Backend(opts: Rp2040BackendOptions = {}): McuBackend & { readonly board: Rp2040Board; readonly halted: string | undefined } {
  return new Rp2040Backend(opts);
}
