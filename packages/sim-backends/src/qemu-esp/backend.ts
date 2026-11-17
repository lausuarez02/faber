// ESP32-family McuBackend on Espressif's QEMU fork (decision 0006, round 10).
//
// QEMU runs in its own process (Docker image fabwright/qemu-esp by default) with Fabwright's bridge
// patch, in lockstep: -icount makes guest time a pure function of executed instructions, and the
// patched GPIO block stops at every target time Fabwright sends ("R <ns>") until told to go on. So
// step(cycles) is synchronous and deterministic like the AVR / RP2040 backends:
//   cycles  = virtual ns × cpuHz / 1e9 (a time base at the chip's nominal clock, as in rp2040)
//   pins    = "GPIO<n>": GPIO registers, or the peripheral the GPIO matrix routes to the pin;
//             internal pull-ups / pull-downs from IO_MUX / RTC_IO ("P" lines, answered in lockstep)
//   serial  = UART0 bytes (onSerial); UART1/2 drawn as 8N1 frames on their TX pins and decoded
//             from their RX pins
//   I2C     = both controllers' transactions on the attached I2cBus (bus index kept)
//   SPI     = SPI2/SPI3 transactions on the attached SpiBus (CS by GPIO or the hardware CS0)
//   PWM     = LEDC channels drawn as edges (analogWrite, servos, tone)
//   RMT     = TX symbols drawn as edges (WS2812 / NeoPixel)
//   ADC     = the pad voltage the circuit solved, converted by QEMU's ADC model
//   I2S     = frames out to the attached I2sBus, frames in from it
//   camera  = round 13: the firmware's esp32-camera calls (wrapped in simulation builds) reach the
//             attached CameraBus through QEMU's Fabwright camera port (patch 0004): init with the
//             pins, whole frames on capture. The DVP bus, XCLK and SCCB traffic are not emulated.
// Not emulated: Wi-Fi / Bluetooth radios (networking runs over an emulated Ethernet MAC), touch
// sensing, deep sleep, RMT receive, pulse counter, MCPWM. See docs/esp32-peripherals.md.
// The 1 to 3 s container start happens in prepare() without blocking the event loop.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAMERA_FRAME_SIZES, CAMERA_PIXFORMATS, CAMERA_SENSORS as SENSOR_INFO, DEFAULT_CAMERA_SETTINGS, type CameraBus, type CameraPinRole, type I2cBus, type I2sBus, type McuBackend, type McuBusPins, type McuCapability, type PinState, type SpiBus, type Unsubscribe, type WakeInfo } from "@fabwright/sim-core";
import { ESP_CHIPS, espGpioOf, espOutputSource, espPinId, type EspChip, type EspChipInfo, type EspOutputSource } from "./chips.ts";
import { launchQemu, QEMU_ESP_IMAGE, type QemuLaunchOptions, type QemuProcess } from "./launcher.ts";
import {
  encodeAck,
  encodeAnalog,
  encodeAnswer,
  encodeData,
  encodeInput,
  encodeRun,
  encodeSerial,
  encodeSerialN,
  encodeSyncMask,
  encodeWords,
  parseBridgeLine,
  type BridgeEvent,
} from "./protocol.ts";
import { BridgeTimeoutError, SyncBridgeLink } from "./sync-link.ts";
import { patchSleepRecord } from "./sleep-record.ts";
import { EdgeQueue, PwmWave, queueRmt, queueUart, UartDecoder, type Waveform } from "./waveforms.ts";

export interface QemuEspBackendOptions {
  chip: EspChip;
  /** Starts the emulator (tests pass a fake). Default: launchQemu (Docker or native QEMU). */
  launch?: (o: QemuLaunchOptions) => QemuProcess;
  vcc?: number;
  runtime?: QemuLaunchOptions["runtime"];
  image?: string;
  icountShift?: number;
  /** See QemuLaunchOptions.network: true (QEMU NAT), { framePort } (Fabwright's device network), false. */
  network?: QemuLaunchOptions["network"];
  /** Flash size the image is padded to (MB). Default: the smallest of 2 / 4 / 8 / 16 that holds it. */
  flashSizeMB?: number;
  /** How long one step may wait for QEMU (boot included on the first one). Default 30 s. */
  timeoutMs?: number;
  /** QEMU's own output. Default: a file in the backend's temp folder (read for crash reports). */
  logFile?: string;
  /** Extra Docker labels (the local runner tags containers with its session). */
  labels?: Record<string, string>;
  /** Every bridge line QEMU sends, for debugging. */
  onBridgeLine?: (line: string) => void;
  /**
   * PSRAM in MB (QEMU `-m`), for firmware built to expect it (MicroPython's generic ESP32-S3
   * image enables PSRAM and stalls without it). Default: none.
   */
  psramMB?: number;
  /** Extra QEMU arguments, appended as is. */
  extraArgs?: readonly string[];
  /**
   * Round 14: seed for the chip's hardware random number generator (QEMU -seed): esp_random() and
   * Arduino's random() give the same sequence every run. Undefined: random, like a real chip.
   */
  seed?: number;
  /**
   * Round 14 (default true): flash writes survive reset() and a power cycle (LittleFS, SPIFFS, NVS /
   * Preferences), like the chip; load() of a different image starts from that image (a fresh
   * flash, as flashing with "erase all" does). false: every boot starts from the image.
   */
  persistFlash?: boolean;
}

