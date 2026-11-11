// ESP32-family McuBackend on Espressif's QEMU fork (decision 0006, round 10).
//
// QEMU runs in its own process (Docker image jumper/qemu-esp by default) with Jumper's bridge
// patch, in lockstep: -icount makes guest time a pure function of executed instructions, and the
// patched GPIO block stops at every target time Jumper sends ("R <ns>") until told to go on. So
// step(cycles) is synchronous and deterministic like the AVR / RP2040 backends:
//   cycles  = virtual ns × cpuHz / 1e9 (a time base at the chip's nominal clock, as in rp2040)
//   pins    = "GPIO<n>": output level / enable from the GPIO block, inputs driven by setPinInput,
//             internal pull-ups / pull-downs from IO_MUX / RTC_IO (bridge v3, "P" lines)
//   serial  = UART0, carried on the bridge with its virtual time stamp
//   I2C     = the ESP32's I2C0 bus, every transaction forwarded to the attached I2cBus
// The 1 to 3 s container start happens in prepare() without blocking the event loop.
// Not bridged yet: LEDC/PWM, RMT, SPI peripherals, I2S, ADC, GPIO interrupts, Wi-Fi/BT radio.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { I2cBus, McuBackend, McuBusPins, McuCapability, PinState, Unsubscribe } from "@jumper/sim-core";
import { ESP_CHIPS, espGpioOf, espPinId, type EspChip, type EspChipInfo } from "./chips.ts";
import { QEMU_ESP_IMAGE, launchQemu, type QemuLaunchOptions, type QemuProcess } from "./launcher.ts";
import { encodeAck, encodeData, encodeInput, encodeRun, encodeSerial, parseBridgeLine } from "./protocol.ts";
import { BridgeTimeoutError, SyncBridgeLink } from "./sync-link.ts";

export interface QemuEspBackendOptions {
  chip: EspChip;
  vcc?: number;
  runtime?: QemuLaunchOptions["runtime"];
  image?: string;
  icountShift?: number;
  network?: boolean;
  /** Flash size the image is padded to (MB). Default: the smallest of 2 / 4 / 8 / 16 that holds it. */
  flashSizeMB?: number;
  /** How long one step may wait for QEMU (boot included on the first one). Default 30 s. */
  timeoutMs?: number;
  /** QEMU's own output. Default: a file in the backend's temp folder (read for crash reports). */
  logFile?: string;
  /** Extra Docker labels (the local runner tags containers with its session). */
  labels?: Record<string, string>;
}

/** ESP32 datasheet: VIL max 0.25 × VDD, VIH min 0.75 × VDD. */
const VIL_RATIO = 0.25;
const VIH_RATIO = 0.75;
const FLASH_SIZES_MB = [2, 4, 8, 16];

export type EmulatorErrorCode = "docker-missing" | "docker-not-running" | "image-missing" | "emulator-exited" | "emulator-timeout" | "bad-firmware";

/** An emulator problem with what failed, why and the fix (the runner and the UI show it as is). */
export class EmulatorError extends Error {
  readonly code: EmulatorErrorCode;
  constructor(code: EmulatorErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "EmulatorError";
  }
}

/** Turns QEMU / Docker output into a what / why / fix message. */
export function explainEmulatorLog(log: string, image: string, chip: string): EmulatorError {
  const tail = log.trim().split("\n").slice(-6).join(" | ").slice(-600);
  if (/Cannot connect to the Docker daemon|docker daemon is not running|error during connect/i.test(log)) {
    return new EmulatorError("docker-not-running", `The ${chip} emulator did not start: Docker is not running. Why: Jumper runs ESP32 boards in Espressif's QEMU inside a Docker container on your computer. Fix: start Docker Desktop (macOS: open -a Docker), wait until it says running, then press Run again.`);
  }
  if (/Unable to find image|pull access denied|No such image|repository does not exist/i.test(log)) {
    return new EmulatorError("image-missing", `The ${chip} emulator did not start: the Docker image ${image} is not on this computer. Fix: run \`pnpm jumper setup esp32\` (builds it from toolchains/qemu-esp, about a minute), then press Run again.`);
  }
  if (/mtd|drive/i.test(log) && /error|invalid|size/i.test(log)) {
    return new EmulatorError("bad-firmware", `The ${chip} emulator refused the flash image: ${tail}. Fix: rebuild the firmware (build), which writes a merged flash image.`);
  }
  return new EmulatorError("emulator-exited", `The ${chip} emulator stopped${tail ? `: ${tail}` : " without output"}. Why: QEMU crashed or its container was removed. Fix: press Run again; if it repeats, check \`docker ps\` and Docker Desktop's memory, and report the lines above.`);
}

