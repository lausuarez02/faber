// Renode as a synchronous McuBackend (round 10), so sim-core's Simulation drives STM32 and nRF52
// boards exactly like avr8js and rp2040js.
//
// Renode runs in its own process (Docker image fabwright/renode). A C# bridge compiled into it
// (platforms/FabwrightBridge.cs) dials back to a SyncBridgeLink and carries every signal as a
// time-stamped line, in emulation order, on one socket:
//   GPIO     every board pin's output edges (G) with virtual ns; inputs (I) applied between steps
//   UART     Serial's TX bytes (U), each with its own virtual ns; RX bytes (X)
//   I2C      one FabwrightI2cTarget per address the project's I2C parts answer on: writes (IW) go one
//            way, reads (IR) block the CPU until the part models answer (D)
//   SPI      a FabwrightSpiTarget on the controller SPI uses: each byte (SX) waits for the MISO byte the
//            part models return (M), or flows one way (SW) when every SPI part is write-only
//   ADC      the voltage on an analog pin (A), read by the board's ADC model at conversion time
// Time: Renode only moves inside R (RunFor), and step() blocks until it parks again (T), so
// Fabwright owns the clock and runs are deterministic.
//
// Renode starts lazily on the first step(): by then the Simulation has attached the parts, so the
// bridge knows which I2C addresses to answer and whether SPI needs MISO.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { I2cBus, McuBackend, McuBusPins, McuCapability, PinState, SpiBus, Unsubscribe } from "@fabwright/sim-core";
import { BridgeTimeoutError, SyncBridgeLink } from "../qemu-esp/sync-link.ts";
import { renodeBoardOf, renodeBusPins, type RenodeBoard } from "./boards.ts";
import { launchRenode, PLATFORMS_DIR, renodeRuntime, renodeUnavailable, type RenodeProcess } from "./launcher.ts";

export interface RenodeBackendOptions {
  /** Board type (a key of RENODE_BOARDS, the board part's type). */
  board: string;
  image?: string;
  runtime?: "docker" | "native";
  /** Max wall time to wait for Renode in one call (the first one includes the container start). Default 60 s. */
  timeoutMs?: number;
  /** Renode's own log (a file path). */
  logFile?: string;
  /** Renode log level (0 noisy … 3 errors only). Default 3: per-access warnings slow Renode down a lot. */
  logLevel?: number;
  /** Extra platform lines for this run (e.g. a Renode sensor model on a bus). */
  extraRepl?: string;
  /** Extra Docker labels (the local runner tags containers with its session). */
  labels?: Record<string, string>;
  /** Tests: start something else that dials the bridge port instead of Renode (no Docker check). */
  launch?: (o: { runDir: string; port: number }) => RenodeProcess;
}

type PinListener = (pinId: string, state: PinState, cycle: number) => void;
type SerialListener = (byte: number, cycle: number) => void;

/** What the backend bridges, for fidelity reports and design checks. */
export const RENODE_CAPABILITIES: readonly McuCapability[] = ["gpio", "irq", "uart", "i2c", "spi", "adc", "pwm"];

const BLOCKING = ["T ", "IR ", "IC ", "SX ", "H ", "E "];
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];

