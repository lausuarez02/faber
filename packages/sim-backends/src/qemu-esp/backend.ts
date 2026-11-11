// ESP32-family McuBackend on Espressif's QEMU fork (round 9 spike, prototype).
//
// QEMU runs in its own process (Docker image jumper/qemu-esp by default) with Jumper's bridge
// patch, in lockstep: -icount makes guest time a pure function of executed instructions, and the
// patched GPIO block stops at every target time Jumper sends ("R <ns>") until told to go on. So
// step(cycles) is synchronous and deterministic like the AVR / RP2040 backends:
//   cycles  = virtual ns × cpuHz / 1e9 (a time base at the chip's nominal clock, as in rp2040)
//   pins    = "GPIO<n>": output level / enable from the GPIO block, inputs driven by setPinInput
//   serial  = UART0, carried on the bridge with its virtual time stamp
//   I2C     = the ESP32's I2C0 bus, every transaction forwarded to the attached I2cBus
// Not bridged yet: LEDC/PWM, RMT, SPI peripherals, I2S, ADC, GPIO interrupts, WiFi/BT (QEMU has no radio model).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { I2cBus, McuBackend, McuBusPins, PinState, Unsubscribe } from "@jumper/sim-core";
import { ESP_CHIPS, espGpioOf, espPinId, type EspChip, type EspChipInfo } from "./chips.ts";
import { launchQemu, type QemuLaunchOptions, type QemuProcess } from "./launcher.ts";
import { encodeAck, encodeData, encodeInput, encodeRun, encodeSerial, parseBridgeLine } from "./protocol.ts";
import { SyncBridgeLink } from "./sync-link.ts";

export interface QemuEspBackendOptions {
  chip: EspChip;
  vcc?: number;
  runtime?: QemuLaunchOptions["runtime"];
  image?: string;
  icountShift?: number;
  /** See QemuLaunchOptions.network: true (QEMU NAT), { framePort } (Jumper's device network), false. */
  network?: QemuLaunchOptions["network"];
  /** How long one step may wait for QEMU (boot included on the first one). Default 30 s. */
  timeoutMs?: number;
  logFile?: string;
}

/** ESP32 datasheet: VIL max 0.25 × VDD, VIH min 0.75 × VDD. */
const VIL_RATIO = 0.25;
const VIH_RATIO = 0.75;

