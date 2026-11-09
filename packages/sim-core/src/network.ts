// The sandbox network a simulated radio part (ESP-01 Wi-Fi module) talks to. Types only: the
// implementation lives with the host (services/ai-gateway `createSandboxNetwork`), which the
// Simulation receives as `services.network` and hands to parts as ctx.services.network.
//
// Everything is driven by virtual time (tMs arguments); an implementation must be deterministic
// unless it is in an explicit live mode (a real AI call), and must say so in its log.

/** A Wi-Fi access point the module can see. */
export interface SandboxAccessPoint {
  ssid: string;
  /** dBm, e.g. -52. */
  rssi: number;
  /** WPA2 password needed. */
  secured: boolean;
  channel: number;
}

/**
 * Why a join failed, as the ESP8266 AT firmware reports it in "+CWJAP:<code>":
 * 1 timeout, 2 wrong password, 3 cannot find the AP, 4 connection failed.
 */
export type SandboxJoinCode = 0 | 1 | 2 | 3 | 4;

/** One TCP (or TLS) connection from a part to a sandbox host. Data is a byte string (latin1, one char per byte). */
export interface SandboxSocket {
  /** Virtual ms the TCP (+TLS) handshake takes; the part reports CONNECT after it. */
  readonly connectMs: number;
  /** Bytes the device sent (AT+CIPSEND payload). */
  write(data: string, tMs: number): void;
  /**
   * Whatever the peer has delivered by virtual time tMs (removed from the socket), and whether
   * the peer has closed. Returns { data: "", closed: false } when nothing is due yet.
   */
  read(tMs: number): { data: string; closed: boolean };
  /** The device closed the link (AT+CIPCLOSE). */
  close(tMs: number): void;
  /** True while a reply is being produced outside the simulation (a live AI call); hosts may wait for it. */
  readonly pending: boolean;
}

export interface SandboxNetwork {
  /** Access points in range (empty while the Wi-Fi fault is active). */
  accessPoints(): SandboxAccessPoint[];
  /** Try to associate; 0 = joined. */
  join(ssid: string, password: string, tMs: number, partId: string): SandboxJoinCode;
  /** The device left the AP (AT+CWQAP, power off). */
  leave?(tMs: number, partId: string): void;
  /** False while a "wifi_drop" fault is active: associated stations lose the link. */
  linkUp(): boolean;
  /** DNS: an IP for a sandbox host name (or a dotted IP), or undefined (DNS Fail). */
  resolve(host: string): string | undefined;
  /** Open a TCP / TLS connection. */
  open(o: { host: string; ip: string; port: number; tls: boolean; tMs: number; partId: string }): SandboxSocket | { error: "refused" | "unreachable" };
}

/** Host services a Simulation passes through to part models (ctx.services). */
export interface SimServices {
  network?: SandboxNetwork;
  [name: string]: unknown;
}
