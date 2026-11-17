// Ethernet II, ARP, IPv4, ICMP echo, UDP and TCP codecs for the device netstack. Only what a
// microcontroller on a virtual LAN sends: no IP options on output, no fragments, IPv4 only.

export const ETH_IPV4 = 0x0800;
export const ETH_ARP = 0x0806;
export const ETH_IPV6 = 0x86dd;
/** IEEE "local experimental" EtherType 1: Faber's Wi-Fi control channel (see wifi.ts). */
export const ETH_FABER = 0x88b5;

export const PROTO_ICMP = 1;
export const PROTO_TCP = 6;
export const PROTO_UDP = 17;

export type Mac = Buffer;

export const BROADCAST: Mac = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export function macStr(m: Mac): string {
  return [...m].map((b) => b.toString(16).padStart(2, "0")).join(":");
}

export function macParse(s: string): Mac {
  return Buffer.from(s.split(":").map((h) => parseInt(h, 16)));
}

export function ipToU32(ip: string): number {
  return ip.split(".").reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);
}

export function u32ToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

export function ipBytes(ip: string): Buffer {
  return Buffer.from(ip.split(".").map(Number));
}

export function ipFromBytes(b: Buffer, off = 0): string {
  return `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`;
}

/** The Internet checksum (RFC 1071) over one or more buffers. */
export function checksum(...parts: Buffer[]): number {
  let sum = 0;
  let odd: number | undefined;
  for (const p of parts) {
    let i = 0;
    if (odd !== undefined && p.length) {
      sum += (odd << 8) | p[0]!;
      odd = undefined;
      i = 1;
    }
    for (; i + 1 < p.length; i += 2) sum += (p[i]! << 8) | p[i + 1]!;
    if (i < p.length) odd = p[i]!;
  }
  if (odd !== undefined) sum += odd << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

// ------------------------------------------------------------------ Ethernet

export interface EthFrame {
  dst: Mac;
  src: Mac;
  type: number;
  payload: Buffer;
}

export function parseEth(f: Buffer): EthFrame | undefined {
  if (f.length < 14) return undefined;
  let type = f.readUInt16BE(12);
  let off = 14;
  if (type === 0x8100 && f.length >= 18) {
    // 802.1Q tag: skip it.
    type = f.readUInt16BE(16);
    off = 18;
  }
  return { dst: f.subarray(0, 6), src: f.subarray(6, 12), type, payload: f.subarray(off) };
}

export function buildEth(dst: Mac, src: Mac, type: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(14);
  dst.copy(h, 0);
  src.copy(h, 6);
  h.writeUInt16BE(type, 12);
  const f = Buffer.concat([h, payload]);
  // Pad to the 60-byte minimum (without FCS) like a real NIC.
  return f.length < 60 ? Buffer.concat([f, Buffer.alloc(60 - f.length)]) : f;
}

// ------------------------------------------------------------------ ARP

export interface Arp {
  op: number;
  sha: Mac;
  spa: string;
  tha: Mac;
  tpa: string;
}

export function parseArp(p: Buffer): Arp | undefined {
  if (p.length < 28 || p.readUInt16BE(0) !== 1 || p.readUInt16BE(2) !== ETH_IPV4) return undefined;
  return { op: p.readUInt16BE(6), sha: p.subarray(8, 14), spa: ipFromBytes(p, 14), tha: p.subarray(18, 24), tpa: ipFromBytes(p, 24) };
}

export function buildArp(op: number, sha: Mac, spa: string, tha: Mac, tpa: string): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt16BE(1, 0);
  b.writeUInt16BE(ETH_IPV4, 2);
  b[4] = 6;
  b[5] = 4;
  b.writeUInt16BE(op, 6);
  sha.copy(b, 8);
  ipBytes(spa).copy(b, 14);
  tha.copy(b, 18);
  ipBytes(tpa).copy(b, 24);
  return b;
}

// ------------------------------------------------------------------ IPv4

export interface Ip4 {
  src: string;
  dst: string;
  proto: number;
  ttl: number;
  id: number;
  /** More fragments or a fragment offset: the stack drops these (microcontrollers do not fragment). */
  fragment: boolean;
  payload: Buffer;
}

export function parseIp4(p: Buffer): Ip4 | undefined {
  if (p.length < 20 || p[0]! >> 4 !== 4) return undefined;
  const ihl = (p[0]! & 0x0f) * 4;
  const total = p.readUInt16BE(2);
  if (ihl < 20 || total < ihl || total > p.length) return undefined;
  const flags = p.readUInt16BE(6);
  return {
    src: ipFromBytes(p, 12),
    dst: ipFromBytes(p, 16),
    proto: p[9]!,
    ttl: p[8]!,
    id: p.readUInt16BE(4),
    fragment: (flags & 0x2000) !== 0 || (flags & 0x1fff) !== 0,
    payload: p.subarray(ihl, total),
  };
}