export class QemuEspBackend implements McuBackend {
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];
  readonly busPins?: McuBusPins;
  readonly info: EspChipInfo;
  private _cycles = 0;
  private ns = 0n;
  private out = 0n;
  private enable = 0n;
  private inputs = 0n;
  private pinCbs = new Set<(pinId: string, state: PinState, cycle: number) => void>();
  private serialCbs = new Set<(byte: number, cycle: number) => void>();
  private i2c?: I2cBus;
  private link?: SyncBridgeLink;
  private proc?: QemuProcess;
  private workDir?: string;
  private flash?: Uint8Array;
  /** The handshake line QEMU sent ("H jumper-esp32-bridge 2 esp32c3.gpio sync=1"). */
  hello = "";

  constructor(private readonly opts: QemuEspBackendOptions) {
    this.info = ESP_CHIPS[opts.chip];
    this.cyclesPerSecond = this.info.cpuHz;
    this.vcc = opts.vcc ?? 3.3;
    this.pinIds = this.info.gpios.map(espPinId);
    if (this.info.i2cPins) this.busPins = { i2c: { sda: espPinId(this.info.i2cPins.sda), scl: espPinId(this.info.i2cPins.scl) } };
  }

  get cycles(): number {
    return this._cycles;
  }

  /** Virtual time in ns (exact). */
  get virtualNs(): bigint {
    return this.ns;
  }

  load(firmware: Uint8Array | string): void {
    if (typeof firmware === "string") throw new Error("the ESP32 backend loads a merged flash image (bytes), not Intel HEX");
    if (![2, 4, 8, 16].includes(firmware.length / (1 << 20))) {
      throw new Error(`ESP32 flash image is ${firmware.length} bytes; QEMU needs exactly 2, 4, 8 or 16 MB. Fix: build with esptool merge-bin --pad-to-size 4MB (jumper/arduino-esp32 does this).`);
    }
    this.flash = firmware;
    this.start();
  }

  reset(): void {
    if (this.flash) this.start();
  }

  /** Stops QEMU and the bridge. The backend can be load()ed again. */
  close(): void {
    this.proc?.stop();
    this.link?.close();
    this.proc = undefined;
    this.link = undefined;
    if (this.workDir) rmSync(this.workDir, { recursive: true, force: true });
    this.workDir = undefined;
  }

  step(cycles: number): void {
    const link = this.link;
    if (!link) throw new Error("no firmware loaded");
    const targetNs = BigInt(Math.round(((this._cycles + Math.max(0, cycles)) * 1e9) / this.cyclesPerSecond));
    if (targetNs <= this.ns) return;
    link.send(encodeRun(targetNs));
    this.pump(link);
  }

  readPin(pinId: string): PinState {
    const g = espGpioOf(pinId);
    if (g === undefined) throw new Error(`unknown pin '${pinId}' (ESP pins are GPIO<n>)`);
    return this.stateOf(g);
  }

  setPinInput(pinId: string, volts: number): void {
    const g = espGpioOf(pinId);
    if (g === undefined || !this.info.gpios.includes(g)) throw new Error(`unknown pin '${pinId}' on ${this.info.chip}`);
    const bit = 1n << BigInt(g);
    const was = (this.inputs & bit) !== 0n;
    let level = was;
    if (volts <= VIL_RATIO * this.vcc) level = false;
    else if (volts >= VIH_RATIO * this.vcc) level = true;
    if (level === was) return;
    this.inputs = level ? this.inputs | bit : this.inputs & ~bit;
    // QEMU is parked at a sync point between steps, so the level applies at exactly this.ns.
    this.link?.send(encodeInput(g, level ? 1 : 0));
    if ((this.enable & bit) === 0n) this.emitPin(g);
  }

  onPinChange(cb: (pinId: string, state: PinState, cycle: number) => void): Unsubscribe {
    this.pinCbs.add(cb);
    return () => this.pinCbs.delete(cb);
  }

  onSerial(cb: (byte: number, cycle: number) => void): Unsubscribe {
    this.serialCbs.add(cb);
    return () => this.serialCbs.delete(cb);
  }

  writeSerial(byte: number): void {
    this.link?.send(encodeSerial([byte]));
  }

  attachI2c(bus: I2cBus): void {
    this.i2c = bus;
  }

  // ------------------------------------------------------------------------------ internals

  private start(): void {
    this.close();
    this._cycles = 0;
    this.ns = 0n;
    this.out = 0n;
    this.enable = 0n;
    this.workDir = mkdtempSync(join(tmpdir(), "jumper-qemu-esp-"));
    const flashImage = join(this.workDir, "flash.bin");
    writeFileSync(flashImage, this.flash!);
    const link = new SyncBridgeLink();
    this.link = link;
    this.proc = launchQemu({
      chip: this.opts.chip,
      flashImage,
      bridgePort: link.port,
      runtime: this.opts.runtime,
      image: this.opts.image,
      icountShift: this.opts.icountShift,
      network: this.opts.network,
      logFile: this.opts.logFile,
    });
    // Handshake: QEMU connects, says hello, and parks at virtual time 0 waiting for the first "R".
    this.pump(link);
    if (!this.hello) throw new Error("the emulator connected but did not identify itself (old jumper/qemu-esp image?)");
    for (let g = 0; g < 64; g++) if ((this.inputs >> BigInt(g)) & 1n) link.send(encodeInput(g, 1));
  }

  /** Handles lines until QEMU parks at a sync point ("T"). */
  private pump(link: SyncBridgeLink): void {
    const timeout = this.opts.timeoutMs ?? 30_000;
    for (;;) {
      if (link.closed) throw new Error("the emulator exited (see logFile for QEMU's output)");
      const lines = link.next(timeout);
      let parked = false;
      for (const line of lines) {
        if (!line) continue;
        const ev = parseBridgeLine(line);
        switch (ev.kind) {
          case "hello":
            this.hello = line;
            break;
          case "gpio":
            this.advance(ev.ns);
            this.applyGpio(ev.out, ev.enable);
            break;
          case "uart":
            this.advance(ev.ns);
            for (const b of ev.bytes) for (const cb of this.serialCbs) cb(b, this._cycles);
            break;
          case "time":
            this.advance(ev.ns);
            parked = true;
            break;
          case "i2c-start": {
            this.advance(ev.ns);
            const bus = this.i2c;
            let ack = false;
            if (bus) {
              bus.start(false);
              ack = bus.connect(ev.addr, ev.read);
            }
            link.send(encodeAck(ack));
            break;
          }
          case "i2c-write":
            this.i2c?.write(ev.byte);
            break;
          case "i2c-read":
            link.send(encodeData(this.i2c ? this.i2c.read(true) : 0xff));
            break;
          case "i2c-stop":
            this.i2c?.stop();
            break;
          default:
            break;
        }
      }
      if (parked) return;
    }
  }

  private advance(ns: bigint): void {
    if (ns > this.ns) {
      this.ns = ns;
      this._cycles = Math.round((Number(ns) * this.cyclesPerSecond) / 1e9);
    }
  }

  private stateOf(g: number): PinState {
    const bit = 1n << BigInt(g);
    if (this.enable & bit) return { mode: "output", value: this.out & bit ? 1 : 0 };
    return { mode: "input", value: this.inputs & bit ? 1 : 0 };
  }

  private applyGpio(out: bigint, enable: bigint): void {
    const changedOut = (out ^ this.out) & (enable | this.enable);
    const changedEn = enable ^ this.enable;
    this.out = out;
    this.enable = enable;
    const changed = changedOut | changedEn;
    if (!changed) return;
    for (const g of this.info.gpios) if ((changed >> BigInt(g)) & 1n) this.emitPin(g);
  }

  private emitPin(g: number): void {
    const state = this.stateOf(g);
    const id = espPinId(g);
    for (const cb of this.pinCbs) cb(id, state, this._cycles);
  }
}

export function createQemuEspBackend(opts: QemuEspBackendOptions): QemuEspBackend {
  return new QemuEspBackend(opts);
}
