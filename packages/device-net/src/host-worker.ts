// The device network's own thread: the DeviceNet gateway, the netstack and the frame server run
// here, so emulator traffic keeps flowing while the main thread is blocked stepping a lockstep
// emulator (QemuEspBackend.step waits in Atomics.wait). Started by DeviceNetHost (host.ts) through
// worker-boot.mjs; talks to it over a MessagePort.
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { SandboxCA } from "./ca.ts";
import type { Mock, NetworkConfig } from "./config.ts";
import { DeviceNet, type Fault, type Upstream } from "./gateway.ts";
import { createDeviceLan } from "./netstack/lan.ts";
import { sharedClock } from "./vclock.ts";
import { probeRequest, type ProbeRequest, type ProbeResult } from "./probe.ts";

export interface HostWorkerData {
  config: NetworkConfig;
  mocks: Mock[];
  secrets: Array<[string, string]>;
  caDir: string;
  cassetteFile?: string;
  /** Tests: where an allowed host is really reached. */
  upstreams?: Record<string, Upstream>;
  listenHost?: string;
  rtoMs?: number;
  /** Virtual time from the simulation (vclock.ts). */
  vclock?: SharedArrayBuffer;
  port: MessagePort;
}

export type HostCommand =
  | { op: "mock"; mock: Mock }
  | { op: "mocks"; mocks: Mock[] }
  | { op: "fault"; fault: Fault }
  | { op: "clear" }
  | { op: "config"; config: NetworkConfig }
  | { op: "request"; id: number; req: ProbeRequest }
  | { op: "close" };

export type HostEvent =
  | { t: "ready"; framePort: number; caPem: string }
  | { t: "ev"; e: import("./log.ts").NetEvent }
  | { t: "devices"; list: import("./netstack/stack.ts").DeviceInfo[] }
  | { t: "error"; message: string }
  | { t: "response"; id: number; result: ProbeResult }
  | { t: "closed" };

async function main(d: HostWorkerData): Promise<void> {
  const out = d.port;
  const send = (m: HostEvent) => out.postMessage(m);
  try {
    const ca = await SandboxCA.open(d.caDir);
    const dn = new DeviceNet({
      config: d.config,
      mocks: d.mocks,
      secrets: new Map(d.secrets),
      ca,
      ...(d.vclock ? { clock: sharedClock(d.vclock) } : {}),
      ...(d.cassetteFile ? { cassetteFile: d.cassetteFile } : {}),
      ...(d.upstreams ? { upstream: (host: string, port: number) => d.upstreams![host] ?? { host, port } } : {}),
    });
    dn.log.onEvent((e) => send({ t: "ev", e: { ...e, ...(e.frames ? { frames: { ...e.frames, samples: [...e.frames.samples] } } : {}) } }));
    const lan = await createDeviceLan(dn, { ...(d.listenHost ? { host: d.listenHost } : {}), ...(d.rtoMs ? { rtoMs: d.rtoMs } : {}) });
    let lastDevices = "";
    const devTimer = setInterval(() => {
      const list = lan.stack.list();
      const s = JSON.stringify(list);
      if (s !== lastDevices) {
        lastDevices = s;
        send({ t: "devices", list });
      }
    }, 100);
    out.on("message", (c: HostCommand) => {
      try {
        if (c.op === "mock") dn.mocks.upsert(c.mock);
        else if (c.op === "mocks") dn.setMocks(c.mocks);
        else if (c.op === "fault") dn.inject(c.fault);
        else if (c.op === "clear") dn.clearFaults();
        else if (c.op === "config") dn.setConfig(c.config);
        else if (c.op === "request") void probeRequest(dn, c.req).then((result) => send({ t: "response", id: c.id, result }));
        else if (c.op === "close") {
          clearInterval(devTimer);
          dn.close();
          void lan.close().then(() => {
            send({ t: "closed" });
            out.close();
          });
        }
      } catch (e) {
        send({ t: "error", message: (e as Error).message });
      }
    });
    send({ t: "ready", framePort: lan.frames.port, caPem: ca.certPem });
  } catch (e) {
    send({ t: "error", message: (e as Error).message });
  }
}

if (parentPort && workerData) void main(workerData as HostWorkerData);