/** ESP32 datasheet: VIL max 0.25 × VDD, VIH min 0.75 × VDD. */
const VIL_RATIO = 0.25;
const VIH_RATIO = 0.75;
/** Pad voltage changes below this (mV) are not sent to the ADC model. */
const ADC_STEP_MV = 1;
const FLASH_SIZES_MB = [2, 4, 8, 16];
/** First bridge version whose QEMU waits for Fabwright's "A 0" after a pull change ("P"). */
const PADS_HANDSHAKE_VERSION = 4;

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
    return new EmulatorError("docker-not-running", `The ${chip} emulator did not start: Docker is not running. Why: Fabwright runs ESP32 boards in Espressif's QEMU inside a Docker container on your computer. Fix: start Docker Desktop (macOS: open -a Docker), wait until it says running, then press Run again.`);
  }
  if (/Unable to find image|pull access denied|No such image|repository does not exist/i.test(log)) {
    return new EmulatorError("image-missing", `The ${chip} emulator did not start: the Docker image ${image} is not on this computer. Fix: run \`pnpm fabwright setup esp32\` (builds it from toolchains/qemu-esp, a few minutes), then press Run again.`);
  }
  if (/mtd|drive/i.test(log) && /error|invalid|size/i.test(log)) {
    return new EmulatorError("bad-firmware", `The ${chip} emulator refused the flash image: ${tail}. Fix: rebuild the firmware (build), which writes a merged flash image.`);
  }
  return new EmulatorError("emulator-exited", `The ${chip} emulator stopped${tail ? `: ${tail}` : " without output"}. Why: QEMU crashed or its container was removed. Fix: press Run again; if it repeats, check \`docker ps\` and Docker Desktop's memory, and report the lines above.`);
}

/** A UART TX / LEDC / RMT / CS source that draws on the pins routed to it. */
interface Source {
  key: string;
  wave: Waveform;
}

export interface EspUartListener {
  (uart: number, bytes: Uint8Array, cycle: number): void;
}

