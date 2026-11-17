// Fabwright's Wi-Fi control channel, between the netstack (the "access point") and the Wi-Fi shim in
// a simulation build of the firmware. Real Wi-Fi radios are not emulated; the shim maps the
// firmware's Wi-Fi API (esp_wifi_* under WiFi.h) onto the emulated Ethernet card, and asks the
// netstack over this channel whether it may join, what the RSSI is, which networks a scan finds,
// and which CA the sandbox TLS uses. Fabwright decides, so a scenario or an agent can drop the Wi-Fi,
// weaken the signal or refuse a wrong password.
//
// Frames: EtherType 0x88B5, payload = ASCII lines "JWIFI/1 <verb> k=v k=v" (values %-encoded).
//   device → Fabwright   hello chip=esp32s3 shim=1
//                     connect ssid=<s> pass=<s>
//                     disconnect
//                     scan
//   Fabwright → device   connected ssid=<s> bssid=<mac> channel=<n> rssi=<dBm> auth=<n>
//                     failed reason=<n> after_ms=<n>         (wifi_err_reason_t, e.g. 201 no AP)
//                     lost reason=<n>                        (link dropped: beacon timeout = 200)
//                     rssi v=<dBm>
//                     ap ssid=<s> bssid=<mac> channel=<n> rssi=<dBm> auth=<n>   (one per network)
//                     scan_done n=<count>
//                     ca der=<hex>                            (the sandbox CA, trusted in the sim build)

export const WIFI_MAGIC = "JWIFI/1";

/** ESP-IDF wifi_err_reason_t values the shim reports. */
export const WIFI_REASON = {
  ASSOC_LEAVE: 8,
  HANDSHAKE_4WAY_TIMEOUT: 15,
  BEACON_TIMEOUT: 200,
  NO_AP_FOUND: 201,
  AUTH_FAIL: 202,
} as const;

/** wifi_auth_mode_t: open = 0, WPA2-PSK = 3. */
export const AUTH_OPEN = 0;
export const AUTH_WPA2_PSK = 3;

export interface WifiMsg {
  verb: string;
  args: Record<string, string>;
}

const enc = (v: string) => v.replace(/[%\s=\x00-\x1f\x7f-\xff]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const dec = (v: string) => v.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export function encodeWifi(lines: WifiMsg[]): Buffer {
  return Buffer.from(lines.map((l) => [WIFI_MAGIC, l.verb, ...Object.entries(l.args).map(([k, v]) => `${k}=${enc(v)}`)].join(" ")).join("\n") + "\n", "latin1");
}

export function decodeWifi(payload: Buffer): WifiMsg[] {
  const out: WifiMsg[] = [];
  const text = payload.toString("latin1").replace(/\0+$/, "");
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== WIFI_MAGIC || !parts[1]) continue;
    const args: Record<string, string> = {};
    for (const p of parts.slice(2)) {
      const i = p.indexOf("=");
      if (i > 0) args[p.slice(0, i)] = dec(p.slice(i + 1));
    }
    out.push({ verb: parts[1], args });
  }
  return out;
}

export interface AccessPoint {
  ssid: string;
  /** Only checked when set: a wrong password from the firmware is refused like a real AP would. */
  password?: string;
  rssi?: number;
  channel?: number;
}

/** Wi-Fi as the sandbox presents it to the firmware. */
export interface WifiState {
  /** false while a wifi_drop fault is active: no network is in range. */
  up: boolean;
  /** Signal strength the firmware reads (WiFi.RSSI()). */
  rssi: number;
  /**
   * Networks in range. Empty: any SSID the firmware asks for is accepted (the sandbox plays that
   * network), which is what most projects want.
   */
  aps: AccessPoint[];
}

export interface JoinDecision {
  ok: boolean;
  ssid: string;
  reason?: number;
  why?: string;
  fix?: string;
}

/** Would the sandbox let the firmware join `ssid` with `pass`? */
export function decideJoin(w: WifiState, ssid: string, pass: string): JoinDecision {
  if (!w.up) {
    return { ok: false, ssid, reason: WIFI_REASON.NO_AP_FOUND, why: "Wi-Fi is down (a wifi_drop fault is active), so no network is in range", fix: "clear the fault (inject_network_fault {\"kind\": \"clear\"}); the firmware should retry on its own" };
  }
  if (!w.aps.length) return { ok: true, ssid };
  const ap = w.aps.find((a) => a.ssid === ssid);
  if (!ap) {
    return { ok: false, ssid, reason: WIFI_REASON.NO_AP_FOUND, why: `the firmware asked for "${ssid}", but the sandbox only has ${w.aps.map((a) => `"${a.ssid}"`).join(", ")} (fabwright.json network.wifi)`, fix: `use the same SSID in the sketch and in network.wifi.ssid, or remove network.wifi to accept any SSID` };
  }
  if (ap.password !== undefined && ap.password !== pass) {
    return { ok: false, ssid, reason: WIFI_REASON.HANDSHAKE_4WAY_TIMEOUT, why: `the password the firmware sent for "${ssid}" (${pass.length} characters) does not match network.wifi.password`, fix: "use the same password in the sketch and in fabwright.json network.wifi, or remove network.wifi.password to accept any password" };
  }
  return { ok: true, ssid };
}

/** A stable, locally administered BSSID for an SSID. */
export function bssidFor(ssid: string): string {
  let h = 2166136261;
  for (const c of ssid) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return ["02", "4a", ...[h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff].map((b) => b.toString(16).padStart(2, "0"))].join(":");
}
