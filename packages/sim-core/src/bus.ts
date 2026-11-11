// Logical I2C and SPI buses: the glue between an MCU's bus peripheral (TWI / SPI master in a
// backend) and the part models that answer on the bus. Electrical behaviour (pull-ups, levels)
// stays in the circuit; these classes carry the bytes.
//
// Deterministic: no wall clock. Cycles come from the `now` callback the owner passes in.

import type { Unsubscribe } from "./mcu.ts";

// ---------------------------------------------------------------------------------------- I2C

/**
 * What an I2C target (slave) part model implements. The bus calls it from inside the MCU step,
 * at the moment the transfer completes on the wire.
 *
 * Protocol, from the device's point of view:
 *   i2cConnect(read=false) → i2cWrite(b)* → [i2cConnect(read=true) → i2cRead(ack)*] → i2cStop()
 * A repeated START arrives as another i2cConnect without an i2cStop in between.
 */
export interface I2cDevice {
  /** The 7-bit address the device answers right now (it may change with a prop, e.g. 0x3C/0x3D). */
  i2cAddress(): number;
  /**
   * The master sent our address. Return true to ACK, false to NACK (e.g. unpowered, busy).
   * `read` = the master wants to read. `repeated` = repeated START (no STOP since our last transfer).
   */
  i2cConnect(read: boolean, repeated: boolean): boolean;
  /** One byte from the master. Return true to ACK it. */
  i2cWrite(byte: number): boolean;
  /** The master clocks one byte out of us. `ack` = the master will ACK it (it wants more). */
  i2cRead(ack: boolean): number;
  /** STOP (or the master moved on to another address). */
  i2cStop(): void;
}

/**
 * Faults an agent or a scenario can inject on one I2C device.
 * - `nack`:       the device NACKs its address (Wire.endTransmission() returns 2).
 * - `nack-data`:  the device ACKs its address but NACKs every data byte (endTransmission() returns 3).
 * - `disconnect`: the device is gone from the bus, as if a wire fell off: nothing answers its
 *                 address, and the model does not see the traffic.
 * - `garbage`:    reads return 0xFF (a floating SDA line), writes still reach the device.
 */
export type I2cFault = "nack" | "nack-data" | "disconnect" | "garbage";
export const I2C_FAULTS: readonly I2cFault[] = ["nack", "nack-data", "disconnect", "garbage"];

/** One finished I2C transaction (START … STOP / repeated START), for logs, agents and tests. */
export interface I2cTransaction {
  /** MCU cycle of the START. */
  cycle: number;
  address: number;
  read: boolean;
  /** Address ACKed? */
  ack: boolean;
  /** Part id that answered, if any. */
  partId?: string;
  /** Bytes written (read=false) or read (read=true). Only the first `I2C_LOG_BYTES` are kept. */
  bytes: number[];
  /** Total byte count (bytes may be truncated). */
  count: number;
  /** A data byte was NACKed by the device (writes) or the master (the last byte of a read, normal). */
  dataNack: boolean;
}

export const I2C_LOG_BYTES = 32;
const I2C_LOG_MAX = 512;

interface I2cAttached {
  partId: string;
  device: I2cDevice;
}

/**
 * One I2C bus with any number of target devices. The MCU's TWI master drives it with
 * start/connect/write/read/stop; devices are matched by their current 7-bit address.
 */
export class I2cBus {
  readonly id: string;
  private devices: I2cAttached[] = [];
  private faults = new Map<string, I2cFault>();
  private active: I2cAttached | undefined;
  private pendingRepeat: I2cAttached | undefined;
  private activeFault: I2cFault | undefined;
  private current: I2cTransaction | undefined;
  private log: I2cTransaction[] = [];
  private listeners = new Set<(t: I2cTransaction) => void>();
  private now: () => number;

  constructor(id = "i2c0", now: () => number = () => 0) {
    this.id = id;
    this.now = now;
  }

  /** Set the cycle source used to timestamp transactions. */
  setClock(now: () => number): void {
    this.now = now;
  }

  attach(partId: string, device: I2cDevice): Unsubscribe {
    const entry = { partId, device };
    this.devices.push(entry);
    return () => {
      this.devices = this.devices.filter((d) => d !== entry);
      if (this.active === entry) this.active = undefined;
    };
  }