export class QemuEspBackend implements McuBackend {
  readonly kind = "process" as const;
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];
  readonly busPins?: McuBusPins;
  readonly info: EspChipInfo;
  readonly capabilities: readonly McuCapability[];
  private readonly opts: QemuEspBackendOptions;
  private _cycles = 0;
  private ns = 0n;
  private out = 0n;
  private enable = 0n;
  private inputs = 0n;
  private pullUp = 0n;
  private pullDown = 0n;
  private pinCbs = new Set<(pinId: string, state: PinState, cycle: number) => void>();
  private serialCbs = new Set<(byte: number, cycle: number) => void>();
  private i2c?: I2cBus;
  private link?: SyncBridgeLink;
  private proc?: QemuProcess;
  private workDir?: string;
  private logPath?: string;
  private flash?: Uint8Array;
  private flashHash = "";
  /** True from a finished boot until the first step: load() of the same image is then a no-op. */
  private fresh = false;
  private exited = false;
  /** The handshake line QEMU sent ("H jumper-esp32-bridge 3 esp32c3.gpio sync=1 pads=1"). */
  hello = "";
  /** Wall ms from launch to parked at t = 0 (the last boot). */
  bootMs = 0;

  constructor(opts: QemuEspBackendOptions) {
    this.opts = opts;
    this.info = ESP_CHIPS[opts.chip];
    this.cyclesPerSecond = this.info.cpuHz;
    this.vcc = opts.vcc ?? 3.3;
    this.pinIds = this.info.gpios.map(espPinId);
    if (this.info.i2cPins) this.busPins = { i2c: { sda: espPinId(this.info.i2cPins.sda), scl: espPinId(this.info.i2cPins.scl) } };
    this.capabilities = ["gpio", "pulls", "uart", ...(this.info.i2cPins ? (["i2c"] as const) : []), "net"];
  }

  get cycles(): number {
    return this._cycles;
  }

  /** Virtual time in ns (exact). */
  get virtualNs(): bigint {
    return this.ns;
  }

  get image(): string {
    return this.opts.image ?? QEMU_ESP_IMAGE;
  }

  /** Boot asynchronously (container start + handshake up to t = 0). */
  async prepare(firmware: Uint8Array | string): Promise<void> {
    const image = this.toImage(firmware);
    if (this.fresh && this.link && this.sameImage(image)) return;
    this.setImage(image);
    const t0 = Date.now();
    const link = this.launch();
    const timeout = this.opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    while (!this.fresh) {
      if (this.exited && link.closed) throw this.crash();
      let lines: string[];
      try {
        lines = await link.nextAsync(Math.min(500, Math.max(1, deadline - Date.now())));
      } catch (err) {
        if (!(err instanceof BridgeTimeoutError)) throw err;
        if (this.exited) throw this.crash();
        if (Date.now() >= deadline) throw this.timeoutError(timeout);
        continue;
      }
      if (this.link !== link) throw new EmulatorError("emulator-exited", "The ESP32 emulator was stopped while it started. Fix: press Run again.");
      if (this.handle(link, lines)) this.fresh = true;
      else if (link.closed) throw this.crash();
    }
    this.checkHello();
    this.sendInputs(link);
    this.bootMs = Date.now() - t0;
  }

  load(firmware: Uint8Array | string): void {
    const image = this.toImage(firmware);
    if (this.fresh && this.link && this.sameImage(image)) return;
    this.setImage(image);
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
    this.fresh = false;
    if (this.workDir) rmSync(this.workDir, { recursive: true, force: true });
    this.workDir = undefined;
  }

  dispose(): void {
    this.close();
  }

  step(cycles: number): void {
    const link = this.link;
    if (!link) throw new EmulatorError("emulator-exited", "The ESP32 emulator is not running (no firmware loaded, or it was stopped). Fix: press Run again.");
    const targetNs = BigInt(Math.round(((this._cycles + Math.max(0, cycles)) * 1e9) / this.cyclesPerSecond));
    if (targetNs <= this.ns) return;
    this.fresh = false;
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

  private toImage(firmware: Uint8Array | string): Uint8Array {
    if (typeof firmware === "string") {
      throw new EmulatorError("bad-firmware", "The ESP32 backend loads a merged flash image (bytes), not Intel HEX. Fix: build the sketch for an ESP32 board (the board part's mcu.fqbn), which writes firmware/<sketch>.bin.");
    }
    const want = this.opts.flashSizeMB ?? FLASH_SIZES_MB.find((mb) => mb << 20 >= firmware.length);
    if (!want || !FLASH_SIZES_MB.includes(want) || firmware.length > want << 20) {
      throw new EmulatorError("bad-firmware", `The ESP32 flash image is ${firmware.length} bytes, more than the board's ${want ?? 16} MB flash. Fix: rebuild for this board (its partition scheme fits its flash).`);
    }
    if (firmware.length === want << 20) return firmware;
    // Pad with erased flash (0xFF), as esptool merge-bin --pad-to-size does.
    const padded = new Uint8Array(want << 20).fill(0xff);
    padded.set(firmware);
    return padded;
  }

  private sameImage(image: Uint8Array): boolean {
    return this.flash?.length === image.length && this.flashHash === hashOf(image);
  }

  private setImage(image: Uint8Array): void {
    this.flash = image;
    this.flashHash = hashOf(image);
  }

  /** Starts QEMU for the current image (sync handshake). */
  private start(): void {
    const t0 = Date.now();
    const link = this.launch();
    try {
      this.pump(link);
    } catch (err) {
      if (err instanceof BridgeTimeoutError) throw this.exited ? this.crash() : this.timeoutError(this.opts.timeoutMs ?? 30_000);
      throw err;
    }
    this.checkHello();
    this.fresh = true;
    this.sendInputs(link);
    this.bootMs = Date.now() - t0;
  }

  private launch(): SyncBridgeLink {
    this.close();
    this._cycles = 0;
    this.ns = 0n;
    this.out = 0n;
    this.enable = 0n;
    this.pullUp = 0n;
    this.pullDown = 0n;
    this.hello = "";
    this.exited = false;
    this.workDir = mkdtempSync(join(tmpdir(), "jumper-qemu-esp-"));
    const flashImage = join(this.workDir, "flash.bin");
    writeFileSync(flashImage, this.flash!);
    this.logPath = this.opts.logFile ?? join(this.workDir, "qemu.log");
    const link = new SyncBridgeLink();
    this.link = link;
    const proc = launchQemu({
      chip: this.opts.chip,
      flashImage,
      bridgePort: link.port,
      runtime: this.opts.runtime,
      image: this.opts.image,
      icountShift: this.opts.icountShift,
      network: this.opts.network,
      logFile: this.logPath,
      ...(this.opts.labels ? { labels: this.opts.labels } : {}),
    });
    this.proc = proc;
    const gone = () => {
      if (this.proc === proc) this.exited = true;
    };
    proc.child.once("exit", gone);
    proc.child.once("error", gone);
    return link;
  }

  private checkHello(): void {
    if (!this.hello) throw new EmulatorError("emulator-exited", `The ESP32 emulator connected but did not identify itself. Why: the Docker image is older than this Jumper. Fix: run \`pnpm jumper setup esp32\` to build ${QEMU_ESP_IMAGE}.`);
  }

  private sendInputs(link: SyncBridgeLink): void {
    for (let g = 0; g < 64; g++) if ((this.inputs >> BigInt(g)) & 1n) link.send(encodeInput(g, 1));
  }

  private readLog(): string {
    try {
      return this.logPath && existsSync(this.logPath) ? readFileSync(this.logPath, "utf8") : "";
    } catch {
      return "";
    }
  }

  private crash(): EmulatorError {
    const err = explainEmulatorLog(this.readLog(), this.image, this.info.chip);
    this.close();
    return err;
  }

  private timeoutError(ms: number): EmulatorError {
    const log = this.readLog();
    if (/Cannot connect|Unable to find image|pull access/i.test(log)) return this.crash();
    this.close();
    return new EmulatorError("emulator-timeout", `The ${this.info.chip} emulator did not answer within ${Math.round(ms / 1000)} s. Why: the container is slow to start (first start, a busy machine) or QEMU hung. Fix: press Run again; if it repeats, restart Docker Desktop.${log ? ` QEMU said: ${log.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
  }

  /** Handles lines until QEMU parks at a sync point ("T"). */
  private pump(link: SyncBridgeLink): void {
    const timeout = this.opts.timeoutMs ?? 30_000;
    for (;;) {
      if (link.closed) throw this.crash();
      if (this.handle(link, link.next(timeout))) return;
    }
  }

  /** Applies one batch; true when QEMU parked at its target. */
  private handle(link: SyncBridgeLink, lines: string[]): boolean {
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
        case "pads":
          this.advance(ev.ns);
          this.applyPads(ev.pullUp, ev.pullDown);
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
    return parked;
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
    const value = this.inputs & bit ? 1 : 0;
    if (this.pullUp & bit) return { mode: "input_pullup", value };
    if (this.pullDown & bit) return { mode: "input_pulldown", value };
    return { mode: "input", value };
  }

  private applyGpio(out: bigint, enable: bigint): void {
    const changedOut = (out ^ this.out) & (enable | this.enable);
    const changedEn = enable ^ this.enable;
    this.out = out;
    this.enable = enable;
    this.emitChanged(changedOut | changedEn);
  }

  private applyPads(pullUp: bigint, pullDown: bigint): void {
    const changed = ((pullUp ^ this.pullUp) | (pullDown ^ this.pullDown)) & ~this.enable;
    this.pullUp = pullUp;
    this.pullDown = pullDown;
    this.emitChanged(changed);
  }

  private emitChanged(changed: bigint): void {
    if (!changed) return;
    for (const g of this.info.gpios) if ((changed >> BigInt(g)) & 1n) this.emitPin(g);
  }

  private emitPin(g: number): void {
    const state = this.stateOf(g);
    const id = espPinId(g);
    for (const cb of this.pinCbs) cb(id, state, this._cycles);
  }
}

function hashOf(b: Uint8Array): string {
  return createHash("sha1").update(b).digest("hex");
}

export function createQemuEspBackend(opts: QemuEspBackendOptions): QemuEspBackend {
  return new QemuEspBackend(opts);
}
