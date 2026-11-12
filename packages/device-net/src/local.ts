// Round 14: reaching a real service on this computer or the local network from a simulated device,
// safely. The safety model:
//   - Nothing on this computer or the LAN is reachable by default. A host in network.allow that
//     resolves to a loopback, private or link-local address is refused, in every mode, unless its
//     entry says "local": true (so a public name that points at 127.0.0.1 cannot be used to reach
//     the person's own services by accident).
//   - "to": "http://127.0.0.1:7821" sends one host name's traffic to a service the person runs here
//     (a dev server, a mock they wrote). It needs "local": true, and it works in "mock" mode too
//     (nothing leaves this computer), so tests can call it; mocks still answer first.
//   - Per host, explicit: no wildcard entry may use "to" or "local".
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

/** Loopback, private (RFC 1918 / ULA), link-local, CGNAT and unspecified addresses. */
export function isLocalAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("::ffff:")) return isLocalAddress(x.slice(7));
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
  }
  return false;
}

/** A host name that only means something on this computer or the LAN. */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "host.docker.internal" || isLocalAddress(h);
}

export interface LocalTarget {
  protocol: "http:" | "https:";
  host: string;
  port: number;
}

/** Parse an allow entry's "to" ("http://127.0.0.1:7821"). Throws an Error with what / why / fix in the text. */
export function parseLocalTarget(to: string, field = "to"): LocalTarget {
  let u: URL;
  try {
    u = new URL(to);
  } catch {
    throw new Error(`${field} '${to}' is not a URL. Why: "to" says where this host's traffic goes, as a URL with a scheme, host and port. Fix: "to": "http://127.0.0.1:7821".`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${field} '${to}' uses ${u.protocol}, which the sandbox cannot forward to. Why: it forwards HTTP, HTTPS and WebSocket requests. Fix: use http:// or https://.`);
  if ((u.pathname && u.pathname !== "/") || u.search || u.username) throw new Error(`${field} '${to}' has a path, query or user. Why: the device's own path is kept; "to" only changes where it goes. Fix: "${u.protocol}//${u.host}".`);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { protocol: u.protocol, host: u.hostname.replace(/^\[|\]$/g, ""), port };
}

export class LocalAddressRefused extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    super(`${host} resolved to ${address}, an address on this computer or its local network`);
  }
  get why(): string {
    return `${this.host} resolves to ${this.address}, which is on this computer or its local network, and its network.allow entry does not say "local": true (the sandbox never reaches local services unless a host is opted in, so a device cannot reach the person's own services by accident)`;
  }
  get fix(): string {
    return `if the device should reach a service you run here, add "local": true to the ${this.host} entry in network.allow (and "to": "http://127.0.0.1:<port>" to send it to a port on this computer); otherwise mock it`;
  }
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A dns.lookup for http.request / net.connect that refuses local addresses unless allowed. Node calls
 * it with (host, options, cb); the refusal is a LocalAddressRefused error on the request.
 */
export function guardedLookup(allowLocal: boolean): (host: string, options: object, cb: LookupCb) => void {
  return (host, options, cb) => {
    (dnsLookup as unknown as (h: string, o: object, cb: LookupCb) => void)(host, options, ((err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
      if (err) return cb(err, address, family);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      const bad = list.find((a) => isLocalAddress(a));
      if (bad && !allowLocal) return cb(new LocalAddressRefused(host, bad) as unknown as NodeJS.ErrnoException, address, family);
      cb(null, address, family);
    }) as LookupCb);
  };
}
