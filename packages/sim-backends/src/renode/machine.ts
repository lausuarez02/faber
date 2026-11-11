// One Renode process (in the jumper/renode Docker image) running one board with one firmware ELF.
//
//   monitor (telnet, --port)   setup: platform, ELF, servers, peripheral properties
//   ExternalControl (binary)   run_for, virtual time, GPIO in/out with timestamps, SPI device, ADC
//   UART socket terminal       console bytes
//
// Time: Renode starts paused and only moves inside runFor(), so Jumper owns the clock. Within a
// runFor, GPIO edges and SPI bytes are synchronous round trips carrying exact virtual time. UART
// bytes come on their own socket and are attributed to the runFor window they arrived in (see
// drainSerial); a deterministic per-byte timestamp needs a UART command on the ExternalControl
// channel (not in Renode 1.17).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { renodeBoardOf, type RenodeBoard } from "./boards.ts";
import { Command, ExternalControlClient, type GpioEvent } from "./external-control.ts";
import { RenodeMonitor } from "./monitor.ts";

const exec = promisify(execFile);

export const RENODE_IMAGE = "jumper/renode:1.17.0-r1";
const PLATFORMS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "platforms");
/** The user's Jumper server. Never bind it. */
const RESERVED_PORTS = new Set([7780]);

export interface RenodeMachineOptions {
  board: string;
  /** Absolute path of the firmware ELF on the host. */
  elf: string;
  image?: string;
  /** Extra platform lines appended after the board's platform (e.g. a sensor on an I2C bus). */
  extraRepl?: string;
  /** C# files (host paths) to compile into Renode before loading the platform, e.g. custom peripherals. */
  csharp?: string[];
  /** Let virtual time skip ahead while the CPU sleeps (WFI). Default true. */
  advanceImmediately?: boolean;
}

