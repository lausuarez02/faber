// DeviceNetHost: the device network for one simulation run, seen from the main thread. The
// gateway and netstack live in a worker thread (host-worker.ts) so traffic flows while a lockstep
// emulator blocks this thread; this side keeps a mirror of the log, the mocks and the faults that
// tools, scenario checks and the UI read synchronously (pending events are drained with
// receiveMessageOnPort, so even a synchronous scenario loop sees what happened).
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { validateMock, type Mock, type NetworkConfig } from "./config.ts";
import type { Fault, Upstream } from "./gateway.ts";
import type { HostCommand, HostEvent, HostWorkerData } from "./host-worker.ts";
import type { NetEvent } from "./log.ts";
import type { DeviceInfo } from "./netstack/stack.ts";
import { Redactor } from "./secrets.ts";

export interface DeviceNetHostOptions {
  config: NetworkConfig;
  mocks?: Mock[];
  /** Secret values by name (never logged; only the worker and the redactor hold them). */
  secrets?: Map<string, string>;
  /** Sandbox CA folder (per machine, never in a project). */
  caDir: string;
  cassetteFile?: string;
  /** Tests only: where allowed hosts are really reached. */
  upstreams?: Record<string, Upstream>;
  /** Where emulators connect (127.0.0.1; Docker reaches it as host.docker.internal). */
  listenHost?: string;
  rtoMs?: number;
  /** How long start() waits for the worker. Default 15 s. */
  timeoutMs?: number;
}

/** The log as tools read it (same shape as NetLog). */
export class LogMirror {
  private entries: NetEvent[] = [];
  private bySeq = new Map<number, NetEvent>();
  private listeners = new Set<(e: NetEvent) => void>();

  upsert(e: NetEvent): void {
    const cur = this.bySeq.get(e.seq);
    if (cur) Object.assign(cur, e);
    else {
      this.entries.push(e);
      this.bySeq.set(e.seq, e);
      if (this.entries.length > 2000) for (const old of this.entries.splice(0, this.entries.length - 2000)) this.bySeq.delete(old.seq);
    }
    for (const l of this.listeners) l(cur ?? e);
  }

  since(seq = 0): NetEvent[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  onEvent(cb: (e: NetEvent) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  clear(): void {
    this.entries = [];
    this.bySeq.clear();
  }
}

export class DeviceNetHost {
  readonly log = new LogMirror();
  readonly redactor: Redactor;
  faults: Fault[] = [];
  devices: DeviceInfo[] = [];
  private _config: NetworkConfig;
  private mockList: Mock[];
  private closed = false;
  private errors: string[] = [];

  private constructor(
    private readonly worker: Worker,
    private readonly port: MessagePort,
    readonly framePort: number,
    readonly caPem: string,
    opts: DeviceNetHostOptions,
  ) {
    this._config = opts.config;
    this.mockList = [...(opts.mocks ?? [])];
    this.redactor = new Redactor(opts.secrets ?? new Map());
    port.on("message", (m: HostEvent) => this.onEvent(m));
  }

  static async start(opts: DeviceNetHostOptions): Promise<DeviceNetHost> {
    const { port1, port2 } = new MessageChannel();
    const data: HostWorkerData = {
      config: opts.config,
      mocks: opts.mocks ?? [],
      secrets: [...(opts.secrets ?? new Map()).entries()],
      caDir: opts.caDir,
      ...(opts.cassetteFile ? { cassetteFile: opts.cassetteFile } : {}),
      ...(opts.upstreams ? { upstreams: opts.upstreams } : {}),
      ...(opts.listenHost ? { listenHost: opts.listenHost } : {}),
      ...(opts.rtoMs ? { rtoMs: opts.rtoMs } : {}),
      port: port2,
    };
    const worker = new Worker(new URL("./worker-boot.mjs", import.meta.url), { workerData: data, transferList: [port2] });
    worker.unref();
    const ready = await new Promise<Extract<HostEvent, { t: "ready" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the device network did not start within ${(opts.timeoutMs ?? 15000) / 1000} s. Fix: check that tsx is installed (pnpm install) and run again`)), opts.timeoutMs ?? 15000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(new Error(`the device network could not start: ${e.message}`));
      };
      worker.once("error", fail);
      port1.on("message", function first(m: HostEvent) {
        if (m.t === "ready") {
          clearTimeout(timer);
          port1.off("message", first);
          worker.off("error", fail);
          resolve(m);
        } else if (m.t === "error") fail(new Error(m.message));
      });
    });
    port1.unref();
    return new DeviceNetHost(worker, port1, ready.framePort, ready.caPem, opts);
  }

  private onEvent(m: HostEvent): void {
    if (m.t === "ev") this.log.upsert(m.e);
    else if (m.t === "devices") this.devices = m.list;
    else if (m.t === "error") this.errors.push(m.message);
  }

  /** Take in everything the worker has sent so far, without waiting for the event loop. */
  drain(): void {
    for (;;) {
      const r = receiveMessageOnPort(this.port);
      if (!r) break;
      this.onEvent(r.message as HostEvent);
    }
  }

  get config(): NetworkConfig {
    return this._config;
  }

  /** The mocks as tools see them (upsert applies live in the worker too). */
  get mocks(): { list: Mock[]; upsert(m: Mock): "added" | "updated" } {
    const self = this;
    return {
      get list() {
        return self.mockList;
      },
      upsert(m: Mock) {
        const v = validateMock(m);
        const key = (x: Mock) => `${x.kind ?? "http"} ${x.host} ${(x as { method?: string }).method ?? ""} ${(x as { path?: string }).path ?? ""}`;
        const i = self.mockList.findIndex((x) => key(x) === key(v));
        if (i >= 0) self.mockList[i] = v;
        else self.mockList.push(v);
        self.send({ op: "mock", mock: v });
        return i >= 0 ? "updated" : "added";
      },
    };
  }

  setConfig(c: NetworkConfig): void {
    this._config = c;
    this.send({ op: "config", config: c });
  }

  inject(f: Fault): string {
    this.faults.push({ ...f });
    this.send({ op: "fault", fault: f });
    return f.kind;
  }

  clearFaults(): void {
    this.faults = [];
    this.send({ op: "clear" });
  }

  /** Errors the worker reported (a bad command), for diagnostics. */
  get workerErrors(): readonly string[] {
    return this.errors;
  }

  private send(c: HostCommand): void {
    if (!this.closed) this.port.postMessage(c);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.send({ op: "close" });
    this.closed = true;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      const onMsg = (m: HostEvent) => {
        if (m.t === "closed") {
          clearTimeout(t);
          resolve();
        } else this.onEvent(m);
      };
      this.port.ref();
      this.port.on("message", onMsg);
    });
    this.port.close();
    await this.worker.terminate();
  }
}
