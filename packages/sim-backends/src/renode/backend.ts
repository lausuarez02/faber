// Renode as a synchronous McuBackend, so sim-core's Simulation can drive it unchanged.
//
// Renode lives in another process and every call is a socket round trip, but McuBackend.step() is
// synchronous. A worker thread owns the async RenodeMachine; step() posts "runFor", blocks on a
// SharedArrayBuffer (Atomics.wait) until the worker has paused Renode again, then pulls the pin
// edges and serial bytes of that window with receiveMessageOnPort and replays them to the
// listeners with their exact cycles (edges) or the end-of-step cycle (serial).
//
// Limits of this prototype (see docs/decisions round 9 renode notes):
//   - load() cannot swap firmware in place: the ELF is fixed at creation (restart to change it).
//   - Pin modes are not reported by Renode's ExternalControl; a pin that the firmware drove is
//     reported as "output", others as "input".
//   - stopAt() is not implemented: a part's reaction lands at the next step boundary (chunkMs).
//   - No attachI2c/attachSpi yet: buses go through Renode-side peripherals (C# / ExternalControl SPI).
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { McuBackend, PinState, Unsubscribe } from "@jumper/sim-core";
import { renodeBoardOf, type RenodeBoard } from "./boards.ts";
import type { RenodeMachineOptions } from "./machine.ts";
import type { WorkerCommand, WorkerEvent } from "./worker.ts";

export interface RenodeBackendOptions extends RenodeMachineOptions {
  /** Pins whose output edges are reported. Default: every pin of the board. */
  watch?: string[];
  /** Max wall time to wait for one command (startup included). Default 60 s. */
  timeoutMs?: number;
}

type PinListener = (pinId: string, state: PinState, cycle: number) => void;
type SerialListener = (byte: number, cycle: number) => void;

class RenodeBackend implements McuBackend {
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];
  readonly board: RenodeBoard;
  readonly startupMs: number;
  private _cycles = 0;
  private readonly worker: Worker;
  private readonly port: MessageChannel["port1"];
  private readonly flag: Int32Array;
  private readonly timeoutMs: number;
  private pins = new Map<string, PinState>();
  private pinListeners: PinListener[] = [];
  private serialListeners: SerialListener[] = [];

  constructor(opts: RenodeBackendOptions) {
    const board = renodeBoardOf(opts.board);
    if (!board) throw new Error(`no Renode board '${opts.board}'`);
    this.board = board;
    this.cyclesPerSecond = board.clockHz;
    this.vcc = board.vcc;
    this.pinIds = Object.keys(board.pins);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    const signal = new SharedArrayBuffer(4);
    this.flag = new Int32Array(signal);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const { watch, timeoutMs: _t, ...machine } = opts;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { opts: machine, watch: watch ?? this.pinIds, port: port2, signal },
      transferList: [port2],
    });
    this.worker.unref();
    const ready = this.wait().find((e) => e.kind === "ready");
    this.startupMs = ready && ready.kind === "ready" ? ready.startupMs : -1;
  }

  get cycles(): number {
    return this._cycles;
  }

  load(): void {
    throw new Error("the Renode backend loads its ELF when it is created (RenodeBackendOptions.elf); create a new backend to change firmware");
  }

  step(cycles: number): void {
    const ns = BigInt(Math.round((cycles * 1e9) / this.cyclesPerSecond));
    const events = this.call({ op: "runFor", ns: ns.toString() });
    const end = this._cycles + cycles;
    for (const e of events) {
      if (e.kind === "edge") {
        const cycle = Math.round((Number(e.timeNs) * this.cyclesPerSecond) / 1e9);
        const state: PinState = { mode: "output", value: e.value };
        this.pins.set(e.pinId, state);
        for (const l of this.pinListeners) l(e.pinId, state, cycle);
      } else if (e.kind === "serial") {
        for (const b of e.bytes) for (const l of this.serialListeners) l(b, end);
      } else if (e.kind === "done" && e.timeNs) {
        this._cycles = Math.round((Number(e.timeNs) * this.cyclesPerSecond) / 1e9);
      }
    }
  }

  readPin(pinId: string): PinState {
    return this.pins.get(pinId) ?? { mode: "input", value: 0 };
  }

  setPinInput(pinId: string, volts: number): void {
    const level: 0 | 1 = volts >= this.vcc / 2 ? 1 : 0;
    const cur = this.pins.get(pinId);
    if (cur?.mode === "output") return; // the MCU drives it; Renode would let the input win otherwise
    if (cur && cur.value === level) return;
    this.call({ op: "setPin", pinId, level });
    this.pins.set(pinId, { mode: "input", value: level });
  }

  onPinChange(cb: PinListener): Unsubscribe {
    this.pinListeners.push(cb);
    return () => (this.pinListeners = this.pinListeners.filter((l) => l !== cb));
  }

  onSerial(cb: SerialListener): Unsubscribe {
    this.serialListeners.push(cb);
    return () => (this.serialListeners = this.serialListeners.filter((l) => l !== cb));
  }

  reset(): void {
    this.call({ op: "monitor", line: "machine Reset" });
    this.pins.clear();
  }

  /** Run a Renode monitor command (set a sensor's value, read a register). */
  monitor(line: string): string {
    const done = this.call({ op: "monitor", line }).find((e) => e.kind === "done");
    return (done?.kind === "done" && done.output) || "";
  }

  dispose(): void {
    this.call({ op: "stop" });
    void this.worker.terminate();
  }

  private call(cmd: WorkerCommand): WorkerEvent[] {
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(cmd);
    return this.wait();
  }

  private wait(): WorkerEvent[] {
    if (Atomics.wait(this.flag, 0, 0, this.timeoutMs) === "timed-out") {
      throw new Error(`Renode did not answer within ${this.timeoutMs} ms`);
    }
    const out: WorkerEvent[] = [];
    for (let m = receiveMessageOnPort(this.port); m; m = receiveMessageOnPort(this.port)) out.push(m.message as WorkerEvent);
    const err = out.find((e) => e.kind === "error");
    if (err && err.kind === "error") throw new Error(err.message);
    return out;
  }
}

export type { RenodeBackend };

/** Blocks until Renode is up (≈ 2-3 s). Requires Docker and the jumper/renode image. */
export function createRenodeBackend(opts: RenodeBackendOptions): RenodeBackend {
  return new RenodeBackend(opts);
}
