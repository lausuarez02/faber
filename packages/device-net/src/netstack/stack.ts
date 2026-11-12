// The device netstack: the sandbox LAN an emulated board's network card is plugged into.
//
//   emulated NIC (QEMU open_eth, ...) ── Ethernet frames ──► Netstack ──► DeviceNet gateway
//
// It plays the router (10.0.2.2: ARP, DHCP, DNS server address, ICMP echo), a small switch between
// several boards on the same run (frames for another board's MAC, broadcasts and multicasts are
// forwarded), the far end of every TCP connection a device opens (each one becomes a gateway
// flow to the address the device dialled, which the sandbox DNS made a fake IP, so the gateway
// knows the host name), and the Wi-Fi access point for firmware built with Jumper's Wi-Fi shim
// (wifi.ts). It has no policy: what a device may reach is the gateway's decision.
import type { Duplex } from "node:stream";
import type { NetEventDraft } from "../log.ts";
import { DhcpServer, parseDhcp } from "./dhcp.ts";
import {
  ACK,
  BROADCAST,
  buildArp,
  buildEth,
  buildIcmpEchoReply,
  buildIp4,
  buildTcp,
  buildUdp,
  ETH_ARP,
  ETH_IPV4,
  ETH_JUMPER,
  macParse,
  macStr,
  parseArp,
  parseEth,
  parseIp4,
  parseTcp,
  parseUdp,
  PROTO_ICMP,
  PROTO_TCP,
  PROTO_UDP,
  RST,
  SYN,
  seqAdd,
  type Mac,
} from "./packets.ts";
import { TcpConn } from "./tcp.ts";
import { AUTH_OPEN, AUTH_WPA2_PSK, bssidFor, decideJoin, decodeWifi, encodeWifi, WIFI_REASON, type AccessPoint, type WifiMsg, type WifiState } from "./wifi.ts";

/** What the netstack needs from the gateway (DeviceNet implements it). */
export interface NetstackGateway {
  udp(dstIp: string, dstPort: number, payload: Buffer): Buffer | undefined;
  /** Round 14: answer a multicast DNS question (a ".local" name), or stay silent like mDNS does. */
  mdns?(payload: Buffer): Buffer | undefined;
  connect(dst: { ip: string; port: number }): Duplex;
}

export interface NetstackOptions {
  gateway: NetstackGateway;
  /** The router / DNS address. Default 10.0.2.2 (the same as QEMU's user networking). */
  gatewayIp?: string;
  netmask?: string;
  /** First DHCP address. Default 10.0.2.15. */
  firstHost?: string;
  /** Networks in range (jumper.json network.wifi). Empty: any SSID joins. */
  aps?: AccessPoint[];
  rssi?: number;
  /** DER of the sandbox CA, sent to firmware with the Wi-Fi shim so its TLS trusts the sandbox. */
  caDer?: Buffer;
  /** Netstack events (Wi-Fi joins, DHCP leases) for the network log. */
  log?: (e: NetEventDraft) => void;
  /** TCP retransmission timeout, ms. */
  rtoMs?: number;
}

/** One emulated network card plugged into the sandbox LAN. */
export interface NetPort {
  /** A frame from the device. */
  input(frame: Buffer): void;
  /** Unplug (the emulator stopped). */
  close(): void;
}

export interface NicSink {
  send(frame: Buffer): void;
}

export interface DeviceInfo {
  mac: string;
  ip?: string;
  /** The SSID the firmware joined through the Wi-Fi shim (undefined: wired, or not joined yet). */
  ssid?: string;
  chip?: string;
  shim: boolean;
  joined: boolean;
}

interface PortState {
  sink: NicSink;
  macs: Set<string>;
}

interface Device {
  mac: Mac;
  port: PortState;
  chip?: string;
  shim: boolean;
  ssid?: string;
  joined: boolean;
  /** Consecutive refused joins with the same reason (logged once, counted). */
  failStreak?: { reason: number; n: number };
}

const GW_MAC = macParse("02:4a:4d:50:00:01");

export class Netstack {
  readonly gatewayIp: string;
  readonly netmask: string;
  readonly dhcp: DhcpServer;
  readonly wifi: WifiState;
  private ports = new Set<PortState>();
  private devices = new Map<string, Device>();
  private conns = new Map<string, TcpConn>();
  private ipId = 1;
  private nConn = 0;
  private closed = false;

