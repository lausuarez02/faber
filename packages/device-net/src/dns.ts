// Sandbox DNS ("fake IP"): every name the policy lets the device reach gets a stable synthetic
// address in 198.18.0.0/15 (the benchmarking range, never routed on the internet), so a later TCP
// / UDP flow to that address maps back to the host name without SNI or Host-header guessing, and
// works the same for HTTP, TLS, MQTT or any raw protocol. Names the policy refuses get NXDOMAIN.
// Also the tiny UDP codecs the gateway needs: DNS A queries and SNTP.

export class FakeIpPool {
  private byHost = new Map<string, string>();
  private byIp = new Map<string, string>();
  private next = 1;

  /** Deterministic: the n-th distinct name resolved gets 198.18.0.n (order of first lookup). */
  ipFor(host: string): string {
    const h = host.toLowerCase();
    let ip = this.byHost.get(h);
    if (!ip) {
      const n = this.next++;
      ip = `198.18.${(n >> 8) & 0xff}.${n & 0xff}`;
      this.byHost.set(h, ip);
      this.byIp.set(ip, h);
    }
    return ip;
  }

  hostFor(ip: string): string | undefined {
    return this.byIp.get(ip);
  }

  reset(): void {
    this.byHost.clear();
    this.byIp.clear();
    this.next = 1;
  }
}

export interface DnsQuestion {
  id: number;
  name: string;
  qtype: number;
  /** Raw question section, echoed in the answer. */
  question: Buffer;
}

export function parseDnsQuery(msg: Buffer): DnsQuestion | undefined {
  if (msg.length < 12) return undefined;
  const id = msg.readUInt16BE(0);
  const qd = msg.readUInt16BE(4);
  if (qd < 1) return undefined;
  let o = 12;
  const labels: string[] = [];
  while (o < msg.length) {
    const len = msg[o]!;
    if (len === 0) {
      o++;
      break;
    }
    if (len > 63) return undefined;
    labels.push(msg.subarray(o + 1, o + 1 + len).toString("latin1"));
    o += 1 + len;
  }
  if (o + 4 > msg.length) return undefined;
  const qtype = msg.readUInt16BE(o);
  return { id, name: labels.join(".").toLowerCase(), qtype, question: msg.subarray(12, o + 4) };
}

export function buildDnsQuery(id: number, name: string): Buffer {
  const parts = name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")]));
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x0100, 2); // RD
  head.writeUInt16BE(1, 4);
  return Buffer.concat([head, ...parts, Buffer.from([0, 0, 1, 0, 1])]);
}

/** An answer: A record (ttl 60) or rcode 3 (NXDOMAIN). AAAA queries get an empty NOERROR. */
export function buildDnsAnswer(q: DnsQuestion, ip: string | undefined): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(q.id, 0);
  const isA = q.qtype === 1;
  const rcode = ip === undefined ? 3 : 0;
  head.writeUInt16BE(0x8180 | rcode, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(ip !== undefined && isA ? 1 : 0, 6);
  if (ip === undefined || !isA) return Buffer.concat([head, q.question]);
  const ans = Buffer.alloc(16);
  ans.writeUInt16BE(0xc00c, 0);
  ans.writeUInt16BE(1, 2);
  ans.writeUInt16BE(1, 4);
  ans.writeUInt32BE(60, 6);
  ans.writeUInt16BE(4, 10);
  ip.split(".").forEach((b, i) => ans.writeUInt8(Number(b), 12 + i));
  return Buffer.concat([head, q.question, ans]);
}

export function parseDnsAnswerIp(msg: Buffer): { rcode: number; ip?: string } {
  const rcode = msg.readUInt16BE(2) & 0xf;
  const an = msg.readUInt16BE(6);
  if (!an) return { rcode };
  const a = msg.subarray(msg.length - 4);
  return { rcode, ip: [...a].join(".") };
}

/** NTP epoch offset (1900 → 1970) in seconds. */
const NTP_EPOCH = 2_208_988_800;

/** An SNTP server reply for a client request, with the time the sandbox decides (the virtual clock). */
export function buildNtpReply(req: Buffer, unixMs: number): Buffer | undefined {
  if (req.length < 48) return undefined;
  const out = Buffer.alloc(48);
  out[0] = (0 << 6) | (4 << 3) | 4; // LI 0, VN 4, mode 4 (server)
  out[1] = 1; // stratum 1
  out[2] = req[2]!;
  out[3] = 0xec; // precision
  out.write("JMPR", 12, "latin1");
  const secs = Math.floor(unixMs / 1000) + NTP_EPOCH;
  const frac = Math.floor(((unixMs % 1000) / 1000) * 2 ** 32);
  for (const off of [16, 32, 40]) {
    out.writeUInt32BE(secs >>> 0, off);
    out.writeUInt32BE(frac >>> 0, off + 4);
  }
  req.copy(out, 24, 40, 48); // originate = client's transmit
  return out;
}

export function parseNtpTransmitMs(reply: Buffer): number {
  return (reply.readUInt32BE(40) - NTP_EPOCH) * 1000 + Math.round((reply.readUInt32BE(44) / 2 ** 32) * 1000);
}