export interface PinEdge {
  pinId: string;
  value: 0 | 1;
  timeNs: bigint;
}

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((res, rej) => {
      const s = createServer();
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

/** Remove Renode containers a crashed Jumper process left behind (`docker ps --filter label=jumper.renode`). */
export async function reapRenodeContainers(): Promise<number> {
  const { stdout } = await exec("docker", ["ps", "-aq", "--filter", "label=jumper.renode=1"]);
  const ids = stdout.split("\n").filter(Boolean);
  if (ids.length) await exec("docker", ["rm", "-f", ...ids]);
  return ids.length;
}

/** True when `docker info` answers (the integration tests skip otherwise). */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export class RenodeMachine {
  readonly board: RenodeBoard;
  readonly monitor: RenodeMonitor;
  readonly control: ExternalControlClient;
  readonly container: string;
  /** Wall-clock ms spent from `docker run` to a loaded, paused machine. */
  readonly startupMs: number;
  private readonly machineId: number;
  private readonly uart: Socket;
  private readonly proc: ChildProcess;
  private readonly runDir: string;
  private serialListeners: ((byte: number) => void)[] = [];
  private gpioIds = new Map<string, number>();
  private lastSerialAt = 0;

  private constructor(init: {
    board: RenodeBoard;
    monitor: RenodeMonitor;
    control: ExternalControlClient;
    container: string;
    machineId: number;
    uart: Socket;
    proc: ChildProcess;
    runDir: string;
    startupMs: number;
  }) {
    this.runDir = init.runDir;
    this.board = init.board;
    this.monitor = init.monitor;
    this.control = init.control;
    this.container = init.container;
    this.machineId = init.machineId;
    this.uart = init.uart;
    this.proc = init.proc;
    this.startupMs = init.startupMs;
    this.uart.on("data", (d) => {
      this.lastSerialAt = Date.now();
      for (const b of d) for (const l of this.serialListeners) l(b);
    });
  }

  static async start(opts: RenodeMachineOptions): Promise<RenodeMachine> {
    const t0 = Date.now();
    const board = renodeBoardOf(opts.board);
    if (!board) throw new Error(`no Renode board '${opts.board}'. Fix: use one of the boards in packages/sim-backends/src/renode/boards.ts or add it there.`);
    const [monPort, ctlPort, uartPort] = [await freePort(), await freePort(), await freePort()];
    const container = `jumper-renode-${randomBytes(4).toString("hex")}`;
    const elfDir = dirname(resolve(opts.elf));
    const args = [
      "run", "--rm", "--name", container, "--label", "jumper.renode=1",
      "-p", `127.0.0.1:${monPort}:${monPort}`,
      "-p", `127.0.0.1:${ctlPort}:${ctlPort}`,
      "-p", `127.0.0.1:${uartPort}:${uartPort}`,
      "-v", `${PLATFORMS_DIR}:/jumper/platforms:ro`,
      "-v", `${elfDir}:/jumper/fw:ro`,
    ];
    const runDir = mkdtempSync(join(tmpdir(), "jumper-renode-"));
    if (opts.extraRepl) {
      writeFileSync(join(runDir, "extra.repl"), opts.extraRepl);
      args.push("-v", `${runDir}:/jumper/run:ro`);
    }
    const csharp = (opts.csharp ?? []).map((p, i) => {
      args.push("-v", `${resolve(p)}:/jumper/cs/${i}-${basename(p)}:ro`);
      return `/jumper/cs/${i}-${basename(p)}`;
    });
    args.push(opts.image ?? RENODE_IMAGE, "--disable-gui", "--hide-log", "--port", String(monPort));
    const proc = spawn("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d));

    let monitor: RenodeMonitor | undefined;
    try {
      monitor = await RenodeMonitor.connect(monPort);
      for (const cs of csharp) await monitor.exec(`include @${cs}`);
      await monitor.exec(`mach create "jumper"`);
      await monitor.exec(`machine LoadPlatformDescription @${board.platform}`);
      if (opts.extraRepl) await monitor.exec(`machine LoadPlatformDescription @/jumper/run/extra.repl`);
      await monitor.exec(`sysbus LoadELF @/jumper/fw/${basename(opts.elf)}`);
      await monitor.exec(`emulation SetGlobalAdvanceImmediately ${opts.advanceImmediately ?? true}`);
      for (const id of board.pullUps ?? []) {
        const p = board.pins[id];
        if (p) await monitor.exec(`sysbus.${p.gpio} OnGPIO ${p.pin} true`);
      }
      await monitor.exec(`emulation CreateServerSocketTerminal ${uartPort} "jumperUart" false`);
      await monitor.exec(`connector Connect sysbus.${board.uart} jumperUart`);
      await monitor.exec(`emulation CreateExternalControlServer "jumperCtl" ${ctlPort}`);
      const uart = await new Promise<Socket>((res, rej) => {
        const s = new Socket();
        s.once("error", rej);
        s.connect(uartPort, "127.0.0.1", () => res(s));
      });
      const control = await ExternalControlClient.connect(ctlPort);
      const machineId = await control.getMachine("jumper");
      return new RenodeMachine({ board, monitor, control, container, machineId, uart, proc, runDir, startupMs: Date.now() - t0 });
    } catch (e) {
      monitor?.close();
      await exec("docker", ["rm", "-f", container]).catch(() => undefined);
      rmSync(runDir, { recursive: true, force: true });
      throw new Error(`Renode failed to start board '${opts.board}' with ${opts.elf}: ${(e as Error).message}${stderr ? `\ndocker: ${stderr.trim()}` : ""}`);
    }
  }

  onSerial(cb: (byte: number) => void): () => void {
    this.serialListeners.push(cb);
    return () => (this.serialListeners = this.serialListeners.filter((l) => l !== cb));
  }

  /** Advance virtual time by `ns`. GPIO / SPI callbacks fire inside, at their exact virtual time. */
  async runFor(ns: bigint): Promise<void> {
    await this.control.runFor(ns);
  }

  async timeNs(): Promise<bigint> {
    return this.control.getTime();
  }

  /** Wait until the UART socket has been quiet for `quietMs` (bytes of the last runFor have arrived). */
  async drainSerial(quietMs = 15): Promise<void> {
    for (;;) {
      const idle = Date.now() - this.lastSerialAt;
      if (idle >= quietMs) return;
      await new Promise((r) => setTimeout(r, quietMs - idle));
    }
  }

  private async gpio(pinId: string): Promise<{ id: number; pin: number }> {
    const p = this.board.pins[pinId];
    if (!p) throw new Error(`board '${this.board.type}' has no pin '${pinId}' (known: ${Object.keys(this.board.pins).join(", ")})`);
    let id = this.gpioIds.get(p.gpio);
    if (id === undefined) {
      id = await this.control.getInstance(Command.Gpio, this.machineId, p.gpio);
      this.gpioIds.set(p.gpio, id);
    }
    return { id, pin: p.pin };
  }

  /** Drive a pin from outside (a button, a pull-up, another chip's output). */
  async setPin(pinId: string, level: 0 | 1): Promise<void> {
    const g = await this.gpio(pinId);
    await this.control.gpioSet(g.id, g.pin, level === 1);
  }

  /** Level of the pin's output connection (what the MCU drives). */
  async readPin(pinId: string): Promise<0 | 1> {
    const g = await this.gpio(pinId);
    return (await this.control.gpioGet(g.id, g.pin)) ? 1 : 0;
  }

  /** Get every edge the firmware drives on `pinId`, with its virtual time. */
  async watchPin(pinId: string, cb: (e: PinEdge) => void): Promise<void> {
    const g = await this.gpio(pinId);
    await this.control.gpioOnChange(g.id, g.pin, (e: GpioEvent) => cb({ pinId, value: e.state ? 1 : 0, timeNs: e.timeNs }));
  }

  /** Be the device behind an `SPI.ExternalControlSPIPeripheral` the platform put on a controller (path under sysbus). */
  async attachSpiDevice(path: string, onByte: (mosi: number) => number, onFinish?: () => void): Promise<void> {
    const id = await this.control.getInstance(Command.Spi, this.machineId, path);
    await this.control.spiAttach(id, onByte, onFinish);
  }

  async stop(): Promise<void> {
    this.control.close();
    this.monitor.close();
    this.uart.destroy();
    await exec("docker", ["rm", "-f", this.container]).catch(() => undefined);
    this.proc.kill();
    rmSync(this.runDir, { recursive: true, force: true });
  }
}