  constructor(private readonly o: NetstackOptions) {
    this.gatewayIp = o.gatewayIp ?? "10.0.2.2";
    this.netmask = o.netmask ?? "255.255.255.0";
    this.dhcp = new DhcpServer({ gateway: this.gatewayIp, netmask: this.netmask, firstHost: o.firstHost ?? "10.0.2.15", leaseSeconds: 7200 });
    this.wifi = { up: true, rssi: o.rssi ?? -55, aps: o.aps ?? [] };
  }

  get gatewayMac(): string {
    return macStr(GW_MAC);
  }

  /** Plug a network card in. `sink` sends frames to the device. */
  attach(sink: NicSink): NetPort {
    const port: PortState = { sink, macs: new Set() };
    this.ports.add(port);
    return {
      input: (f) => this.onFrame(port, f),
      close: () => {
        this.ports.delete(port);
        for (const m of port.macs) this.devices.delete(m);
      },
    };
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map((d) => ({ mac: macStr(d.mac), ip: this.dhcp.leaseOf(d.mac), ssid: d.ssid, chip: d.chip, shim: d.shim, joined: d.joined }));
  }

  // ------------------------------------------------------------ Wi-Fi control (from Jumper)

  /** Wi-Fi in range or not (wifi_drop fault). Joined shim devices are told the link is lost. */
  setWifiUp(up: boolean): void {
    if (this.wifi.up === up) return;
    this.wifi.up = up;
    if (!up) {
      for (const d of this.devices.values()) {
        if (!d.shim || !d.joined) continue;
        d.joined = false;
        this.sendWifi(d, [{ verb: "lost", args: { reason: String(WIFI_REASON.BEACON_TIMEOUT) } }]);
      }
      this.log({ kind: "wifi", source: "fault", summary: "Wi-Fi dropped: every board lost its access point (beacon timeout); open connections are gone" });
    } else {
      this.log({ kind: "wifi", source: "sandbox", summary: "Wi-Fi back: boards can join again (the firmware reconnects on its own if it retries)" });
    }
  }

  /** Signal strength the firmware reads (WiFi.RSSI()); joined devices get it at once. */
  setRssi(dbm: number): void {
    this.wifi.rssi = Math.round(dbm);
    for (const d of this.devices.values()) if (d.shim && d.joined) this.sendWifi(d, [{ verb: "rssi", args: { v: String(this.wifi.rssi) } }]);
  }

  setAccessPoints(aps: AccessPoint[]): void {
    this.wifi.aps = aps;
  }

  close(): void {
    this.closed = true;
    for (const c of [...this.conns.values()]) c.reset();
    this.conns.clear();
    this.ports.clear();
  }

  // ------------------------------------------------------------ frames

  private log(e: NetEventDraft): void {
    this.o.log?.(e);
  }

  private onFrame(port: PortState, frame: Buffer): void {
    if (this.closed) return;
    const e = parseEth(frame);
    if (!e) return;
    const src = macStr(e.src);
    if (!(e.src[0]! & 1) && !port.macs.has(src)) {
      port.macs.add(src);
      if (!this.devices.has(src)) this.devices.set(src, { mac: Buffer.from(e.src), port, shim: false, joined: false });
    }
    const dev = this.devices.get(src);
    const multicast = (e.dst[0]! & 1) === 1;
    // The switch: another board's MAC, or a broadcast / multicast every board should see.
    if (multicast || !e.dst.equals(GW_MAC)) {
      for (const p of this.ports) {
        if (p === port) continue;
        if (multicast || p.macs.has(macStr(e.dst))) p.sink.send(frame);
      }
      if (!multicast) return;
    }
    if (e.type === ETH_JUMPER) {
      if (dev) this.onWifi(dev, decodeWifi(e.payload));
      return;
    }
    // A board with the Wi-Fi shim only talks once joined; a wired board (no shim) needs Wi-Fi "up".
    if (!dev || !this.wifi.up || (dev.shim && !dev.joined)) return;
    if (e.type === ETH_ARP) this.onArp(dev, e.payload);
    else if (e.type === ETH_IPV4) this.onIp(dev, e.payload);
  }

  private sendIp(dev: Device, dstMac: Mac, src: string, dst: string, proto: number, payload: Buffer): void {
    if (this.closed) return;
    // Nothing reaches a device whose link is down (frames in flight are lost, as on real Wi-Fi).
    if (!this.wifi.up || (dev.shim && !dev.joined)) return;
    this.ipId = (this.ipId + 1) & 0xffff;
    dev.port.sink.send(buildEth(dstMac, GW_MAC, ETH_IPV4, buildIp4(src, dst, proto, payload, this.ipId)));
  }

