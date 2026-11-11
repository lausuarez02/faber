// ESP32-family McuBackend on Espressif's QEMU fork.
//
// QEMU runs in its own process (Docker image jumper/qemu-esp by default) with Jumper's bridge
// patch, in lockstep: -icount makes guest time a pure function of executed instructions, and the
// patched GPIO block stops at every target time Jumper sends ("R <ns>") until told to go on. So
// step(cycles) is synchronous and deterministic like the AVR / RP2040 backends:
//   cycles  = virtual ns × cpuHz / 1e9 (a time base at the chip's nominal clock, as in rp2040)
//   pins    = "GPIO<n>": GPIO registers, or the peripheral the GPIO matrix routes to the pin
//   serial  = UART0 bytes (onSerial); UART1/2 drawn as 8N1 frames on their TX pins and decoded
//             from their RX pins
//   I2C     = both controllers' transactions on the attached I2cBus (bus index kept)
//   SPI     = SPI2/SPI3 transactions on the attached SpiBus (CS by GPIO or the hardware CS0)
//   PWM     = LEDC channels drawn as edges (analogWrite, servos, tone)
//   RMT     = TX symbols drawn as edges (WS2812 / NeoPixel)
//   ADC     = the pad voltage the circuit solved, converted by QEMU's ADC model
//   I2S     = frames out to the attached I2sBus, frames in from it
// Not emulated: Wi-Fi / Bluetooth radios (networking runs over an emulated Ethernet MAC), touch
// sensing, deep sleep, RMT receive, pulse counter, MCPWM. See docs/esp32-peripherals.md.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { I2cBus, I2sBus, McuBackend, McuBusPins, PinMode, PinState, SpiBus, Unsubscribe } from "@jumper/sim-core";
import { ESP_CHIPS, espGpioOf, espOutputSource, espPinId, type EspCapability, type EspChip, type EspChipInfo, type EspOutputSource } from "./chips.ts";
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
  parseBridgeLine,
  type BridgeEvent,
} from "./protocol.ts";
import { SyncBridgeLink } from "./sync-link.ts";
import { EdgeQueue, PwmWave, queueRmt, queueUart, UartDecoder, type Waveform } from "./waveforms.ts";

export interface QemuEspBackendOptions {
  chip: EspChip;
  /** Starts the emulator (tests pass a fake). Default: launchQemu (Docker or native QEMU). */
  launch?: (o: QemuLaunchOptions) => QemuProcess;
  vcc?: number;
  runtime?: QemuLaunchOptions["runtime"];
  image?: string;
  icountShift?: number;
  network?: boolean;
  /** How long one step may wait for QEMU (boot included on the first one). Default 30 s. */
  timeoutMs?: number;
  logFile?: string;
  /** Every bridge line QEMU sends, for debugging. */
  onBridgeLine?: (line: string) => void;
}

/** ESP32 datasheet: VIL max 0.25 × VDD, VIH min 0.75 × VDD. */
const VIL_RATIO = 0.25;
const VIH_RATIO = 0.75;
/** Pad voltage changes below this (mV) are not sent to the ADC model. */
const ADC_STEP_MV = 1;

/** A UART TX / LEDC / RMT / CS source that draws on the pins routed to it. */
interface Source {
  key: string;
  wave: Waveform;
}

export interface EspUartListener {
  (uart: number, bytes: Uint8Array, cycle: number): void;
}

export class QemuEspBackend implements McuBackend {
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
  private pinCbs = new Set<(pinId: string, state: PinState, cycle: number) => void>();
  private serialCbs = new Set<(byte: number, cycle: number) => void>();
  private uartCbs = new Set<EspUartListener>();
  private i2c?: I2cBus;
  private i2cExtra = new Map<number, I2cBus>();
  private i2cOpen = new Map<number, boolean>();
  private spi?: SpiBus;
  private spiMiso = new Map<number, number[]>();
  private i2s?: I2sBus;
  private link?: SyncBridgeLink;
  private proc?: QemuProcess;
  private workDir?: string;
  private flash?: Uint8Array;
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
  readonly stats = { gpio: 0, ledc: 0, spi: 0, rmt: 0, adc: 0, uart: 0, i2c: 0, i2sOut: 0, i2sIn: 0, parks: 0 };
  /** The handshake line QEMU sent ("H jumper-esp32-bridge 3 esp32c3.gpio sync=1 feat=..."). */
  hello = "";

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

