// A one-network DHCP server (RFC 2131 subset): DISCOVER → OFFER, REQUEST → ACK / NAK, RELEASE,
// DECLINE. Each device MAC gets a stable address in order of first sight (10.0.2.15, .16, ...),
// so runs are deterministic, like the fake-IP DNS.

export const DHCP_DISCOVER = 1;
export const DHCP_OFFER = 2;
export const DHCP_REQUEST = 3;
export const DHCP_DECLINE = 4;
export const DHCP_ACK = 5;
export const DHCP_NAK = 6;
export const DHCP_RELEASE = 7;
export const DHCP_INFORM = 8;

const MAGIC = 0x63825363;

export interface DhcpMessage {
  op: number;
  xid: number;
  flags: number;
  ciaddr: string;
  chaddr: Buffer;
  type: number;
  requestedIp?: string;
  serverId?: string;
  hostname?: string;
}

export function parseDhcp(p: Buffer): DhcpMessage | undefined {
  if (p.length < 240 || p.readUInt32BE(236) !== MAGIC) return undefined;
  const ip = (o: number) => `${p[o]}.${p[o + 1]}.${p[o + 2]}.${p[o + 3]}`;
  const m: DhcpMessage = { op: p[0]!, xid: p.readUInt32BE(4), flags: p.readUInt16BE(10), ciaddr: ip(12), chaddr: Buffer.from(p.subarray(28, 34)), type: 0 };
  for (let i = 240; i < p.length; ) {
    const code = p[i]!;
    if (code === 255) break;
    if (code === 0) {
      i++;
      continue;
    }
    const len = p[i + 1] ?? 0;
    const v = p.subarray(i + 2, i + 2 + len);
    if (code === 53 && len >= 1) m.type = v[0]!;
    if (code === 50 && len === 4) m.requestedIp = ip(i + 2);
    if (code === 54 && len === 4) m.serverId = ip(i + 2);
    if (code === 12) m.hostname = v.toString("latin1");
    i += 2 + len;
  }
  return m.type ? m : undefined;
}

export interface DhcpConfig {
  /** The router, DNS server and DHCP server address. */
  gateway: string;
  netmask: string;
  /** First address handed out; later devices get the next ones. */
  firstHost: string;
  leaseSeconds: number;
}

export class DhcpServer {
  private leases = new Map<string, string>();
  private next: number;

  constructor(readonly cfg: DhcpConfig) {
    this.next = Number(cfg.firstHost.split(".")[3]);
  }

  /** The address for this MAC (stable: the same MAC always gets the same address). */
  addressFor(mac: Buffer): string {
    const key = mac.toString("hex");
    let ip = this.leases.get(key);
    if (!ip) {
      const base = this.cfg.firstHost.split(".").slice(0, 3).join(".");
      ip = `${base}.${this.next++}`;
      this.leases.set(key, ip);
    }
    return ip;
  }

  leaseOf(mac: Buffer): string | undefined {
    return this.leases.get(mac.toString("hex"));
  }

  /** Answer a client message. Returns the reply (BOOTREPLY payload) and what happened, or undefined. */
  handle(m: DhcpMessage): { reply?: Buffer; event?: string; ip?: string } {
    if (m.op !== 1) return {};
    const ip = this.addressFor(m.chaddr);
    switch (m.type) {
      case DHCP_DISCOVER:
        return { reply: this.build(m, DHCP_OFFER, ip), event: "offer", ip };
      case DHCP_REQUEST: {
        if (m.serverId && m.serverId !== this.cfg.gateway) return { event: "request for another server" };
        const wanted = m.requestedIp ?? (m.ciaddr !== "0.0.0.0" ? m.ciaddr : ip);
        if (wanted !== ip) return { reply: this.build(m, DHCP_NAK, "0.0.0.0"), event: `nak (asked ${wanted}, lease is ${ip})`, ip };
        return { reply: this.build(m, DHCP_ACK, ip), event: "ack", ip };
      }
      case DHCP_INFORM:
        return { reply: this.build(m, DHCP_ACK, "0.0.0.0"), event: "inform" };
      case DHCP_RELEASE:
        return { event: "release", ip };
      case DHCP_DECLINE:
        return { event: "decline", ip };
      default:
        return {};
    }
  }

  private build(m: DhcpMessage, type: number, yiaddr: string): Buffer {
    const b = Buffer.alloc(240);
    b[0] = 2; // BOOTREPLY
    b[1] = 1;
    b[2] = 6;
    b.writeUInt32BE(m.xid, 4);
    b.writeUInt16BE(m.flags, 10);
    const put = (ip: string, o: number) => ip.split(".").forEach((x, i) => (b[o + i] = Number(x)));
    put(yiaddr, 16);
    put(this.cfg.gateway, 20); // siaddr
    m.chaddr.copy(b, 28);
    b.writeUInt32BE(MAGIC, 236);
    const ipb = (ip: string) => ip.split(".").map(Number);
    const opts: number[] = [53, 1, type, 54, 4, ...ipb(this.cfg.gateway)];
    if (type !== DHCP_NAK) {
      const t = this.cfg.leaseSeconds;
      const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
      if (type !== DHCP_ACK || yiaddr !== "0.0.0.0") opts.push(51, 4, ...be(t), 58, 4, ...be(Math.floor(t / 2)), 59, 4, ...be(Math.floor((t * 7) / 8)));
      opts.push(1, 4, ...ipb(this.cfg.netmask), 3, 4, ...ipb(this.cfg.gateway), 6, 4, ...ipb(this.cfg.gateway));
      const bcast = this.cfg.gateway.split(".").slice(0, 3).join(".") + ".255";
      opts.push(28, 4, ...ipb(bcast), 26, 2, 0x05, 0xdc); // broadcast address, MTU 1500
    }
    opts.push(255);
    return Buffer.concat([b, Buffer.from(opts)]);
  }
}