  private onArp(dev: Device, p: Buffer): void {
    const a = parseArp(p);
    if (!a || a.op !== 1) return;
    if (a.tpa === this.gatewayIp) dev.port.sink.send(buildEth(a.sha, GW_MAC, ETH_ARP, buildArp(2, GW_MAC, this.gatewayIp, a.sha, a.spa)));
  }

  private inLan(ip: string): boolean {
    const m = this.netmask.split(".").map(Number);
    const a = ip.split(".").map(Number);
    const g = this.gatewayIp.split(".").map(Number);
    return a.every((x, i) => (x & m[i]!) === (g[i]! & m[i]!));
  }

  private onIp(dev: Device, p: Buffer): void {
    const ip = parseIp4(p);
    if (!ip || ip.fragment) return;
    if (ip.proto === PROTO_UDP) {
      const u = parseUdp(ip.payload);
      if (!u) return;
      if (u.dstPort === 67) return this.onDhcp(dev, u.payload);
      // Round 14: a ".local" lookup (mDNS, 224.0.0.251:5353) for a host the project opted in is answered
      // by the sandbox (unicast to the asking port, as RFC 6762 answers a one-shot query).
      if (ip.dst === "224.0.0.251" && u.dstPort === 5353 && u.srcPort !== 5353) {
        const reply = this.o.gateway.mdns?.(Buffer.from(u.payload));
        if (reply) this.sendIp(dev, dev.mac, this.gatewayIp, ip.src, PROTO_UDP, buildUdp(this.gatewayIp, ip.src, 5353, u.srcPort, reply));
        return;
      }
      // Broadcasts and multicasts (mDNS, SSDP, ...) stay on the LAN; the switch already forwarded them.
      if (ip.dst === "255.255.255.255" || ip.dst.endsWith(".255") || Number(ip.dst.split(".")[0]) >= 224) return;
      const reply = this.o.gateway.udp(ip.dst, u.dstPort, Buffer.from(u.payload));
      if (reply) this.sendIp(dev, dev.mac, ip.dst, ip.src, PROTO_UDP, buildUdp(ip.dst, ip.src, u.dstPort, u.srcPort, reply));
      return;
    }
    if (ip.proto === PROTO_ICMP) {
      const r = buildIcmpEchoReply(ip.payload);
      if (r && (ip.dst === this.gatewayIp || ip.dst.startsWith("198.18.") || ip.dst.startsWith("198.19."))) this.sendIp(dev, dev.mac, ip.dst, ip.src, PROTO_ICMP, r);
      return;
    }
    if (ip.proto === PROTO_TCP) this.onTcp(dev, ip.src, ip.dst, ip.payload);
  }

  private onDhcp(dev: Device, payload: Buffer): void {
    const m = parseDhcp(payload);
    if (!m) return;
    const r = this.dhcp.handle(m);
    if (r.event === "ack" && r.ip) this.log({ kind: "dhcp", source: "sandbox", summary: `DHCP ${r.ip} for ${macStr(m.chaddr)}${dev.ssid ? ` on "${dev.ssid}"` : ""} (router and DNS ${this.gatewayIp})` });
    else if (r.event?.startsWith("nak")) this.log({ kind: "dhcp", source: "sandbox", summary: `DHCP ${r.event}` });
    if (!r.reply || this.closed) return;
    if (!this.wifi.up || (dev.shim && !dev.joined)) return;
    this.ipId = (this.ipId + 1) & 0xffff;
    dev.port.sink.send(buildEth(BROADCAST, GW_MAC, ETH_IPV4, buildIp4(this.gatewayIp, "255.255.255.255", PROTO_UDP, buildUdp(this.gatewayIp, "255.255.255.255", 67, 68, r.reply), this.ipId)));
  }

  private onTcp(dev: Device, src: string, dst: string, p: Buffer): void {
    const t = parseTcp(p);
    if (!t) return;
    const key = `${src}:${t.srcPort}>${dst}:${t.dstPort}`;
    let c = this.conns.get(key);
    const emit = (s: { seq: number; ack: number; flags: number; window: number; mss?: number; payload?: Buffer }) =>
      this.sendIp(dev, dev.mac, dst, src, PROTO_TCP, buildTcp(dst, src, { srcPort: t.dstPort, dstPort: t.srcPort, ...s }));
    if (!c) {
      if (t.flags & RST) return;
      if (!(t.flags & SYN) || t.flags & ACK) {
        // No such connection (the sandbox restarted, or Wi-Fi dropped it): reset, like a router would.
        emit(t.flags & ACK ? { seq: t.ack, ack: 0, flags: RST, window: 0 } : { seq: 0, ack: seqAdd(t.seq, t.payload.length || 1), flags: RST | ACK, window: 0 });
        return;
      }
      if (this.inLan(dst) && dst !== this.gatewayIp) return;
      const n = this.nConn++;
      c = new TcpConn({ emit, iss: (0x4a000000 + n * 0x00100000) >>> 0, onClosed: () => this.conns.delete(key), ...(this.o.rtoMs ? { rtoMs: this.o.rtoMs } : {}) });
      this.conns.set(key, c);
      c.open(t);
      const conn = c;
      // The gateway flow starts with the handshake, so a refused host resets right away.
      conn.attach(this.o.gateway.connect({ ip: dst, port: t.dstPort }));
      return;
    }
    c.input(t);
  }

