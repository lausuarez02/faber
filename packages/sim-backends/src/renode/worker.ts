// Worker side of the synchronous Renode backend: owns the RenodeMachine (async sockets) and answers
// one command at a time. The main thread blocks on `signal` (Atomics.wait) and then pulls the
// reply plus every event that happened (pin edges, serial bytes) with receiveMessageOnPort.
import { workerData, type MessagePort } from "node:worker_threads";
import { RenodeMachine, type RenodeMachineOptions } from "./machine.ts";

export type WorkerCommand =
  | { op: "runFor"; ns: string }
  | { op: "setPin"; pinId: string; level: 0 | 1 }
  | { op: "monitor"; line: string }
  | { op: "stop" };

export type WorkerEvent =
  | { kind: "ready"; startupMs: number }
  | { kind: "edge"; pinId: string; value: 0 | 1; timeNs: string }
  | { kind: "serial"; bytes: number[] }
  | { kind: "done"; timeNs?: string; output?: string }
  | { kind: "error"; message: string };

interface Init {
  opts: RenodeMachineOptions;
  watch: string[];
  port: MessagePort;
  signal: SharedArrayBuffer;
}

const { opts, watch, port, signal } = workerData as Init;
const flag = new Int32Array(signal);

function wake(): void {
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

function post(e: WorkerEvent): void {
  port.postMessage(e);
}

let machine: RenodeMachine | undefined;
let serial: number[] = [];
const flushSerial = () => {
  if (serial.length) post({ kind: "serial", bytes: serial });
  serial = [];
};

try {
  machine = await RenodeMachine.start(opts);
  machine.onSerial((b) => serial.push(b));
  for (const pinId of watch) {
    await machine.watchPin(pinId, (e) => {
      flushSerial(); // keep serial and edges in arrival order
      post({ kind: "edge", pinId: e.pinId, value: e.value, timeNs: e.timeNs.toString() });
    });
  }
  post({ kind: "ready", startupMs: machine.startupMs });
} catch (e) {
  post({ kind: "error", message: (e as Error).message });
}
wake();

port.on("message", async (cmd: WorkerCommand) => {
  try {
    if (!machine) throw new Error("Renode did not start");
    if (cmd.op === "runFor") {
      await machine.runFor(BigInt(cmd.ns));
      await machine.drainSerial(5);
      flushSerial();
      post({ kind: "done", timeNs: (await machine.timeNs()).toString() });
    } else if (cmd.op === "setPin") {
      await machine.setPin(cmd.pinId, cmd.level);
      post({ kind: "done" });
    } else if (cmd.op === "monitor") {
      post({ kind: "done", output: await machine.monitor.exec(cmd.line) });
    } else {
      await machine.stop();
      post({ kind: "done" });
      port.close();
    }
  } catch (e) {
    post({ kind: "error", message: (e as Error).message });
  }
  wake();
});