  /** Attached devices with their current addresses (fault state included). */
  list(): { partId: string; address: number; fault?: I2cFault }[] {
    return this.devices.map((d) => {
      const fault = this.faults.get(d.partId);
      return { partId: d.partId, address: d.device.i2cAddress() & 0x7f, ...(fault ? { fault } : {}) };
    });
  }

  /** Inject (or clear with null) a fault on the device of `partId`. */
  setFault(partId: string, fault: I2cFault | null): void {
    if (fault === null) this.faults.delete(partId);
    else this.faults.set(partId, fault);
  }

  faultOf(partId: string): I2cFault | undefined {
    return this.faults.get(partId);
  }

  clearFaults(): void {
    this.faults.clear();
  }

  // ------------------------------------------------------------- master side (the MCU drives these)

  /** START or repeated START. A repeated START does not send the device a STOP. */
  start(repeated: boolean): void {
    const prev = this.active;
    this.finish(!repeated);
    this.pendingRepeat = repeated ? prev : undefined;
  }

  /** Address phase. Returns true when a device ACKed. */
  connect(address: number, read: boolean): boolean {
    const wasActive = this.pendingRepeat;
    this.pendingRepeat = undefined;
    this.finish(true);
    const addr = address & 0x7f;
    const t: I2cTransaction = { cycle: this.now(), address: addr, read, ack: false, bytes: [], count: 0, dataNack: false };
    this.current = t;
    this.active = undefined;
    this.activeFault = undefined;
    for (const d of this.devices) {
      if ((d.device.i2cAddress() & 0x7f) !== addr) continue;
      const fault = this.faults.get(d.partId);
      if (fault === "disconnect") continue;
      if (fault === "nack") {
        t.partId = d.partId;
        continue;
      }
      // A repeated START to the same device keeps its register pointer.
      if (wasActive && wasActive !== d) wasActive.device.i2cStop();
      const ack = d.device.i2cConnect(read, wasActive === d);
      if (ack) {
        t.ack = true;
        t.partId = d.partId;
        this.active = d;
        this.activeFault = fault;
        break;
      }
      t.partId = d.partId;
    }
    return t.ack;
  }

  /** Data byte from the master. Returns the device's ACK. */
  write(byte: number): boolean {
    const t = this.current;
    const b = byte & 0xff;
    if (t) this.record(t, b);
    const d = this.active;
    if (!d || t?.read) {
      if (t) t.dataNack = true;
      return false;
    }
    const ack = d.device.i2cWrite(b);
    if (this.activeFault === "nack-data" || !ack) {
      if (t) t.dataNack = true;
      return false;
    }
    return true;
  }

  /** Master reads one byte. `ack` = the master ACKs it (wants more). An idle bus reads 0xFF. */
  read(ack: boolean): number {
    const t = this.current;
    const d = this.active;
    let b = 0xff;
    if (d && t?.read) {
      b = d.device.i2cRead(ack) & 0xff;
      if (this.activeFault === "garbage") b = 0xff;
    }
    if (t) {
      this.record(t, b);
      if (!ack) t.dataNack = true;
    }
    return b;
  }

  /** STOP condition. */
  stop(): void {
    const prev = this.pendingRepeat;
    this.pendingRepeat = undefined;
    prev?.device.i2cStop();
    this.finish(true);
  }

  // ------------------------------------------------------------------------------- log

  /** The last finished transactions, oldest first (max 512). */
  transactions(): readonly I2cTransaction[] {
    return this.log;
  }

  clearLog(): void {
    this.log = [];
  }

