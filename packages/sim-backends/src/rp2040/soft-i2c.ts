// Bit-level I2C on GPIO pins, target side. arduino-pico's Wire probes an address (the zero-length
// write every I2C scanner and Adafruit_I2CDevice::begin() use) by bit-banging SDA/SCL as GPIOs,
// because the RP2040's I2C block cannot send an address without data. Bit-banged I2C libraries do
// the same. The circuit carries no bus waveforms (devices sit on the logical I2cBus), so this
// decoder watches the levels the MCU drives on the board's SDA/SCL pins, turns them into
// START / address / data / STOP on the I2cBus, and pulls SDA low where a device would (ACK, read
// bits). Deterministic: it reacts only to pin changes.
import type { I2cBus } from "@faber/sim-core";

type State = "idle" | "addr" | "write" | "slave-ack" | "read" | "master-ack" | "ignore";

export class SoftI2cTarget {
  /** The device pulls SDA low right now (ACK bit or a 0 data bit during a read). */
  deviceLow = false;
  private state: State = "idle";
  private scl: 0 | 1 = 1;
  private sda: 0 | 1 = 1;
  private bits = 0;
  private shift = 0;
  private reading = false;
  private acked = false;
  private out = 0;
  private readonly bus: () => I2cBus | undefined;

  constructor(bus: () => I2cBus | undefined) {
    this.bus = bus;
  }

  /** SDA as seen on the wire: low if the MCU or the device pulls it low. */
  line(mcuSda: 0 | 1): 0 | 1 {
    return mcuSda === 1 && !this.deviceLow ? 1 : 0;
  }

  /** Feed the levels the MCU drives (1 = released or driven high). */
  update(mcuSda: 0 | 1, mcuScl: 0 | 1): void {
    const sda = this.line(mcuSda);
    const prevScl = this.scl;
    const prevSda = this.sda;
    this.scl = mcuScl;
    this.sda = sda;
    if (prevScl === 1 && mcuScl === 1 && sda !== prevSda) {
      if (sda === 0) this.start();
      else this.stop();
      return;
    }
    if (prevScl === 0 && mcuScl === 1) this.rise(sda);
    else if (prevScl === 1 && mcuScl === 0) this.fall();
  }

  reset(): void {
    if (this.state !== "idle") this.bus()?.stop();
    this.state = "idle";
    this.deviceLow = false;
    this.scl = 1;
    this.sda = 1;
  }

  private start(): void {
    const repeated = this.state !== "idle";
    this.bus()?.start(repeated);
    this.state = "addr";
    this.bits = 0;
    this.shift = 0;
    this.deviceLow = false;
  }

  private stop(): void {
    if (this.state !== "idle") this.bus()?.stop();
    this.state = "idle";
    this.deviceLow = false;
  }

  private rise(sda: 0 | 1): void {
    if (this.state === "addr" || this.state === "write") {
      this.shift = ((this.shift << 1) | sda) & 0xff;
      this.bits++;
    } else if (this.state === "master-ack") {
      this.acked = sda === 0;
    }
  }

  private fall(): void {
    const bus = this.bus();
    switch (this.state) {
      case "addr":
      case "write":
        if (this.bits < 8) return;
        if (this.state === "addr") {
          this.reading = (this.shift & 1) === 1;
          this.acked = bus ? bus.connect(this.shift >> 1, this.reading) : false;
        } else {
          this.acked = bus ? bus.write(this.shift) : false;
        }
        this.deviceLow = this.acked;
        this.state = "slave-ack";
        return;
      case "slave-ack":
        this.deviceLow = false;
        this.bits = 0;
        this.shift = 0;
        if (!this.acked) {
          this.state = "ignore";
        } else if (this.reading) {
          this.loadByte();
        } else {
          this.state = "write";
        }
        return;
      case "read":
        this.bits++;
        if (this.bits < 8) {
          this.deviceLow = ((this.out >> (7 - this.bits)) & 1) === 0;
        } else {
          this.deviceLow = false;
          this.state = "master-ack";
        }
        return;
      case "master-ack":
        if (this.acked) this.loadByte();
        else this.state = "ignore";
        return;
      default:
        return;
    }
  }

  private loadByte(): void {
    // The I2cBus API wants the master's ACK up front; at bit level it comes after the byte, so ask
    // for "more" and let a NACK end the read.
    this.out = this.bus()?.read(true) ?? 0xff;
    this.bits = 0;
    this.state = "read";
    this.deviceLow = (this.out & 0x80) === 0;
  }
}