export class QemuEspBackend implements McuBackend {
  readonly kind = "process" as const;
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];
  readonly busPins?: McuBusPins;
  readonly info: EspChipInfo;
  private _cycles = 0;
  /** Virtual time (float ns) of the last event handed to the circuit. */
  private t = 0;
  private out = 0n;
  private enable = 0n;
  private inputs = 0n;
  private pullUp = 0n;
  private pullDown = 0n;
  private pinCbs = new Set<(pinId: string, state: PinState, cycle: number) => void>();
  private serialCbs = new Set<(byte: number, cycle: number) => void>();
  private uartCbs = new Set<EspUartListener>();
  private i2c?: I2cBus;
  private i2cExtra = new Map<number, I2cBus>();
  private i2cOpen = new Map<number, boolean>();
  private spi?: SpiBus;
  private spiMiso = new Map<number, number[]>();
  private i2s?: I2sBus;
  private camera?: CameraBus;
  /** The last frame handed to the firmware's camera port (read in chunks with "CD"). */
  private cameraFrame: Uint8Array = new Uint8Array(0);
  private cameraSeq = 0;
  private cameraXclk = 20_000_000;
  private link?: SyncBridgeLink;
  private proc?: QemuProcess;
  private workDir?: string;
  private logPath?: string;
  private flash?: Uint8Array;
  private flashHash = "";
  /** Round 14: the flash file QEMU writes to; kept across reset() so data written to flash survives. */
  private flashDir?: string;
  /** The flash file holds this.flash as loaded (no reboot since load); a new image rewrites it. */
  private flashStale = true;
  /** Reboots since load (a seeded RNG gets seed + boots, so a reboot does not replay the same numbers). */
  private boots = 0;
  /** True from a finished boot until the first step: load() of the same image is then a no-op. */
  private fresh = false;
  private exited = false;
  // GPIO matrix routing (from "M" / "N")
  private routeOut = new Map<number, { source: EspOutputSource; oenSel: number }>();
  private routeIn = new Map<number, number>();
  // drawn waveforms
  private sources = new Map<string, Source>();
  private ledcWaves = new Map<number, PwmWave>();
  private uartBaud = new Map<number, number>();
  private uartRx = new Map<number, UartDecoder>();
  private watchMask = 0n;
  private analogMv = new Map<number, number>();
  // lockstep
  private stopNs = Infinity;
  private qemuTarget = 0;
  private deadlines: { t: number; fn: () => void }[] = [];
  private _version = 0;
  private _features: string[] = [];
  /** Counts of bridged events since load, for tests and the fidelity report. */
  readonly stats = { gpio: 0, ledc: 0, spi: 0, rmt: 0, adc: 0, uart: 0, i2c: 0, i2sOut: 0, i2sIn: 0, parks: 0, cameraFrames: 0 };
  /** The handshake line QEMU sent ("H fabwright-esp32-bridge 5 esp32c3.gpio sync=1 feat=..."). */
  hello = "";
  /** Wall ms from launch to parked at t = 0 (the last boot). */
  bootMs = 0;

  constructor(private readonly opts: QemuEspBackendOptions) {
    this.info = ESP_CHIPS[opts.chip];
    this.cyclesPerSecond = this.info.cpuHz;
    this.vcc = opts.vcc ?? 3.3;
    this.pinIds = this.info.gpios.map(espPinId);
    const bp: { i2c?: McuBusPins["i2c"]; spi?: McuBusPins["spi"] } = {};
    if (this.info.i2cPins) bp.i2c = { sda: espPinId(this.info.i2cPins.sda), scl: espPinId(this.info.i2cPins.scl) };
    if (this.info.spiPins) {
      const s = this.info.spiPins;
      bp.spi = { mosi: espPinId(s.mosi), miso: espPinId(s.miso), sck: espPinId(s.sck), ss: espPinId(s.ss) };
    }
    this.busPins = bp;
  }

  get cycles(): number {
    return this._cycles;
  }

  /** Virtual time in ns. */
  get virtualNs(): bigint {
    return BigInt(Math.floor(this.t));
  }

  /** Bridge protocol version of the running image (2 = round 9, 5 = peripherals + pads). */
  get bridgeVersion(): number {
    return this._version;
  }

  /** Same as bridgeVersion (round 10 esp-app name). */
  get version(): number {
    return this._version;
  }

  get image(): string {
    return this.opts.image ?? process.env.FABWRIGHT_QEMU_ESP_IMAGE ?? QEMU_ESP_IMAGE;
  }

  /** What this backend carries to the circuit with the running image (before load: what a current image does). */
  get capabilities(): readonly McuCapability[] {
    if (this._version === 0) return this.info.capabilities;
    if (this._version < 3) return this.opts.chip === "esp32" ? ["gpio", "uart", "i2c", "net"] : ["gpio", "uart", "net"];
    const feat = new Set(this._features);
    // QEMU names a few features after the peripheral: "ledc" is PWM, "pads" the pull-ups / pull-downs.
    // The camera port (patch 0004) is not announced in the hello line: it comes with the emulator build.
    return this.info.capabilities.filter((c) => c === "net" || c === "camera" || feat.has(c) || (c === "pulls" && feat.has("pads")) || (c === "pwm" && feat.has("ledc")));
  }

  /** Boots asynchronously (container start + handshake up to t = 0); a later load() of the same image is a no-op. */
  async prepare(firmware: Uint8Array | string): Promise<void> {
    const image = this.toImage(firmware);
    if (this.fresh && this.link && this.sameImage(image)) return;
    this.setImage(image);
    const t0 = Date.now();
    const link = this.launch();
    const timeout = this.opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    let parked = false;
    while (!parked) {
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
      for (const line of lines) {
        if (!line) continue;
        this.opts.onBridgeLine?.(line);
        const r = this.handle(parseBridgeLine(line), line);
        if (r?.parked !== undefined) parked = true;
        if (r?.answer !== undefined) link.send(r.answer);
      }
      if (!parked && link.closed) throw this.crash();
    }
    this.afterBoot(link);
    this.bootMs = Date.now() - t0;
  }

  load(firmware: Uint8Array | string): void {
    const image = this.toImage(firmware);
    if (this.fresh && this.link && this.sameImage(image)) return;
    this.setImage(image);
    this.start();
  }

  /** A fresh run from the loaded image: flash as built, the RNG from its seed (cycles → 0). */
  reset(): void {
    if (!this.flash) return;
    this.boots = 0;
    this.flashStale = true;
    this.start();
  }

  /**
   * Round 14: reboot mid-run (reset button, power cycle): what the firmware wrote to flash stays
   * (persistFlash), and a seeded RNG moves on to seed + reboots (a real chip does not replay its numbers).
   */
  reboot(): void {
    if (!this.flash) return;
    this.boots++;
    this.start();
  }

  /** Round 15: the next reboot is a wake from deep sleep: the FabwrightSleep shim's flash record gets the cause. */
  setWakeInfo(info: WakeInfo): void {
    this.pendingWake = info;
  }

  /** Round 15: what happened to the last wake record ("patched", or why not). */
  lastWake?: string;
  private pendingWake?: WakeInfo;

  /**
   * Round 14: the flash as it is now (the image plus what the firmware wrote: LittleFS, NVS...), or
   * undefined before a load. Read while QEMU is parked; the file is what QEMU last wrote.
   */
  readFlash(): Uint8Array | undefined {
    const f = this.flashDir ? join(this.flashDir, "flash.bin") : undefined;
    if (f && existsSync(f) && !this.flashStale) return new Uint8Array(readFileSync(f));
    return this.flash;
  }

  /** Stops QEMU and the bridge. The backend can be load()ed again. */
  close(): void {
    this.stopProcess();
    this.fresh = false;
    if (this.workDir) rmSync(this.workDir, { recursive: true, force: true });
    this.workDir = undefined;
    if (this.flashDir) rmSync(this.flashDir, { recursive: true, force: true });
    this.flashDir = undefined;
    this.flashStale = true;
  }

  private stopProcess(): void {
    this.proc?.stop();
    this.link?.close();
    this.proc = undefined;
    this.link = undefined;
  }

  /** Same as close(): process backends must be disposed (decision 0006). */
  dispose(): void {
    this.close();
  }

  step(cycles: number): void {
    const link = this.link;
    if (!link) throw new EmulatorError("emulator-exited", "The ESP32 emulator is not running (no firmware loaded, or it was stopped). Fix: press Run again.");
    const target = Math.round(((this._cycles + Math.max(0, cycles)) * 1e9) / this.cyclesPerSecond);
    if (target <= this.t) return;
    this.stopNs = target;
    this.fresh = false;
    this.sendRun(link, this.nextStop());
    this.pump(link);
    this.stopNs = Infinity;
  }

  stopAt(cycle: number): void {
    const ns = Math.round((cycle * 1e9) / this.cyclesPerSecond);
    if (ns < this.stopNs) this.stopNs = Math.max(ns, Math.ceil(this.t));
  }

  readPin(pinId: string): PinState {
    const g = espGpioOf(pinId);
    if (g === undefined) throw new Error(`unknown pin '${pinId}' (ESP pins are GPIO<n>)`);
    return this.stateOf(g);
  }

  setPinInput(pinId: string, volts: number): void {
    const g = espGpioOf(pinId);
    if (g === undefined || !this.info.gpios.includes(g)) throw new Error(`unknown pin '${pinId}' on ${this.info.chip}. Valid pins: ${this.pinIds.join(", ")}.`);
    if (this.info.adc[g]) {
      const mv = Math.round(volts * 1000);
      const last = this.analogMv.get(g);
      if (last === undefined || Math.abs(mv - last) >= ADC_STEP_MV) {
        this.analogMv.set(g, mv);
        this.link?.send(encodeAnalog(g, mv));
      }
    }
    const bit = 1n << BigInt(g);
    const was = (this.inputs & bit) !== 0n;
    let level = was;
    if (volts <= VIL_RATIO * this.vcc) level = false;
    else if (volts >= VIH_RATIO * this.vcc) level = true;
    if (level === was) return;
    this.inputs = level ? this.inputs | bit : this.inputs & ~bit;
    // QEMU is blocked (parked or waiting for an answer) while Fabwright runs, so the level applies at
    // exactly the current virtual time.
    this.link?.send(encodeInput(g, level ? 1 : 0));
    this.rxEdge(g, level ? 1 : 0);
    if (this.outputSourceOf(g) === undefined) this.emitPin(g);
  }

  onPinChange(cb: (pinId: string, state: PinState, cycle: number) => void): Unsubscribe {
    this.pinCbs.add(cb);
    return () => this.pinCbs.delete(cb);
  }

  onSerial(cb: (byte: number, cycle: number) => void): Unsubscribe {
    this.serialCbs.add(cb);
    return () => this.serialCbs.delete(cb);
  }

  /** Bytes the firmware sends on UART1 / UART2 (also drawn on their TX pins when routed). */
  onUart(cb: EspUartListener): Unsubscribe {
    this.uartCbs.add(cb);
    return () => this.uartCbs.delete(cb);
  }

  writeSerial(byte: number): void {
    this.link?.send(encodeSerial([byte]));
  }

  /** Bytes into UART1 / UART2 RX directly (parts on pins go through the RX pin instead). */
  writeUart(uart: number, bytes: Iterable<number>): void {
    if (uart === 0) this.link?.send(encodeSerial(bytes));
    else this.link?.send(encodeSerialN(uart, bytes));
  }

  attachI2c(bus: I2cBus): void {
    this.i2c = bus;
  }

  /** A separate bus for I2C controller `index` (1 = Wire1). Without it, every controller uses the attachI2c bus. */
  attachI2cBus(index: number, bus: I2cBus): void {
    if (index === 0) this.i2c = bus;
    else this.i2cExtra.set(index, bus);
  }

  attachSpi(bus: SpiBus): void {
    this.spi = bus;
  }

  attachI2s(bus: I2sBus): void {
    this.i2s = bus;
  }

  attachCamera(bus: CameraBus): void {
    this.camera = bus;
  }

  pinWatched(pinId: string): void {
    const g = espGpioOf(pinId);
    if (g === undefined) return;
    const mask = this.watchMask | (1n << BigInt(g));
    if (mask === this.watchMask) return;
    this.watchMask = mask;
    this.link?.send(encodeSyncMask(mask));
  }

  /** Where pin `g`'s output comes from (undefined = the GPIO registers). */
  routeOf(pinId: string): EspOutputSource | undefined {
    const g = espGpioOf(pinId);
    return g === undefined ? undefined : this.routeOut.get(g)?.source;
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
    this.boots = 0;
    this.flash = image;
    this.flashHash = hashOf(image);
    this.flashStale = true;
  }

  /** Starts QEMU for the current image and blocks until it parks at t = 0 (the synchronous load()). */
  private start(): void {
    const t0 = Date.now();
    const link = this.launch();
    // Handshake: QEMU connects, says hello, and parks at virtual time 0 waiting for the first "R".
    this.stopNs = 0;
    try {
      this.pump(link);
    } finally {
      this.stopNs = Infinity;
    }
    this.afterBoot(link);
    this.bootMs = Date.now() - t0;
  }

  private afterBoot(link: SyncBridgeLink): void {
    if (!this.hello) {
      const err = new EmulatorError("emulator-exited", `The ESP32 emulator connected but did not identify itself. Why: the Docker image is older than this Fabwright. Fix: run \`pnpm fabwright setup esp32\` to build ${QEMU_ESP_IMAGE}.`);
      this.close();
      throw err;
    }
    this.fresh = true;
    for (let g = 0; g < 64; g++) if ((this.inputs >> BigInt(g)) & 1n) link.send(encodeInput(g, 1));
    for (const [g, mv] of this.analogMv) link.send(encodeAnalog(g, mv));
    if (this.watchMask) link.send(encodeSyncMask(this.watchMask));
  }

  /** Stops what runs, resets the state and launches QEMU for the current image. */
  private launch(): SyncBridgeLink {
    this.stopProcess();
    this.fresh = false;
    if (this.workDir) rmSync(this.workDir, { recursive: true, force: true });
    this.workDir = undefined;
    this._cycles = 0;
    this.t = 0;
    this.out = 0n;
    this.enable = 0n;
    this.pullUp = 0n;
    this.pullDown = 0n;
    this.hello = "";
    this._version = 0;
    this._features = [];
    this.exited = false;
    this.routeOut.clear();
    this.routeIn.clear();
    this.sources.clear();
    this.ledcWaves.clear();
    this.uartBaud.clear();
    this.uartRx.clear();
    // analogMv is kept: a pad voltage the circuit set before the boot is sent again after it.
    this.spiMiso.clear();
    this.i2cOpen.clear();
    this.deadlines = [];
    for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0;
    this.workDir = mkdtempSync(join(tmpdir(), "fabwright-qemu-esp-"));
    // Round 14: the flash file lives in its own folder that a reboot keeps, so what the firmware wrote
    // (LittleFS, NVS) is there after reset(); a new image (load) or persistFlash false starts over.
    const persist = this.opts.persistFlash !== false;
    if (!this.flashDir) this.flashDir = mkdtempSync(join(tmpdir(), "fabwright-qemu-flash-"));
    const flashImage = join(this.flashDir, "flash.bin");
    if (!persist || this.flashStale || !existsSync(flashImage)) writeFileSync(flashImage, this.flash!);
    this.flashStale = false;
    if (this.pendingWake) {
      // round 15: a wake from deep sleep: tell the shim why and how long it slept (QEMU is stopped here)
      const bytes = new Uint8Array(readFileSync(flashImage));
      this.lastWake = patchSleepRecord(bytes, this.pendingWake);
      if (this.lastWake === "patched") writeFileSync(flashImage, bytes);
      this.pendingWake = undefined;
    }
    this.logPath = this.opts.logFile ?? join(this.workDir, "qemu.log");
    const link = new SyncBridgeLink();
    this.link = link;
    const proc = (this.opts.launch ?? launchQemu)({
      chip: this.opts.chip,
      flashImage,
      bridgePort: link.port,
      runtime: this.opts.runtime,
      image: this.image,
      icountShift: this.opts.icountShift,
      network: this.opts.network,
      logFile: this.logPath,
      persistFlash: persist,
      ...(this.opts.seed !== undefined ? { seed: this.opts.seed + this.boots } : {}),
      ...(this.opts.labels ? { labels: this.opts.labels } : {}),
      extraArgs: [...(this.opts.psramMB ? ["-m", `${this.opts.psramMB}M`] : []), ...(this.opts.extraArgs ?? [])],
    });
    this.proc = proc;
    const gone = () => {
      if (this.proc === proc) this.exited = true;
    };
    proc.child.once("exit", gone);
    proc.child.once("error", gone);
    return link;
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

  private nextStop(): number {
    let t = this.stopNs;
    for (const d of this.deadlines) if (d.t < t) t = d.t;
    return t;
  }

  private sendRun(link: SyncBridgeLink, ns: number): void {
    const target = Math.max(Math.ceil(ns), Math.ceil(this.t));
    this.qemuTarget = target;
    link.send(encodeRun(BigInt(target)));
  }

  /** Handles lines until QEMU parks at or after the step's end ("T"). */
  private pump(link: SyncBridgeLink): void {
    const timeout = this.opts.timeoutMs ?? 30_000;
    for (;;) {
      if (link.closed) throw this.crash();
      let lines: string[];
      try {
        lines = link.next(timeout);
      } catch (err) {
        if (err instanceof BridgeTimeoutError) throw this.exited ? this.crash() : this.timeoutError(timeout);
        throw err;
      }
      let parkedAt: number | undefined;
      let answer: string | undefined;
      for (const line of lines) {
        if (!line) continue;
        this.opts.onBridgeLine?.(line);
        const ev = parseBridgeLine(line);
        const r = this.handle(ev, line);
        if (r?.parked !== undefined) parkedAt = r.parked;
        if (r?.answer !== undefined) answer = r.answer;
      }
      if (parkedAt !== undefined) {
        this.stats.parks++;
        this.flushTo(parkedAt);
        this.advance(parkedAt);
        this.runDeadlines(parkedAt);
        if (parkedAt >= this.stopNs) return;
        this.sendRun(link, this.nextStop());
        continue;
      }
      if (answer !== undefined) {
        // QEMU waits for this answer; if a part asked to stop earlier, move the target first.
        const want = Math.ceil(this.nextStop());
        if (want < this.qemuTarget) this.sendRun(link, want);
        link.send(answer);
      }
    }
  }

  private handle(ev: BridgeEvent, line: string): { parked?: number; answer?: string } | undefined {
    switch (ev.kind) {
      case "hello":
        this.hello = line;
        this._version = ev.version;
        this._features = ev.features;
        return undefined;
      case "time":
        return { parked: Number(ev.ns) };
      case "gpio":
        this.at(ev.ns);
        this.stats.gpio++;
        this.applyGpio(ev.out, ev.enable);
        return undefined;
      case "pads":
        this.at(ev.ns);
        // The circuit re-solves inside the pin callbacks and drives the new input levels ("I");
        // only then may QEMU go on (from bridge v4 QEMU waits for this answer in lockstep).
        this.applyPads(ev.pullUp, ev.pullDown);
        return this._version >= PADS_HANDSHAKE_VERSION ? { answer: encodeAck(true) } : undefined;
      case "route-out":
        this.at(ev.ns);
        this.routeOutput(ev.gpio, ev.signal, ev.oenSel);
        return undefined;
      case "route-in":
        if (ev.matrix) this.routeIn.set(ev.signal, ev.gpio);
        else this.routeIn.delete(ev.signal);
        return undefined;
      case "uart":
        this.at(ev.ns);
        for (const b of ev.bytes) for (const cb of this.serialCbs) cb(b, this._cycles);
        return undefined;
      case "uart-n":
        this.at(ev.ns);
        this.uartTx(ev.uart, ev.bytes);
        return undefined;
      case "baud":
        this.uartBaud.set(ev.uart, ev.baud);
        if (this.uartRx.has(ev.uart)) this.uartRx.get(ev.uart)!.baud = ev.baud;
        return undefined;
      case "i2c-start": {
        this.at(ev.ns);
        this.stats.i2c++;
        const bus = this.i2cOf(ev.bus);
        let ack = false;
        if (bus) {
          bus.start(this.i2cOpen.get(ev.bus) ?? false);
          ack = bus.connect(ev.addr, ev.read);
        }
        this.i2cOpen.set(ev.bus, true);
        return { answer: encodeAck(ack) };
      }
      case "i2c-write":
        this.i2cOf(ev.bus)?.write(ev.byte);
        return undefined;
      case "i2c-read":
        return { answer: encodeData(this.i2cOf(ev.bus)?.read(true) ?? 0xff) };
      case "i2c-stop":
        this.i2cOf(ev.bus)?.stop();
        this.i2cOpen.set(ev.bus, false);
        return undefined;
      case "ledc":
        this.at(ev.ns);
        this.stats.ledc++;
        this.ledc(ev);
        return undefined;
      case "spi":
        this.at(ev.ns);
        this.stats.spi++;
        this.spiTransfer(ev.host, ev.hwCs, Number(ev.durNs), ev.mosi);
        return undefined;
      case "spi-query":
        return { answer: encodeAnswer(this.spiMiso.get(ev.host) ?? []) };
      case "rmt":
        this.at(ev.ns);
        this.stats.rmt++;
        this.rmt(ev.ch, Number(ev.tickPs) / 1000, ev.idle, ev.words);
        return undefined;
      case "adc":
        this.stats.adc++;
        return undefined;
      case "i2s-out":
        this.at(ev.ns);
        this.stats.i2sOut++;
        this.i2sOut(ev);
        return undefined;
      case "i2s-in":
        this.at(ev.ns);
        this.stats.i2sIn++;
        return { answer: this.i2sIn(ev) };
      case "camera":
        this.at(ev.ns);
        return { answer: encodeWords(this.cameraCommand(ev.cmd, ev.args)) };
      case "camera-data":
        return { answer: encodeAnswer(this.cameraFrame.subarray(ev.offset, ev.offset + ev.length)) };
      default:
        return undefined;
    }
  }

  private i2cOf(index: number): I2cBus | undefined {
    return this.i2cExtra.get(index) ?? this.i2c;
  }

  /** Moves time to a QEMU event at `ns`, drawing every waveform edge before it first. */
  private at(ns: bigint): void {
    const t = Number(ns);
    this.flushTo(t);
    this.advance(t);
  }

  private advance(t: number): void {
    if (t > this.t) {
      this.t = t;
      this._cycles = Math.round((t * this.cyclesPerSecond) / 1e9);
    }
  }

  /** Emits every drawn edge with time < until (or ≤ at a park), in time order across sources. */
  private flushTo(until: number): void {
    if (this.sources.size === 0) return;
    for (;;) {
      let best: Source | undefined;
      let bestT = Infinity;
      for (const s of this.sources.values()) {
        const e = s.wave.peek();
        if (e && e.t < bestT) {
          bestT = e.t;
          best = s;
        }
      }
      if (!best || bestT > until) return;
      best.wave.take();
      this.advance(bestT);
      for (const [g, r] of this.routeOut) if (sourceKey(r.source) === best.key) this.emitPin(g);
    }
  }

  private runDeadlines(now: number): void {
    for (;;) {
      this.deadlines.sort((a, b) => a.t - b.t);
      const d = this.deadlines[0];
      if (!d || d.t > now) return;
      this.deadlines.shift();
      d.fn();
    }
  }

  private routeOutput(g: number, signal: number, oenSel: number): void {
    const source = espOutputSource(this.info, signal);
    const before = this.stateOf(g);
    if (source.kind === "gpio") this.routeOut.delete(g);
    else this.routeOut.set(g, { source, oenSel });
    const after = this.stateOf(g);
    if (before.mode !== after.mode || before.value !== after.value) this.emitPin(g);
  }

  /** The drawn source routed to pin g, if any. */
  private outputSourceOf(g: number): Source | undefined {
    const r = this.routeOut.get(g);
    return r ? this.sources.get(sourceKey(r.source)) : undefined;
  }

  private source(key: string, make: () => Waveform): Source {
    let s = this.sources.get(key);
    if (!s) {
      s = { key, wave: make() };
      this.sources.set(key, s);
    }
    return s;
  }

  private ledc(ev: Extract<BridgeEvent, { kind: "ledc" }>): void {
    const key = sourceKey({ kind: "ledc", ch: ev.ch });
    let wave = this.ledcWaves.get(ev.ch);
    if (!wave) {
      wave = new PwmWave(this.t, ev.idle);
      this.ledcWaves.set(ev.ch, wave);
      this.sources.set(key, { key, wave });
    }
    const before = wave.level;
    wave.update(this.t, {
      enabled: ev.enabled,
      idle: ev.idle,
      periodNs: Number(ev.periodPs) / 1000,
      highNs: Number(ev.highPs) / 1000,
      phaseNs: Number(ev.phasePs) / 1000,
    });
    if (wave.level !== before) for (const [g, r] of this.routeOut) if (sourceKey(r.source) === key) this.emitPin(g);
  }

  private rmt(ch: number, tickNs: number, idle: 0 | 1, words: Uint32Array): void {
    const s = this.source(sourceKey({ kind: "rmt", ch }), () => new EdgeQueue(idle, this.t));
    queueRmt(s.wave as EdgeQueue, this.t, tickNs, words, idle);
  }

  private uartTx(uart: number, bytes: Uint8Array): void {
    this.stats.uart += bytes.length;
    for (const cb of this.uartCbs) cb(uart, bytes, this._cycles);
    const key = sourceKey({ kind: "uart-tx", uart });
    const routed = [...this.routeOut.values()].some((r) => sourceKey(r.source) === key);
    if (!routed) return;
    const s = this.source(key, () => new EdgeQueue(1, this.t));
    queueUart(s.wave as EdgeQueue, this.t, this.uartBaud.get(uart) ?? 115200, bytes);
  }

  /** A part drove an input: feed the UART receiver whose RX the matrix routes from this pin. */
  private rxEdge(g: number, level: 0 | 1): void {
    for (let u = 1; u < this.info.signals.uartRx.length; u++) {
      if (this.routeIn.get(this.info.signals.uartRx[u]!) !== g) continue;
      let dec = this.uartRx.get(u);
      if (!dec) {
        dec = new UartDecoder(this.uartBaud.get(u) ?? 115200);
        this.uartRx.set(u, dec);
      }
      const due = dec.edge(this.t, level);
      if (due !== undefined) this.scheduleRx(u, dec, due);
    }
  }

  private scheduleRx(u: number, dec: UartDecoder, due: number): void {
    this.deadlines.push({
      t: due,
      fn: () => {
        const r = dec.complete();
        if (r.byte !== undefined) this.link?.send(encodeSerialN(u, [r.byte]));
        if (r.nextAt !== undefined) this.scheduleRx(u, dec, r.nextAt);
      },
    });
  }

  private spiTransfer(host: number, hwCs: boolean, durNs: number, mosi: Uint8Array): void {
    const lines = this.info.signals.spi[host as 2 | 3];
    let csPin: number | undefined;
    if (hwCs && lines) for (const [g, r] of this.routeOut) if (r.source.kind === "spi" && r.source.host === host && r.source.line === "cs0") csPin = g;
    let cs: EdgeQueue | undefined;
    if (csPin !== undefined) {
      const s = this.source(`spi${host}:cs0`, () => new EdgeQueue(1, this.t));
      cs = s.wave as EdgeQueue;
      cs.clear(0);
      this.emitPin(csPin);
    }
    const miso: number[] = [];
    for (const b of mosi) miso.push(this.spi ? this.spi.transfer(b) : 0xff);
    this.spiMiso.set(host, miso);
    if (cs) cs.push(this.t + durNs, 1);
  }

  private i2sOut(ev: Extract<BridgeEvent, { kind: "i2s-out" }>): void {
    if (!this.i2s) return;
    const bytesPer = ev.bits <= 16 ? 2 : 4;
    const n = Math.floor(ev.data.length / bytesPer);
    const samples = new Int32Array(n);
    const dv = new DataView(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    for (let i = 0; i < n; i++) samples[i] = bytesPer === 2 ? dv.getInt16(2 * i, true) : dv.getInt32(4 * i, true);
    // The block is reported once it has played (QEMU reads the DMA buffer at its end); its first
    // frame left at ev.ns.
    this.i2s.send({ cycle: Math.round((Number(ev.ns) * this.cyclesPerSecond) / 1e9), sampleRate: ev.rate, bits: ev.bits, channels: ev.channels, samples });
  }

  /**
   * The camera shim's commands (toolchains/arduino-esp32/libraries/FabwrightCamera/src/fabwright_sim_camera.c).
   * Answer words: init → [status, pid, mid, ver, max frame size, sccb address, init µs];
   * capture → [status, length, width, height, pixformat, capture µs, sequence]. Status 0 = ok,
   * 1 = no camera answers, 2 = not supported, 3 = frame size too large.
   */
  private cameraCommand(cmd: number, a: number[]): number[] {
    const fmtOf = (i: number) => CAMERA_PIXFORMATS[i] ?? "unknown";
    if (cmd === 1) {
      const pin = (w: number, shift: number) => {
        const g = (a[w]! >>> shift) & 0xff;
        return g === 0xff ? undefined : espPinId(g);
      };
      const pins: Partial<Record<CameraPinRole, string>> = {};
      const put = (role: CameraPinRole, v: string | undefined) => {
        if (v) pins[role] = v;
      };
      put("pwdn", pin(0, 0));
      put("reset", pin(0, 8));
      put("xclk", pin(0, 16));
      put("sda", pin(0, 24));
      put("scl", pin(1, 0));
      put("vsync", pin(1, 8));
      put("href", pin(1, 16));
      put("pclk", pin(1, 24));
      for (let i = 0; i < 8; i++) put(`d${i}` as CameraPinRole, pin(2 + (i >> 2), 8 * (i & 3)));
      this.cameraXclk = a[4] || 20_000_000;
      const r = this.camera?.init({
        cycle: this._cycles,
        pins,
        xclkHz: this.cameraXclk,
        format: fmtOf(a[5]! & 0xff),
        frameSize: (a[5]! >>> 8) & 0xff,
        quality: (a[5]! >>> 16) & 0xff,
        fbCount: (a[5]! >>> 24) & 0xff,
        fbInPsram: (a[6]! & 0xff) === 0,
      });
      if (!r || !r.ok || !r.sensor) return [r?.code === "bad-size" ? 3 : r?.code === "not-supported" ? 2 : 1, 0, 0, 0, 0, 0, r?.latencyUs ?? 300_000];
      const s = SENSOR_INFO[r.sensor];
      return [0, s.pid, s.mid, s.ver, CAMERA_FRAME_SIZES.findIndex((f) => f.id === s.maxSize), s.sccbAddr, r.latencyUs];
    }
    if (cmd === 2) {
      const fx = a[4]!;
      const settings = {
        ...DEFAULT_CAMERA_SETTINGS,
        hmirror: (fx & 1) !== 0,
        vflip: (fx & 2) !== 0,
        colorbar: (fx & 4) !== 0,
        brightness: ((fx >>> 4) & 0xf) - 2,
        contrast: ((fx >>> 8) & 0xf) - 2,
        saturation: ((fx >>> 12) & 0xf) - 2,
        effect: (fx >>> 16) & 0xf,
        aeLevel: ((fx >>> 20) & 0xf) - 2,
      };
      const frame = this.camera?.capture({ cycle: this._cycles, format: fmtOf(a[0]!), width: a[1]!, height: a[2]!, quality: a[3]!, settings, capacity: a[5]!, xclkHz: this.cameraXclk });
      if (!frame) {
        this.cameraFrame = new Uint8Array(0);
        return [1, 0, 0, 0, 0, 0, 0];
      }
      this.cameraFrame = frame.data;
      this.stats.cameraFrames++;
      return [0, frame.data.length, frame.width, frame.height, CAMERA_PIXFORMATS.indexOf(frame.format), frame.latencyUs, ++this.cameraSeq];
    }
    if (cmd === 3) this.camera?.deinit();
    return [0];
  }

  private i2sIn(ev: Extract<BridgeEvent, { kind: "i2s-in" }>): string {
    const bytesPer = ev.bits <= 16 ? 2 : 4;
    const samples = this.i2s
      ? this.i2s.request({ cycle: this._cycles, sampleRate: ev.rate, bits: ev.bits, channels: ev.channels, frames: ev.frames })
      : new Int32Array(ev.frames * ev.channels);
    const out = new Uint8Array(samples.length * bytesPer);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) {
      if (bytesPer === 2) dv.setInt16(2 * i, Math.max(-32768, Math.min(32767, samples[i]!)), true);
      else dv.setInt32(4 * i, samples[i]!, true);
    }
    return encodeAnswer(out);
  }

  private stateOf(g: number): PinState {
    const bit = 1n << BigInt(g);
    const r = this.routeOut.get(g);
    if (r) {
      const enabled = r.oenSel === 0 || (this.enable & bit) !== 0n;
      const src = this.sources.get(sourceKey(r.source));
      if (src && enabled) return { mode: "output", value: src.wave.level };
      // Bus pins the backend carries as transactions: idle levels.
      if (r.source.kind === "spi" && r.source.line !== "miso" && enabled) return { mode: "output", value: r.source.line === "cs0" ? 1 : 0 };
      if (r.source.kind === "uart-tx" && enabled) return { mode: "output", value: 1 };
      if (r.source.kind === "i2s" && enabled) return { mode: "output", value: 0 };
    }
    if (this.enable & bit) return { mode: "output", value: this.out & bit ? 1 : 0 };
    const value = this.inputs & bit ? 1 : 0;
    if (this.pullUp & bit) return { mode: "input_pullup", value };
    if (this.pullDown & bit) return { mode: "input_pulldown", value };
    return { mode: "input", value };
  }

  private applyPads(pullUp: bigint, pullDown: bigint): void {
    const changed = (pullUp ^ this.pullUp) | (pullDown ^ this.pullDown);
    this.pullUp = pullUp;
    this.pullDown = pullDown;
    if (!changed) return;
    for (const g of this.info.gpios) if ((changed >> BigInt(g)) & 1n && this.outputSourceOf(g) === undefined && !(this.enable & (1n << BigInt(g)))) this.emitPin(g);
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

function sourceKey(s: EspOutputSource): string {
  switch (s.kind) {
    case "ledc":
      return `ledc${s.ch}`;
    case "rmt":
      return `rmt${s.ch}`;
    case "uart-tx":
      return `uart${s.uart}:tx`;
    case "spi":
      return `spi${s.host}:${s.line}`;
    case "i2s":
      return `i2s:${s.line}`;
    case "gpio":
      return "gpio";
    default:
      return `sig${s.signal}`;
  }
}

function hashOf(b: Uint8Array): string {
  return createHash("sha1").update(b).digest("hex");
}

export function createQemuEspBackend(opts: QemuEspBackendOptions): QemuEspBackend {
  return new QemuEspBackend(opts);
}