  onTransaction(cb: (t: I2cTransaction) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Drop devices, faults, log and bus state (the Simulation re-attaches on reset). */
  reset(): void {
    this.devices = [];
    this.faults.clear();
    this.active = undefined;
    this.pendingRepeat = undefined;
    this.current = undefined;
    this.log = [];
  }

  private record(t: I2cTransaction, b: number): void {
    if (t.bytes.length < I2C_LOG_BYTES) t.bytes.push(b);
    t.count++;
  }

  private finish(stopDevice: boolean): void {
    const d = this.active;
    this.active = undefined;
    this.activeFault = undefined;
    if (d && stopDevice) d.device.i2cStop();
    const t = this.current;
    this.current = undefined;
    if (!t) return;
    this.log.push(t);
    if (this.log.length > I2C_LOG_MAX) this.log.splice(0, this.log.length - I2C_LOG_MAX);
    for (const l of this.listeners) l(t);
  }
}

// ---------------------------------------------------------------------------------------- SPI

/** What an SPI peripheral part model implements. */
export interface SpiDevice {
  /** One full-duplex byte while CS is low: receives MOSI, returns MISO. */
  spiTransfer(mosi: number): number;
  /** CS edge: true when the device becomes selected (CS low), false when released. */
  spiSelect?(selected: boolean): void;
}

/** Faults on one SPI device: `disconnect` = MISO floats (reads 0xFF) and the device sees nothing. */
export type SpiFault = "disconnect" | "garbage";
export const SPI_FAULTS: readonly SpiFault[] = ["disconnect", "garbage"];

interface SpiAttached {
  partId: string;
  device: SpiDevice;
  selected: () => boolean;
  /** The device's MISO reaches the master (it has a MISO pin and it is wired). */
  drivesMiso: boolean;
}

/**
 * One SPI bus. The master exchanges bytes; every device whose chip select is active gets the byte.
 * MISO from several selected devices is wired-AND (a real bus conflict); the Simulation also
 * reports such a conflict as a diagnostic.
 */
export class SpiBus {
  readonly id: string;
  private devices: SpiAttached[] = [];
  private faults = new Map<string, SpiFault>();
  private _bytes = 0;

  constructor(id = "spi0") {
    this.id = id;
  }

  /**
   * `selected` says whether the device's CS line is active right now. `drivesMiso` (default true):
   * false for a device whose MISO is not wired (or that has none, like most display modules).
   */
  attach(partId: string, device: SpiDevice, selected: () => boolean, drivesMiso = true): Unsubscribe {
    const entry = { partId, device, selected, drivesMiso };
    this.devices.push(entry);
    return () => {
      this.devices = this.devices.filter((d) => d !== entry);
    };
  }

  list(): { partId: string; selected: boolean; fault?: SpiFault }[] {
    return this.devices.map((d) => {
      const fault = this.faults.get(d.partId);
      return { partId: d.partId, selected: d.selected(), ...(fault ? { fault } : {}) };
    });
  }

  setFault(partId: string, fault: SpiFault | null): void {
    if (fault === null) this.faults.delete(partId);
    else this.faults.set(partId, fault);
  }

  faultOf(partId: string): SpiFault | undefined {
    return this.faults.get(partId);
  }

  /**
   * true when some attached device drives MISO, so the master must wait for each answer. A backend in
   * another process (Renode) sends MOSI one way when nothing can answer (display modules).
   */
  needsMiso(): boolean {
    return this.devices.some((d) => d.drivesMiso);
  }

  /** Bytes exchanged since the last reset. */
  get bytes(): number {
    return this._bytes;
  }

  /** Master side: exchange one byte. Returns MISO (0xFF when nothing drives it). */
  transfer(mosi: number): number {
    this._bytes++;
    let miso = 0xff;
    for (const d of this.devices) {
      if (!d.selected()) continue;
      const fault = this.faults.get(d.partId);
      if (fault === "disconnect") continue;
      const out = d.device.spiTransfer(mosi & 0xff) & 0xff;
      miso &= fault === "garbage" ? 0xff : out;
    }
    return miso;
  }

  /** Tell devices on a CS line about an edge (the Simulation calls this on CS pin changes). */
  select(partId: string, selected: boolean): void {
    for (const d of this.devices) if (d.partId === partId && this.faults.get(partId) !== "disconnect") d.device.spiSelect?.(selected);
  }

  reset(): void {
    this.devices = [];
    this.faults.clear();
    this._bytes = 0;
  }
}

/** Pins of an MCU's hardware buses, as McuBackend pin ids (e.g. Uno: SDA "A4", SCL "A5"). */
export interface McuBusPins {
  i2c?: { sda: string; scl: string };
  spi?: { mosi: string; miso: string; sck: string; ss: string };
}
