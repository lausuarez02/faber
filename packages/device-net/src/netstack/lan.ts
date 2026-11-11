// A sandbox LAN for one run: the netstack (router, DHCP, switch, Wi-Fi access point) in front of a
// DeviceNet gateway, and a frame server emulators plug their network cards into.
import type { DeviceNet, Fault } from "../gateway.ts";
import { serveFrames, type FrameServer } from "./frame-link.ts";
import { Netstack } from "./stack.ts";
import type { AccessPoint } from "./wifi.ts";

export interface DeviceLanOptions {
  /** Networks in range; default from the project's network.wifi (empty: any SSID joins). */
  aps?: AccessPoint[];
  rssi?: number;
  /** Listen address for emulators (127.0.0.1; Docker reaches it as host.docker.internal). */
  host?: string;
  port?: number;
  rtoMs?: number;
}

export interface DeviceLan {
  stack: Netstack;
  frames: FrameServer;
  close(): Promise<void>;
}

export function pemToDer(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

const DEFAULT_RSSI = -55;
const WEAK_RSSI = -85;

/** The netstack, following the gateway's faults: wifi_drop takes the link down, weak_signal lowers the RSSI. */
export function createNetstack(dn: DeviceNet, o: DeviceLanOptions = {}): Netstack {
  const wifi = dn.config.wifi;
  const aps = o.aps ?? (wifi?.ssid ? [{ ssid: wifi.ssid, ...(wifi.password !== undefined ? { password: wifi.password } : {}) }] : []);
  const base = o.rssi ?? wifi?.rssi ?? DEFAULT_RSSI;
  const stack = new Netstack({
    gateway: dn,
    aps,
    rssi: base,
    caDer: pemToDer(dn.ca.certPem),
    log: (e) => dn.log.push(e),
    ...(o.rtoMs ? { rtoMs: o.rtoMs } : {}),
  });
  const follow = (faults: Fault[]) => {
    stack.setWifiUp(!faults.some((f) => f.kind === "wifi_drop"));
    const weak = faults.find((f): f is Extract<Fault, { kind: "weak_signal" }> => f.kind === "weak_signal");
    const rssi = weak ? (weak.rssi ?? WEAK_RSSI) : base;
    if (rssi !== stack.wifi.rssi) stack.setRssi(rssi);
  };
  follow(dn.faults);
  dn.onFaults(follow);
  return stack;
}

export async function createDeviceLan(dn: DeviceNet, o: DeviceLanOptions = {}): Promise<DeviceLan> {
  const stack = createNetstack(dn, o);
  const frames = await serveFrames(stack, { ...(o.host ? { host: o.host } : {}), ...(o.port ? { port: o.port } : {}) });
  return {
    stack,
    frames,
    close: async () => {
      stack.close();
      await frames.close();
    },
  };
}