export class RenodeBackend implements McuBackend {
  /** Renode runs in another process (Docker or a native Renode): only the Fabwright server starts it. */
  readonly kind = "process" as const;
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];
  readonly busPins: McuBusPins;
  readonly board: RenodeBoard;
  readonly capabilities = RENODE_CAPABILITIES;
  /** Wall ms from launch to the bridge's hello (last start), for reports. */
  startupMs = -1;
  private _cycles = 0;
  private ns = 0n;
  private firmware: { kind: "elf" | "ihex"; data: Uint8Array } | undefined;
  /** Pins a PWM model drives (nRF52 PWM): period / high time in ns and the next edge to draw. */
  private pwm = new Map<string, { period: bigint; high: bigint; start: bigint; next: bigint; level: 0 | 1 }>();
  private readonly pwmPins: Record<string, string>;
  private link: SyncBridgeLink | undefined;
  private proc: RenodeProcess | undefined;
  private runDir: string | undefined;
  private outputs = new Map<string, 0 | 1>();
  private driven = new Set<string>();
  private inputs = new Map<string, 0 | 1>();
  private analog = new Map<string, number>();
  private pinListeners = new Set<PinListener>();
  private serialListeners = new Set<SerialListener>();
  private i2c: I2cBus | undefined;
  private spi: SpiBus | undefined;
  /** I2C transaction the bridge has open: address and direction. */
  private i2cOpen: { addr: number; read: boolean; ack: boolean } | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RenodeBackendOptions) {
    const board = renodeBoardOf(opts.board);
    if (!board) throw new Error(`no Renode board '${opts.board}'. Fix: use one of the boards in packages/sim-backends/src/renode/boards.ts, or add it there.`);
    this.board = board;
    this.cyclesPerSecond = board.clockHz;
    this.vcc = board.vcc;
    this.pinIds = Object.keys(board.pins);
    this.busPins = renodeBusPins(board);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.pwmPins = { ...board.pwmPins };
    if (!board.pwmPins) for (const [id, p] of Object.entries(board.pins)) if (/^gpio\d$/.test(p.gpio)) this.pwmPins[`${p.gpio.slice(4)}.${p.pin}`] ??= id;
  }

  get cycles(): number {
    return this._cycles;
  }

  /** Virtual ns since the last reset. */
  get virtualNs(): bigint {
    return this.ns;
  }

  get running(): boolean {
    return this.link !== undefined;
  }

  /** Intel HEX text (what Fabwright's build keeps for every board) or an ELF file's bytes. */
  load(firmware: Uint8Array | string): void {
    const bytes = typeof firmware === "string" ? undefined : firmware;
    if (bytes && ELF_MAGIC.every((b, i) => bytes[i] === b)) {
      this.firmware = { kind: "elf", data: bytes };
    } else {
      const text = typeof firmware === "string" ? firmware : new TextDecoder("latin1").decode(firmware);
      if (!text.trimStart().startsWith(":")) {
        throw new Error(
          `The ${this.board.chip} board '${this.board.type}' runs its firmware in Renode, which loads Intel HEX or an ELF file, but it got ${typeof firmware === "string" ? "text" : "bytes"} that is neither. Fix: build the sketch with the board's FQBN (${this.board.fqbn}).`,
        );
      }
      this.firmware = { kind: "ihex", data: new TextEncoder().encode(text) };
    }
    this.close();
    this._cycles = 0;
    this.ns = 0n;
    this.outputs.clear();
    this.driven.clear();
    this.pwm.clear();
  }

  step(cycles: number): void {
    if (cycles <= 0) return;
    this.ensureStarted();
    const target = BigInt(Math.round(((this._cycles + cycles) * 1e9) / this.cyclesPerSecond));
    const delta = target - this.ns;
    if (delta <= 0n) return;
    this.send(`R ${delta}`);
    this.pump();
  }

  readPin(pinId: string): PinState {
    const p = this.pwm.get(pinId);
    if (p) return { mode: "output", value: p.level };
    if (this.driven.has(pinId)) return { mode: "output", value: this.outputs.get(pinId) ?? 0 };
    return { mode: "input", value: this.inputs.get(pinId) ?? 0 };
  }

  setPinInput(pinId: string, volts: number): void {
    const p = this.board.pins[pinId];
    if (!p) throw new Error(`board '${this.board.type}' has no pin '${pinId}' (known: ${this.pinIds.join(", ")})`);
    const adc = this.board.adc?.[pinId];
    if (adc) {
      const mv = Math.round(Math.max(0, volts) * 1000);
      if (this.analog.get(pinId) !== mv) {
        this.analog.set(pinId, mv);
        if (this.link) this.send(`A ${adc.adc} ${adc.channel} ${mv}`);
      }
    }
    // CMOS thresholds (STM32 / nRF52: VIL 0.3 VDD, VIH 0.7 VDD), hysteresis in between.
    const was = this.inputs.get(pinId);
    let level: 0 | 1 = was ?? 0;
    if (volts <= 0.3 * this.vcc) level = 0;
    else if (volts >= 0.7 * this.vcc) level = 1;
    if (level === was) return;
    this.inputs.set(pinId, level);
    if (this.link) this.send(`I ${p.gpio} ${p.pin} ${level}`);
  }

  onPinChange(cb: PinListener): Unsubscribe {
    this.pinListeners.add(cb);
    return () => this.pinListeners.delete(cb);
  }

  onSerial(cb: SerialListener): Unsubscribe {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  writeSerial(byte: number): void {
    this.ensureStarted();
    this.send(`X ${this.board.console} ${(byte & 0xff).toString(16).padStart(2, "0")}`);
  }

  attachI2c(bus: I2cBus): void {
    this.i2c = bus;
  }

  attachSpi(bus: SpiBus): void {
    this.spi = bus;
  }

  reset(): void {
    this._cycles = 0;
    this.ns = 0n;
    this.outputs.clear();
    this.driven.clear();
    this.pwm.clear();
    this.i2cOpen = undefined;
    // A new process: the parts on the buses may have changed, and a fresh machine is the exact power-on state.
    this.close();
  }

  /** Stop Renode (the backend can step again: it restarts with the same firmware). */
  close(): void {
    if (this.link) {
      try {
        this.send("Q");
      } catch {
        // already gone
      }
    }
    this.proc?.stop();
    this.link?.close();
    this.proc = undefined;
    this.link = undefined;
    if (this.runDir) rmSync(this.runDir, { recursive: true, force: true });
    this.runDir = undefined;
  }

  dispose(): void {
    this.close();
  }

  // ------------------------------------------------------------------------------ internals

  private send(line: string): void {
    this.link!.send(line + "\n");
  }

  private ensureStarted(): void {
    if (this.link) return;
    const fw = this.firmware;
    if (!fw) throw new Error(`no firmware loaded on '${this.board.type}'. Fix: build the sketch first (Fabwright's build writes what the Renode backend loads).`);
    const runtime = this.opts.runtime ?? renodeRuntime();
    const why = this.opts.launch ? undefined : renodeUnavailable(this.opts.image, runtime);
    if (why) throw new Error(why);
    const t0 = Date.now();
    const runDir = mkdtempSync(join(tmpdir(), "fabwright-renode-"));
    this.runDir = runDir;
    const fwFile = fw.kind === "elf" ? "firmware.elf" : "firmware.hex";
    writeFileSync(join(runDir, fwFile), fw.data);
    writeFileSync(join(runDir, "models.cs"), bundleCSharp(["FabwrightBridge.cs", ...(this.board.csharp ?? [])]));
    writeFileSync(join(runDir, "extra.repl"), this.extraRepl());
    const link = new SyncBridgeLink({ blocking: BLOCKING });
    this.link = link;
    const docker = runtime === "docker";
    const host = docker ? "host.docker.internal" : "127.0.0.1";
    // Docker mounts ./platforms at /fabwright/platforms; a native Renode gets a copy with those paths rewritten.
    let root = "/fabwright";
    if (!docker) {
      root = runDir;
      cpSync(PLATFORMS_DIR, join(runDir, "platforms"), { recursive: true });
      for (const f of readdirSync(join(runDir, "platforms"))) {
        if (!/\.(repl|py)$/.test(f)) continue;
        const file = join(runDir, "platforms", f);
        writeFileSync(file, readFileSync(file, "utf8").replaceAll("/fabwright/platforms", join(runDir, "platforms")));
      }
    }
    const platform = this.board.platform.startsWith("/fabwright/") ? this.board.platform.replace("/fabwright", root) : this.board.platform;
    const run = docker ? "/fabwright/run" : runDir;
    writeFileSync(
      join(runDir, "start.resc"),
      [
        `include @${run}/models.cs`,
        `mach create "fabwright"`,
        `machine LoadPlatformDescription @${platform}`,
        `machine LoadPlatformDescription @${run}/extra.repl`,
        ...(this.board.erasedFlash ?? []).map((r) => `sysbus.fabwright Fill ${r.start} ${r.size} 255`),
        fw.kind === "elf" ? `sysbus LoadELF @${run}/${fwFile}` : `sysbus LoadHEX @${run}/${fwFile}`,
        // An Intel HEX has no symbols to find the vector table from: the board says where it is.
        ...(this.board.bootFrom !== undefined ? [`sysbus.fabwright BootVector ${this.board.bootFrom}`] : []),
        ...(fw.kind === "ihex" || this.board.erasedFlash || this.board.bootFrom !== undefined ? [`sysbus.cpu VectorTableOffset 0x${this.board.vectorTableOffset.toString(16)}`] : []),
        // One instruction per core clock cycle, so DWT->CYCCNT and busy loops match the chip's clock.
        `sysbus.cpu PerformanceInMips ${Math.round(this.board.clockHz / 1e6)}`,
        ...(this.board.cpuSettings ?? []).map((c) => `sysbus.cpu ${c}`),
        ...(this.board.wakeWfeOnInterrupts ? ["sysbus.fabwright WakeWfeOnInterrupts"] : []),
        `emulation SetGlobalAdvanceImmediately true`,
        `logLevel ${this.opts.logLevel ?? 3}`,
        `sysbus.fabwright SpiNeedsMiso ${this.spi?.needsMiso() ?? true}`,
        `sysbus.fabwright Connect "${host}" ${link.port}`,
        "",
      ].join("\n"),
    );
    const logFile = this.opts.logFile ?? join(runDir, "renode.log");
    const logStart = existsSync(logFile) ? statSync(logFile).size : 0;
    this.proc = this.opts.launch ? this.opts.launch({ runDir, port: link.port }) : launchRenode({ runDir, image: this.opts.image, runtime, logFile, ...(this.opts.labels ? { labels: this.opts.labels } : {}) });
    try {
      this.waitHello(logFile, logStart);
    } catch (e) {
      const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(logStart) : "";
      const errLines = log.split("\n").filter((l) => /error|exception|could not|failed|does not provide/i.test(l)).slice(-6).join(" | ");
      this.close();
      throw new Error(
        `Renode did not start board '${this.board.type}': ${(e as Error).message}${errLines ? `. Renode said: ${errLines}` : ""}. ` +
          `Fix: if Docker is fine, this is a bug in Fabwright's ${this.board.type} platform or models: report it with the Renode log (run with RenodeBackendOptions.logFile to keep it).`,
      );
    }
    this.startupMs = Date.now() - t0;
    for (const [id, p] of Object.entries(this.board.pins)) this.send(`W ${p.gpio} ${p.pin} ${id}`);
    this.send(`S ${this.board.console} console`);
    for (const [id, level] of this.inputs) {
      const p = this.board.pins[id]!;
      // A HIGH input goes LOW then HIGH before the firmware runs, so every model on the way (the port,
      // STM32's AFIO / EXTI) has seen it HIGH: otherwise the first falling edge is lost.
      if (level === 1) this.send(`I ${p.gpio} ${p.pin} 0`);
      this.send(`I ${p.gpio} ${p.pin} ${level}`);
    }
    for (const [id, mv] of this.analog) {
      const a = this.board.adc?.[id];
      if (a) this.send(`A ${a.adc} ${a.channel} ${mv}`);
    }
  }

  /** Per-run platform additions: the I2C targets the project's parts answer on, the SPI target. */
  private extraRepl(): string {
    const b = this.board;
    // Every board: the bridge and a DWT cycle counter (STM32duino and Mbed busy-wait on DWT->CYCCNT).
    const lines: string[] = ["fabwright: Miscellaneous.FabwrightBridge @ sysbus 0x5FFF0000", "", "dwt: Miscellaneous.FabwrightDwt @ sysbus 0xE0001000", ""];
    if (b.i2c && this.i2c && (b.i2c.bridge ?? "targets") === "targets") {
      const addrs = [...new Set(this.i2c.list().map((d) => d.address))].sort((x, y) => x - y);
      for (const a of addrs) {
        lines.push(`fabwrightI2c${a.toString(16)}: Miscellaneous.FabwrightI2cTarget @ ${b.i2c.controller} 0x${a.toString(16)}`, `    address: ${a}`, "");
      }
    }
    if (b.spi && this.spi && this.spi.list().length > 0 && (b.spi.bridge ?? "targets") === "targets") {
      lines.push(`fabwrightSpi: Miscellaneous.FabwrightSpiTarget @ ${b.spi.controller}`, `    bus: "${b.spi.controller}"`, `    sync: ${this.spi.needsMiso() ? "true" : "false"}`, "");
    }
    if (this.opts.extraRepl) lines.push(this.opts.extraRepl);
    return lines.join("\n") + "\n";
  }

  /** Wait for the bridge's hello, failing fast when Renode reports an error in its log (a script line, the C# models). */
  private waitHello(logFile: string, logStart: number): void {
    const link = this.link!;
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (link.closed) throw new Error("Renode exited before the bridge connected");
      try {
        for (const line of link.next(500)) if (line.startsWith("H ")) return;
      } catch (e) {
        if (!(e instanceof BridgeTimeoutError)) throw e;
      }
      const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(logStart) : "";
      if (/There was an error executing command|Errors during compilation|Could not compile/.test(log)) throw new Error("its start script failed");
      if (this.proc?.child.exitCode !== null && this.proc?.child.exitCode !== undefined) throw new Error(`Renode exited with code ${this.proc.child.exitCode} before the bridge connected`);
      if (Date.now() > deadline) throw new Error(`the bridge did not connect within ${this.timeoutMs} ms`);
    }
  }

  /** Handle bridge lines until Renode parks (T), or until a line starting with `until` arrives. */
  private pump(until = "T"): void {
    const link = this.link!;
    for (;;) {
      if (link.closed) throw new Error(`Renode exited while running ${this.board.type}. Why: Docker stopped, ran out of memory, or Renode hit an error (see ${this.opts.logFile ?? "its log"}). Fix: check Docker Desktop is running, then run again`);
      let lines: string[];
      try {
        lines = link.next(this.timeoutMs);
      } catch (e) {
        if (e instanceof BridgeTimeoutError) throw new Error(`Renode did not answer within ${this.timeoutMs} ms. Why: the emulator is stuck or Docker is overloaded. Fix: stop other simulations and run again; if it repeats, report the board and sketch`);
        throw e;
      }
      for (const line of lines) {
        if (!line) continue;
        const sp = line.indexOf(" ");
        const op = sp < 0 ? line : line.slice(0, sp);
        const f = line.split(" ");
        switch (op) {
          case "H":
            if (until === "H") return;
            break;
          case "T":
            this.advance(BigInt(f[1]!));
            this.drawPwm(this.ns);
            if (until === "T") return;
            break;
          case "G": {
            this.advance(BigInt(f[4]!));
            const id = f[1]!;
            const v: 0 | 1 = f[2] === "1" ? 1 : 0;
            if (this.pwm.has(id)) break; // a PWM peripheral owns the pin
            if (f[3] !== "o") {
              // An input: its level is what Fabwright drives (the port echoes it); only a direction change matters.
              if (this.driven.delete(id)) {
                const st: PinState = { mode: "input", value: this.inputs.get(id) ?? 0 };
                for (const cb of this.pinListeners) cb(id, st, this._cycles);
              }
              break;
            }
            if (this.driven.has(id) && this.outputs.get(id) === v) break;
            this.driven.add(id);
            this.outputs.set(id, v);
            const st: PinState = { mode: "output", value: v };
            for (const cb of this.pinListeners) cb(id, st, this._cycles);
            break;
          }
          case "U": {
            this.advance(BigInt(f[2]!));
            if (f[1] !== "console") break;
            const hex = f[3] ?? "";
            for (let i = 0; i + 1 < hex.length; i += 2) {
              const byte = parseInt(hex.slice(i, i + 2), 16);
              for (const cb of this.serialListeners) cb(byte, this._cycles);
            }
            break;
          }
          case "IW": {
            this.advance(BigInt(f[2]!));
            const addr = parseInt(f[1]!, 16);
            this.i2cBegin(addr, false);
            const hex = f[3] ?? "";
            for (let i = 0; i + 1 < hex.length; i += 2) this.i2c?.write(parseInt(hex.slice(i, i + 2), 16));
            break;
          }
          case "IC": {
            // Fabwright's own controller model asks whether a device ACKs the address.
            this.advance(BigInt(f[3]!));
            const ack = this.i2cBegin(parseInt(f[1]!, 16), f[2] === "r", true);
            this.send(`K ${ack ? 1 : 0}`);
            break;
          }
          case "IR": {
            this.advance(BigInt(f[3]!));
            const addr = parseInt(f[1]!, 16);
            const n = Number(f[2]);
            this.i2cBegin(addr, true);
            let out = "";
            for (let i = 0; i < n; i++) out += (this.i2c ? this.i2c.read(true) : 0xff).toString(16).padStart(2, "0");
            this.send(`D ${out}`);
            break;
          }
          case "IP":
            this.advance(BigInt(f[2]!));
            if (this.i2cOpen) this.i2c?.stop();
            this.i2cOpen = undefined;
            break;
          case "SX": {
            this.advance(BigInt(f[3]!));
            const miso = this.spi ? this.spi.transfer(parseInt(f[2]!, 16)) : 0xff;
            this.send(`M ${miso.toString(16).padStart(2, "0")}`);
            break;
          }
          case "SW":
            this.advance(BigInt(f[3]!));
            this.spi?.transfer(parseInt(f[2]!, 16));
            break;
          case "SE":
            break;
          case "P": {
            this.advance(BigInt(f[4]!));
            const id = this.pwmPins[f[1]!.replace(/\.0*(\d)/, ".$1")];
            if (id) this.setPwm(id, BigInt(f[2]!), BigInt(f[3]!));
            break;
          }
          case "E":
            throw new Error(`Renode bridge error: ${line.slice(2)}`);
          default:
            break;
        }
      }
    }
  }

  /** START (or repeated START) + address, unless that transfer is already open. Returns the address ACK. */
  private i2cBegin(addr: number, read: boolean, fresh = false): boolean {
    const open = this.i2cOpen;
    if (!fresh && open && open.addr === addr && open.read === read) return open.ack;
    const bus = this.i2c;
    const ack = bus ? (bus.start(open !== undefined), bus.connect(addr, read)) : false;
    this.i2cOpen = { addr, read, ack };
    return ack;
  }

  /** A PWM model reports a pin's period and high time (0 / 0: stopped, the pin falls back to its GPIO level). */
  private setPwm(id: string, period: bigint, high: bigint): void {
    this.drawPwm(this.ns);
    if (period <= 0n) {
      this.pwm.delete(id);
      this.emitLevel(id, this.outputs.get(id) ?? 0, this._cycles);
      return;
    }
    if (high <= 0n || high >= period) {
      // 0 % or 100 %: a steady level, no edges.
      this.pwm.set(id, { period, high, start: this.ns, next: -1n, level: high > 0n ? 1 : 0 });
      this.emitLevel(id, high > 0n ? 1 : 0, this._cycles);
      return;
    }
    this.pwm.set(id, { period, high, start: this.ns, next: this.ns, level: 0 });
  }

  /** Draw every PWM edge up to `until` ns with its exact cycle. */
  private drawPwm(until: bigint): void {
    for (const [id, p] of this.pwm) {
      if (p.next < 0n) continue;
      while (p.next <= until) {
        const t = p.next;
        const inPeriod = (t - p.start) % p.period;
        const level: 0 | 1 = inPeriod < p.high ? 1 : 0;
        this.emitLevel(id, level, Math.round((Number(t) * this.cyclesPerSecond) / 1e9));
        p.level = level;
        p.next = level === 1 ? t + p.high : t + (p.period - p.high);
      }
    }
  }

  private emitLevel(id: string, v: 0 | 1, cycle: number): void {
    this.driven.add(id);
    const st: PinState = { mode: "output", value: v };
    for (const cb of this.pinListeners) cb(id, st, cycle);
  }

  /** Renode's virtual ns (each start of the process begins at 0, like our cycle 0). */
  private advance(ns: bigint): void {
    if (ns > this.ns) {
      this.ns = ns;
      this._cycles = Math.round((Number(ns) * this.cyclesPerSecond) / 1e9);
    }
  }
}

/** Concatenate C# files into one compilation unit (Renode compiles one file per include): usings first. */
export function bundleCSharp(files: readonly string[]): string {
  const usings = new Set<string>();
  const bodies: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(PLATFORMS_DIR, f), "utf8");
    const body: string[] = [];
    for (const line of src.split("\n")) {
      if (/^using [\w.]+;\s*$/.test(line)) usings.add(line.trim());
      else body.push(line);
    }
    bodies.push(`// ---- ${f}\n${body.join("\n")}`);
  }
  return [...usings].sort().join("\n") + "\n\n" + bodies.join("\n");
}

export function createRenodeBackend(opts: RenodeBackendOptions): RenodeBackend {
  return new RenodeBackend(opts);
}