  // ------------------------------------------------------------ Wi-Fi control (from the firmware)

  private sendWifi(dev: Device, msgs: WifiMsg[]): void {
    if (this.closed) return;
    dev.port.sink.send(buildEth(dev.mac, GW_MAC, ETH_JUMPER, encodeWifi(msgs)));
  }

  private apRecord(ssid: string, ap?: AccessPoint): Record<string, string> {
    return {
      ssid,
      bssid: bssidFor(ssid),
      channel: String(ap?.channel ?? 6),
      rssi: String(ap?.rssi ?? this.wifi.rssi),
      auth: String(ap ? (ap.password === "" ? AUTH_OPEN : AUTH_WPA2_PSK) : AUTH_WPA2_PSK),
    };
  }

  private onWifi(dev: Device, msgs: WifiMsg[]): void {
    for (const m of msgs) {
      if (m.verb === "hello") {
        dev.shim = true;
        dev.chip = m.args.chip;
        this.log({ kind: "wifi", source: "sandbox", summary: `${m.args.chip ?? "board"} (${macStr(dev.mac)}) has Jumper's Wi-Fi shim: WiFi.begin() joins the sandbox network` });
      } else if (m.verb === "connect") {
        dev.shim = true;
        const ssid = m.args.ssid ?? "";
        const d = decideJoin(this.wifi, ssid, m.args.pass ?? "");
        if (d.ok) {
          const retries = dev.failStreak?.n ?? 0;
          dev.failStreak = undefined;
          dev.joined = true;
          dev.ssid = ssid;
          const ap = this.wifi.aps.find((a) => a.ssid === ssid);
          const out: WifiMsg[] = [{ verb: "connected", args: this.apRecord(ssid, ap) }];
          if (this.o.caDer) out.push({ verb: "ca", args: { der: this.o.caDer.toString("hex") } });
          this.sendWifi(dev, out);
          this.log({ kind: "wifi", source: "sandbox", summary: `joined "${ssid}" (RSSI ${ap?.rssi ?? this.wifi.rssi} dBm)${retries ? ` after ${retries} refused attempt${retries > 1 ? "s" : ""}` : ""}` });
        } else {
          dev.joined = false;
          this.sendWifi(dev, [{ verb: "failed", args: { reason: String(d.reason), after_ms: d.reason === WIFI_REASON.NO_AP_FOUND ? "2000" : "1000" } }]);
          // The firmware retries every couple of seconds: log the first refusal, count the rest.
          if (dev.failStreak && dev.failStreak.reason === d.reason) dev.failStreak.n++;
          else {
            dev.failStreak = { reason: d.reason!, n: 1 };
            this.log({ kind: "wifi", source: this.wifi.up ? "sandbox" : "fault", summary: `could not join "${ssid}" (reason ${d.reason}; later retries are counted, not logged)`, why: d.why, fix: d.fix });
          }
        }
      } else if (m.verb === "disconnect") {
        if (dev.joined) this.log({ kind: "wifi", source: "sandbox", summary: `left "${dev.ssid ?? ""}" (WiFi.disconnect())` });
        dev.joined = false;
      } else if (m.verb === "scan") {
        const aps = this.wifi.up ? (this.wifi.aps.length ? this.wifi.aps : [{ ssid: "JumperNet" }]) : [];
        this.sendWifi(dev, [...aps.map((a) => ({ verb: "ap", args: this.apRecord(a.ssid, a as AccessPoint) })), { verb: "scan_done", args: { n: String(aps.length) } }]);
        this.log({ kind: "wifi", source: this.wifi.up ? "sandbox" : "fault", summary: `scan: ${aps.length ? aps.map((a) => `"${a.ssid}"`).join(", ") : "no networks (Wi-Fi is down)"}` });
      }
    }
  }
}
