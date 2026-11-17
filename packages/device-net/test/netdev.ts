// A tiny test "device" on the sandbox LAN: speaks Ethernet frames like an emulated NIC would
// (DHCP client, ARP, DNS over UDP, a TCP client with in-order receive), so the netstack can be
// tested without an emulator. Not a general TCP stack: one connection at a time per call.
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import net from "node:net";
import { buildDnsQuery, parseDnsAnswerIp } from "../src/dns.ts";
import {
  ACK,
  BROADCAST,
  buildArp,
  buildEth,
  buildIp4,
  buildTcp,
  buildUdp,
  ETH_ARP,
  ETH_IPV4,
  ETH_FABWRIGHT,
  FIN,
  macParse,
  parseArp,
  parseEth,
  parseIp4,
  parseTcp,
  parseUdp,
  PROTO_TCP,
  PROTO_UDP,
  PSH,
  RST,
  SYN,
  seqAdd,
  type Mac,
} from "../src/netstack/packets.ts";
import { decodeWifi, encodeWifi, type WifiMsg } from "../src/netstack/wifi.ts";

export class TestDevice extends EventEmitter {
  ip = "0.0.0.0";
  gwMac?: Mac;
  readonly mac: Mac;
  private send: (f: Buffer) => void = () => {};
  frames: Buffer[] = [];
  wifi: WifiMsg[] = [];

  constructor(mac = "02:00:00:00:00:15") {
    super();
    this.mac = macParse(mac);
  }

  /** Plug into a frame sink pair. */
  plug(input: (f: Buffer) => void): { send: (f: Buffer) => void } {
    this.send = input;
    return { send: (f) => this.onFrame(f) };
  }