export function buildIp4(src: string, dst: string, proto: number, payload: Buffer, id: number, ttl = 64): Buffer {
  const h = Buffer.alloc(20);
  h[0] = 0x45;
  h.writeUInt16BE(20 + payload.length, 2);
  h.writeUInt16BE(id & 0xffff, 4);
  h.writeUInt16BE(0x4000, 6); // don't fragment
  h[8] = ttl;
  h[9] = proto;
  ipBytes(src).copy(h, 12);
  ipBytes(dst).copy(h, 16);
  h.writeUInt16BE(checksum(h), 10);
  return Buffer.concat([h, payload]);
}

function pseudo(src: string, dst: string, proto: number, len: number): Buffer {
  const b = Buffer.alloc(12);
  ipBytes(src).copy(b, 0);
  ipBytes(dst).copy(b, 4);
  b[9] = proto;
  b.writeUInt16BE(len, 10);
  return b;
}

// ------------------------------------------------------------------ ICMP

export function buildIcmpEchoReply(req: Buffer): Buffer | undefined {
  if (req.length < 8 || req[0] !== 8) return undefined;
  const r = Buffer.from(req);
  r[0] = 0;
  r.writeUInt16BE(0, 2);
  r.writeUInt16BE(checksum(r), 2);
  return r;
}

// ------------------------------------------------------------------ UDP

export interface Udp {
  srcPort: number;
  dstPort: number;
  payload: Buffer;
}

export function parseUdp(p: Buffer): Udp | undefined {
  if (p.length < 8) return undefined;
  const len = p.readUInt16BE(4);
  if (len < 8 || len > p.length) return undefined;
  return { srcPort: p.readUInt16BE(0), dstPort: p.readUInt16BE(2), payload: p.subarray(8, len) };
}

export function buildUdp(src: string, dst: string, srcPort: number, dstPort: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(srcPort, 0);
  h.writeUInt16BE(dstPort, 2);
  h.writeUInt16BE(8 + payload.length, 4);
  const c = checksum(pseudo(src, dst, PROTO_UDP, 8 + payload.length), h, payload);
  h.writeUInt16BE(c === 0 ? 0xffff : c, 6);
  return Buffer.concat([h, payload]);
}

// ------------------------------------------------------------------ TCP

export const FIN = 0x01;
export const SYN = 0x02;
export const RST = 0x04;
export const PSH = 0x08;
export const ACK = 0x10;

export interface Tcp {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  /** MSS option, when the segment carries one (SYN). */
  mss?: number;
  /** Window scale option (SYN only). */
  wscale?: number;
  payload: Buffer;
}

export function parseTcp(p: Buffer): Tcp | undefined {
  if (p.length < 20) return undefined;
  const off = (p[12]! >> 4) * 4;
  if (off < 20 || off > p.length) return undefined;
  const t: Tcp = {
    srcPort: p.readUInt16BE(0),
    dstPort: p.readUInt16BE(2),
    seq: p.readUInt32BE(4),
    ack: p.readUInt32BE(8),
    flags: p[13]! & 0x3f,
    window: p.readUInt16BE(14),
    payload: p.subarray(off),
  };
  for (let i = 20; i < off; ) {
    const kind = p[i]!;
    if (kind === 0) break;
    if (kind === 1) {
      i++;
      continue;
    }
    const len = p[i + 1]!;
    if (len < 2 || i + len > off) break;
    if (kind === 2 && len === 4) t.mss = p.readUInt16BE(i + 2);
    if (kind === 3 && len === 3) t.wscale = p[i + 2]!;
    i += len;
  }
  return t;
}

export function buildTcp(src: string, dst: string, t: Omit<Tcp, "payload" | "wscale"> & { payload?: Buffer }): Buffer {
  const opts = t.mss !== undefined ? Buffer.from([2, 4, (t.mss >> 8) & 0xff, t.mss & 0xff]) : Buffer.alloc(0);
  const h = Buffer.alloc(20 + opts.length);
  h.writeUInt16BE(t.srcPort, 0);
  h.writeUInt16BE(t.dstPort, 2);
  h.writeUInt32BE(t.seq >>> 0, 4);
  h.writeUInt32BE(t.ack >>> 0, 8);
  h[12] = ((20 + opts.length) / 4) << 4;
  h[13] = t.flags;
  h.writeUInt16BE(Math.max(0, Math.min(0xffff, t.window)), 14);
  opts.copy(h, 20);
  const payload = t.payload ?? Buffer.alloc(0);
  h.writeUInt16BE(checksum(pseudo(src, dst, PROTO_TCP, h.length + payload.length), h, payload), 16);
  return Buffer.concat([h, payload]);
}

/** Sequence-number arithmetic (mod 2^32). */
export const seqAdd = (a: number, n: number) => (a + n) >>> 0;
export const seqDiff = (a: number, b: number) => ((a - b) | 0);
