// A synchronous line link to the QEMU bridge socket, so McuBackend.step() can stay synchronous
// like every other backend. A worker thread owns the TCP server and the socket; the main thread
// blocks in Atomics.wait until the worker hands over a batch of lines that ends where the emulator
// itself blocks (QEMU: lockstep target "T", an I2C request "IS"/"IR", a question "SQ"/"SR" or a pull
// change "P", protocol.ts BLOCKING_PREFIXES; other emulators pass their own `blocking` line
// prefixes, e.g. the Renode bridge). The emulator cannot run ahead in between, so
// nothing is lost or reordered and the result is deterministic.
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { BLOCKING_PREFIXES } from "./protocol.ts";

const CTRL_SEQ = 0; // batches published by the worker
const CTRL_LEN = 1; // byte length of the current batch
const CTRL_PORT = 2; // TCP port the worker listens on (0 until listening)
const CTRL_CLOSED = 3; // 1 once the socket closed
const CTRL_ACK = 4; // last batch the main thread consumed
const CTRL_FD = 5; // the socket's file descriptor (+1; 0 = unknown), for direct synchronous writes

const WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const net = require("node:net");
const ctrl = new Int32Array(workerData.ctrl);
const data = new Uint8Array(workerData.data);
let sock = null, buf = "", lines = [];
function publish() {
  // Wait until the main thread consumed the previous batch, then hand over this one.
  while (Atomics.load(ctrl, ${CTRL_ACK}) !== Atomics.load(ctrl, ${CTRL_SEQ})) Atomics.wait(ctrl, ${CTRL_ACK}, Atomics.load(ctrl, ${CTRL_ACK}), 50);
  const text = Buffer.from(lines.join("\\n"), "latin1");
  if (text.length > data.length) throw new Error("bridge batch larger than the shared buffer");
  data.set(text, 0);
  Atomics.store(ctrl, ${CTRL_LEN}, text.length);
  lines = [];
  Atomics.add(ctrl, ${CTRL_SEQ}, 1);
  Atomics.notify(ctrl, ${CTRL_SEQ});
}
const prefixes = workerData.blocking;
const blocking = (l) => prefixes.some((p) => l.startsWith(p));
const server = net.createServer((s) => {
  if (sock) { s.destroy(); return; }
  sock = s; s.setNoDelay(true); s.setEncoding("latin1"); server.close();
  const fd = s._handle && typeof s._handle.fd === "number" ? s._handle.fd : -1;
  if (fd >= 0) Atomics.store(ctrl, ${CTRL_FD}, fd + 1);
  s.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(l);
      if (blocking(l) || lines.length >= workerData.maxLines) publish();
    }
  });
  const end = () => { if (Atomics.load(ctrl, ${CTRL_CLOSED})) return; if (buf) lines.push(buf); buf = ""; Atomics.store(ctrl, ${CTRL_CLOSED}, 1); publish(); };
  s.on("close", end); s.on("error", end);
});
server.listen(0, workerData.host, () => { Atomics.store(ctrl, ${CTRL_PORT}, server.address().port); Atomics.notify(ctrl, ${CTRL_PORT}); });
parentPort.on("message", (m) => { if (m.send && sock) sock.write(m.send, "latin1"); if (m.close) { sock?.destroy(); server.close(); } });
`;

export class BridgeTimeoutError extends Error {}

export class SyncBridgeLink {
  readonly port: number;
  private readonly worker: Worker;
  private readonly ctrl: Int32Array;
  private readonly data: Uint8Array;
  private consumed = 0;

  /** Starts listening on `host` (127.0.0.1 by default; Docker Desktop forwards host.docker.internal to it). */
  constructor(opts: { host?: string; bufferBytes?: number; maxLines?: number; blocking?: readonly string[] } = {}) {
    const ctrlBuf = new SharedArrayBuffer(8 * 4);
    const dataBuf = new SharedArrayBuffer(opts.bufferBytes ?? 4 << 20);
    this.ctrl = new Int32Array(ctrlBuf);
    this.data = new Uint8Array(dataBuf);
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { ctrl: ctrlBuf, data: dataBuf, host: opts.host ?? "127.0.0.1", maxLines: opts.maxLines ?? 20000, blocking: [...(opts.blocking ?? BLOCKING_PREFIXES)] },
    });
    this.worker.unref();
    if (Atomics.wait(this.ctrl, CTRL_PORT, 0, 5000) === "timed-out" && this.ctrl[CTRL_PORT] === 0) {
      throw new BridgeTimeoutError("bridge worker did not start listening within 5 s");
    }
    this.port = this.ctrl[CTRL_PORT]!;
  }

  get closed(): boolean {
    return Atomics.load(this.ctrl, CTRL_CLOSED) === 1 && Atomics.load(this.ctrl, CTRL_SEQ) === this.consumed;
  }

  send(text: string): void {
    // Fast path: write straight to the socket from this thread (no hop through the worker's event
    // loop while we are about to block). Small writes never hit EAGAIN on an idle socket.
    const fd = Atomics.load(this.ctrl, CTRL_FD) - 1;
    if (fd >= 0) {
      const buf = Buffer.from(text, "latin1");
      let off = 0;
      for (let tries = 0; off < buf.length && tries < 1000; tries++) {
        try {
          off += writeSync(fd, buf, off);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
        }
      }
      if (off === buf.length) return;
      this.worker.postMessage({ send: buf.subarray(off).toString("latin1") });
      return;
    }
    this.worker.postMessage({ send: text });
  }

  /**
   * Blocks until the next batch of lines (ending at a line QEMU waits on, or at socket close).
   * Throws BridgeTimeoutError after `timeoutMs`.
   */
  next(timeoutMs: number): string[] {
    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(this.ctrl, CTRL_SEQ) === this.consumed) {
      const left = deadline - Date.now();
      if (left <= 0) throw new BridgeTimeoutError(`no answer from the emulator within ${timeoutMs} ms`);
      Atomics.wait(this.ctrl, CTRL_SEQ, this.consumed, left);
    }
    const len = Atomics.load(this.ctrl, CTRL_LEN);
    const text = Buffer.from(this.data.subarray(0, len)).toString("latin1");
    this.consumed = Atomics.load(this.ctrl, CTRL_SEQ);
    Atomics.store(this.ctrl, CTRL_ACK, this.consumed);
    Atomics.notify(this.ctrl, CTRL_ACK);
    return text.length ? text.split("\n") : [];
  }

  /** Like next(), but waits without blocking the event loop (Atomics.waitAsync): for the 1 to 3 s boot. */
  async nextAsync(timeoutMs: number): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(this.ctrl, CTRL_SEQ) === this.consumed) {
      const left = deadline - Date.now();
      if (left <= 0) throw new BridgeTimeoutError(`no answer from the emulator within ${timeoutMs} ms`);
      const w = (Atomics as unknown as { waitAsync: (a: Int32Array, i: number, v: number, t: number) => { async: boolean; value: Promise<string> | string } }).waitAsync(this.ctrl, CTRL_SEQ, this.consumed, Math.min(left, 250));
      if (w.async) await w.value;
    }
    return this.next(0);
  }

  close(): void {
    this.worker.postMessage({ close: true });
    void this.worker.terminate();
  }
}