  /** Plug into a frame server over TCP (QEMU stream framing). */
  async plugTcp(port: number): Promise<net.Socket> {
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    this.send = (f) => {
      const h = Buffer.alloc(4);
      h.writeUInt32BE(f.length);
      sock.write(Buffer.concat([h, f]));
    };
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        this.onFrame(buf.subarray(4, 4 + n));
        buf = buf.subarray(4 + n);
      }
    });
    return sock;
  }

  private onFrame(f: Buffer): void {
    this.frames.push(f);
    const e = parseEth(f);
    if (!e) return;
    if (e.type === ETH_FABWRIGHT) {
      const msgs = decodeWifi(e.payload);
      this.wifi.push(...msgs);
      this.emit("wifi", msgs);
      return;
    }
    if (e.type === ETH_ARP) {
      const a = parseArp(e.payload);
      if (a?.op === 2) {
        this.gwMac = Buffer.from(a.sha);
        this.emit("arp", a);
      }
      return;
    }
    if (e.type !== ETH_IPV4) return;
    const ip = parseIp4(e.payload);
    if (!ip) return;
    if (ip.proto === PROTO_UDP) {
      const u = parseUdp(ip.payload);
      if (u) this.emit("udp", { src: ip.src, ...u });
    } else if (ip.proto === PROTO_TCP) {
      const t = parseTcp(ip.payload);
      if (t) this.emit("tcp", { src: ip.src, ...t });
    }
  }

  sendWifi(msgs: WifiMsg[]): void {
    this.send(buildEth(BROADCAST, this.mac, ETH_FABWRIGHT, encodeWifi(msgs)));
  }

  waitWifi(verb: string, ms = 2000): Promise<WifiMsg> {
    const have = this.wifi.find((m) => m.verb === verb);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${verb} control frame`)), ms);
      const on = (msgs: WifiMsg[]) => {
        const m = msgs.find((x) => x.verb === verb);
        if (m) {
          clearTimeout(t);
          this.off("wifi", on);
          resolve(m);
        }
      };
      this.on("wifi", on);
    });
  }

  private next<T>(ev: string, pred: (x: T) => boolean, ms = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off(ev, on);
        reject(new Error(`timeout waiting for ${ev}`));
      }, ms);
      const on = (x: T) => {
        if (!pred(x)) return;
        clearTimeout(t);
        this.off(ev, on);
        resolve(x);
      };
      this.on(ev, on);
    });
  }

  private dhcpPacket(type: number, xid: number, requested?: string): Buffer {
    const b = Buffer.alloc(240);
    b[0] = 1;
    b[1] = 1;
    b[2] = 6;
    b.writeUInt32BE(xid, 4);
    this.mac.copy(b, 28);
    b.writeUInt32BE(0x63825363, 236);
    const opts = [53, 1, type];
    if (requested) opts.push(50, 4, ...requested.split(".").map(Number), 54, 4, 10, 0, 2, 2);
    opts.push(255);
    return Buffer.concat([b, Buffer.from(opts)]);
  }

  private sendUdp(dst: string, sport: number, dport: number, payload: Buffer, dstMac: Mac = this.gwMac ?? BROADCAST): void {
    this.send(buildEth(dstMac, this.mac, ETH_IPV4, buildIp4(this.ip, dst, PROTO_UDP, buildUdp(this.ip, dst, sport, dport, payload), 1)));
  }

  async dhcp(): Promise<string> {
    const xid = 0x1234;
    const waitOffer = this.next<{ dstPort: number; payload: Buffer }>("udp", (u) => u.dstPort === 68 && u.payload[0] === 2);
    this.sendUdp("255.255.255.255", 68, 67, this.dhcpPacket(1, xid), BROADCAST);
    const offer = await waitOffer;
    const yi = [...offer.payload.subarray(16, 20)].join(".");
    const waitAck = this.next<{ dstPort: number; payload: Buffer }>("udp", (u) => u.dstPort === 68 && u.payload.includes(Buffer.from([53, 1, 5])));
    this.sendUdp("255.255.255.255", 68, 67, this.dhcpPacket(3, xid, yi), BROADCAST);
    await waitAck;
    this.ip = yi;
    const waitArp = this.next("arp", () => true);
    this.send(buildEth(BROADCAST, this.mac, ETH_ARP, buildArp(1, this.mac, this.ip, Buffer.alloc(6), "10.0.2.2")));
    await waitArp;
    return yi;
  }

  async dns(name: string): Promise<{ rcode: number; ip?: string }> {
    const id = Math.floor(Math.random() * 65535);
    const wait = this.next<{ srcPort: number; payload: Buffer }>("udp", (u) => u.srcPort === 53 && u.payload.readUInt16BE(0) === id);
    this.sendUdp("10.0.2.2", 40000, 53, buildDnsQuery(id, name));
    return parseDnsAnswerIp((await wait).payload);
  }

  /** Open a TCP connection as a byte stream (resolves after the handshake; rejects on RST). */
  openStream(dst: string, port: number, opts: { window?: number; ms?: number } = {}): Promise<Duplex & { segments: number; reset: boolean }> {
    const sport = 50000 + Math.floor(Math.random() * 10000);
    let seq = 1000;
    let ack = 0;
    const win = opts.window ?? 8192;
    const out = (flags: number, payload?: Buffer) =>
      this.send(buildEth(this.gwMac!, this.mac, ETH_IPV4, buildIp4(this.ip, dst, PROTO_TCP, buildTcp(this.ip, dst, { srcPort: sport, dstPort: port, seq, ack, flags, window: win, ...(payload ? { payload } : {}), ...(flags & SYN ? { mss: 1460 } : {}) }), 2)));
    let finSent = false;
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _e, cb) {
        for (let i = 0; i < chunk.length; i += 1400) {
          const part = chunk.subarray(i, i + 1400);
          out(ACK | PSH, part);
          seq = seqAdd(seq, part.length);
        }
        cb();
      },
      destroy(err, cb) {
        // Like a socket closed by the application: the far end sees a reset.
        if (!finSent && !(stream as { reset?: boolean }).reset) out(RST | ACK);
        cb(err);
      },
      final(cb) {
        if (!finSent) {
          finSent = true;
          out(FIN | ACK);
          seq = seqAdd(seq, 1);
        }
        cb();
      },
    }) as Duplex & { segments: number; reset: boolean };
    stream.segments = 0;
    stream.reset = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tcp handshake timeout")), opts.ms ?? 5000);
      let open = false;
      const on = (t: { dstPort: number; seq: number; flags: number; payload: Buffer }) => {
        if (t.dstPort !== sport) return;
        if (t.flags & RST) {
          this.off("tcp", on);
          stream.reset = true;
          if (!open) {
            clearTimeout(timer);
            reject(Object.assign(new Error("connection reset"), { reset: true }));
          } else stream.destroy();
          return;
        }
        if (t.flags & SYN) {
          ack = seqAdd(t.seq, 1);
          seq = seqAdd(seq, 1);
          out(ACK);
          open = true;
          clearTimeout(timer);
          resolve(stream);
          return;
        }
        if (t.payload.length && t.seq === ack) {
          ack = seqAdd(ack, t.payload.length);
          stream.segments++;
          stream.push(Buffer.from(t.payload));
          out(ACK);
        }
        if (t.flags & FIN) {
          ack = seqAdd(t.seq, t.payload.length + 1);
          out(ACK);
          this.off("tcp", on);
          stream.push(null);
          if (!finSent) stream.end();
        }
      };
      this.on("tcp", on);
      out(SYN);
    });
  }

  /** Open a TCP connection, send `data`, collect everything until the far end closes. */
  async tcp(dst: string, port: number, data: Buffer | string, opts: { window?: number; ms?: number } = {}): Promise<{ got: Buffer; reset: boolean; segments: number }> {
    let s: Awaited<ReturnType<TestDevice["openStream"]>>;
    try {
      s = await this.openStream(dst, port, opts);
    } catch (e) {
      if ((e as { reset?: boolean }).reset) return { got: Buffer.alloc(0), reset: true, segments: 0 };
      throw e;
    }
    const chunks: Buffer[] = [];
    s.on("data", (c: Buffer) => chunks.push(c));
    if (Buffer.byteLength(data)) s.write(Buffer.from(data));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`tcp timeout; got ${Buffer.concat(chunks).length} B`)), opts.ms ?? 5000);
      s.on("end", () => (clearTimeout(t), resolve()));
      s.on("close", () => (clearTimeout(t), resolve()));
    });
    return { got: Buffer.concat(chunks), reset: s.reset, segments: s.segments };
  }
}