  /** Bridge protocol version of the running image (2 = round 9, 3 = peripherals). */
  get bridgeVersion(): number {
    return this._version;
  }

  /** What this backend carries to the circuit with the running image (before load: what a current image does). */
  get capabilities(): readonly EspCapability[] {
    if (this._version === 0) return this.info.capabilities;
    if (this._version < 3) return this.opts.chip === "esp32" ? ["gpio", "uart", "i2c", "net"] : ["gpio", "uart", "net"];
    return this.info.capabilities.filter((c) => c === "net" || this._features.includes(c));
  }

  load(firmware: Uint8Array | string): void {
    if (typeof firmware === "string") throw new Error("the ESP32 backend loads a merged flash image (bytes), not Intel HEX. Fix: build with the jumper/arduino-esp32 image, which writes <sketch>.ino.merged.bin.");
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

  /** Same as close(): process backends must be disposed (decision 0006). */
  dispose(): void {
    this.close();
  }

  step(cycles: number): void {
    const link = this.link;
    if (!link) throw new Error("no firmware loaded");
    const target = Math.round(((this._cycles + Math.max(0, cycles)) * 1e9) / this.cyclesPerSecond);
    if (target <= this.t) return;
    this.stopNs = target;
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
    // QEMU is blocked (parked or waiting for an answer) while Jumper runs, so the level applies at
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

  private start(): void {
    this.close();
    this._cycles = 0;
    this.t = 0;
    this.out = 0n;
    this.enable = 0n;
    this.routeOut.clear();
    this.routeIn.clear();
    this.sources.clear();
    this.ledcWaves.clear();
    this.uartBaud.clear();
    this.uartRx.clear();
    this.analogMv.clear();
    this.spiMiso.clear();
    this.i2cOpen.clear();
    this.deadlines = [];
    for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0;
    this.workDir = mkdtempSync(join(tmpdir(), "jumper-qemu-esp-"));
    const flashImage = join(this.workDir, "flash.bin");
    writeFileSync(flashImage, this.flash!);
    const link = new SyncBridgeLink();
    this.link = link;
    this.proc = (this.opts.launch ?? launchQemu)({
      chip: this.opts.chip,
      flashImage,
      bridgePort: link.port,
      runtime: this.opts.runtime,
      image: this.opts.image ?? process.env.JUMPER_QEMU_ESP_IMAGE ?? QEMU_ESP_IMAGE,
      icountShift: this.opts.icountShift,
      network: this.opts.network,
      logFile: this.opts.logFile,
    });
    // Handshake: QEMU connects, says hello, and parks at virtual time 0 waiting for the first "R".
    this.stopNs = 0;
    this.pump(link);
    this.stopNs = Infinity;
    if (!this.hello) throw new Error("the emulator connected but did not identify itself. Fix: rebuild the QEMU image (toolchains/qemu-esp, `jumper setup esp32`).");
    for (let g = 0; g < 64; g++) if ((this.inputs >> BigInt(g)) & 1n) link.send(encodeInput(g, 1));
    if (this.watchMask) link.send(encodeSyncMask(this.watchMask));
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
      if (link.closed) throw new Error("the emulator exited. Fix: check that Docker Desktop is running and the jumper/qemu-esp image exists (`jumper setup esp32`); QEMU's own output is in logFile.");
      const lines = link.next(timeout);
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
    this.i2s.send({ cycle: this._cycles, sampleRate: ev.rate, bits: ev.bits, channels: ev.channels, samples });
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
    const mode: PinMode = "input";
    return { mode, value: this.inputs & bit ? 1 : 0 };
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

export function createQemuEspBackend(opts: QemuEspBackendOptions): QemuEspBackend {
  return new QemuEspBackend(opts);
}
