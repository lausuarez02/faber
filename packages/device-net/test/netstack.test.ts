// The netstack between emulated network cards and the gateway, driven by a test device that
// speaks raw Ethernet frames (test/netdev.ts): DHCP, ARP, DNS, TCP to mocks (incl. TLS through the
// sandbox CA and a long body that needs several windows), blocked hosts, the Wi-Fi control channel
// (join, wrong password, unknown SSID, scan, drop, RSSI), and the same through the worker host.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxCA } from "../src/ca.ts";
import { parseMocks, parseNetworkConfig } from "../src/config.ts";
import { DeviceNet } from "../src/gateway.ts";
import { DeviceNetHost } from "../src/host.ts";
import { checksum, buildTcp, parseTcp, ACK, SYN } from "../src/netstack/packets.ts";
import { DhcpServer, parseDhcp } from "../src/netstack/dhcp.ts";
import { createNetstack, pemToDer } from "../src/netstack/lan.ts";
import { TcpConn } from "../src/netstack/tcp.ts";
import { decodeWifi, encodeWifi, decideJoin, bssidFor } from "../src/netstack/wifi.ts";
import { readNetwork } from "../src/tools.ts";
import { TestDevice } from "./netdev.ts";

let dir: string;
let ca: SandboxCA;
const BIG = "x".repeat(50_000);
const MOCKS = parseMocks({
  mocks: [
    { host: "api.weather.test", path: "/v1/now", response: { body: { temp_c: 21.5 } } },
    { host: "api.weather.test", path: "/v1/big", response: { body: BIG } },
  ],
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fabwright-netstack-"));
  ca = await SandboxCA.open(join(dir, "ca"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function lan(config: Record<string, unknown> = { mode: "mock" }) {
  const dn = new DeviceNet({ config: parseNetworkConfig(config), mocks: MOCKS, ca });
  const stack = createNetstack(dn, { rtoMs: 200 });
  const dev = new TestDevice();
  let port: ReturnType<typeof stack.attach>;
  const sink = dev.plug((f) => port.input(f));
  port = stack.attach(sink);
  return { dn, stack, dev };
}

describe("codecs", () => {
  it("computes the internet checksum over split buffers", () => {
    const a = Buffer.from([0x45, 0x00, 0x00, 0x1c, 0x00]);
    const b = Buffer.from([0x01, 0x40, 0x00, 0x40, 0x11]);
    expect(checksum(a, b)).toBe(checksum(Buffer.concat([a, b])));
  });

  it("round-trips a TCP segment with an MSS option", () => {
    const seg = buildTcp("10.0.2.15", "198.18.0.1", { srcPort: 5000, dstPort: 443, seq: 1, ack: 0, flags: SYN, window: 5760, mss: 1436 });
    const t = parseTcp(seg)!;
    expect(t).toMatchObject({ srcPort: 5000, dstPort: 443, flags: SYN, window: 5760, mss: 1436 });
  });

  it("encodes Wi-Fi control lines with odd SSIDs", () => {
    const msgs = decodeWifi(encodeWifi([{ verb: "connect", args: { ssid: "Café Wi-Fi 5=G%", pass: "a b" } }]));
    expect(msgs).toEqual([{ verb: "connect", args: { ssid: "Café Wi-Fi 5=G%", pass: "a b" } }]);
  });

  it("hands out stable DHCP leases in order of first sight", () => {
    const d = new DhcpServer({ gateway: "10.0.2.2", netmask: "255.255.255.0", firstHost: "10.0.2.15", leaseSeconds: 60 });
    expect(d.addressFor(Buffer.from("aaaaaaaaaaaa", "hex"))).toBe("10.0.2.15");
    expect(d.addressFor(Buffer.from("bbbbbbbbbbbb", "hex"))).toBe("10.0.2.16");
    expect(d.addressFor(Buffer.from("aaaaaaaaaaaa", "hex"))).toBe("10.0.2.15");
    expect(parseDhcp(Buffer.alloc(100))).toBeUndefined();
  });

  it("decides joins like an access point would", () => {
    const w = { up: true, rssi: -50, aps: [{ ssid: "Home", password: "secret12" }] };
    expect(decideJoin(w, "Home", "secret12").ok).toBe(true);
    expect(decideJoin(w, "Home", "nope")).toMatchObject({ ok: false, reason: 15 });
    expect(decideJoin(w, "Other", "x")).toMatchObject({ ok: false, reason: 201 });
    expect(decideJoin({ ...w, aps: [] }, "Anything", "")).toMatchObject({ ok: true });
    expect(decideJoin({ ...w, up: false }, "Home", "secret12")).toMatchObject({ ok: false, reason: 201 });
    expect(bssidFor("Home")).toMatch(/^02:4a(:[0-9a-f]{2}){4}$/);
  });
});

describe("TcpConn", () => {
  it("retransmits from the oldest unacked byte when the device drops a segment, and respects its window", async () => {
    const sent: Array<{ seq: number; len: number }> = [];
    const c = new TcpConn({ emit: (s) => sent.push({ seq: s.seq, len: s.payload?.length ?? 0 }), iss: 100, onClosed: () => {}, rtoMs: 30 });
    c.open({ srcPort: 1, dstPort: 2, seq: 5000, ack: 0, flags: SYN, window: 2000, mss: 1000, payload: Buffer.alloc(0) });
    const d = new PassThrough();
    c.attach(d);
    c.input({ srcPort: 1, dstPort: 2, seq: 5001, ack: 101, flags: ACK, window: 2000, payload: Buffer.alloc(0) });
    d.write(Buffer.alloc(3000, 7));
    await new Promise((r) => setTimeout(r, 5));
    // Window 2000, MSS 1000: two segments, then it waits.
    expect(sent.filter((s) => s.len).map((s) => s.seq)).toEqual([101, 1101]);
    // The device lost both; after the RTO the first comes again.
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.filter((s) => s.len).map((s) => s.seq).slice(2, 4)).toEqual([101, 1101]);
    c.input({ srcPort: 1, dstPort: 2, seq: 5001, ack: 2101, flags: ACK, window: 2000, payload: Buffer.alloc(0) });
    expect(sent.filter((s) => s.len).at(-1)).toEqual({ seq: 2101, len: 1000 });
    c.reset();
  });

  it("probes a zero window with one byte the device may keep, and goes on from its ACK (a slow reader)", async () => {
    const sent: Array<{ seq: number; len: number }> = [];
    const c = new TcpConn({ emit: (s) => sent.push({ seq: s.seq, len: s.payload?.length ?? 0 }), iss: 100, onClosed: () => {}, rtoMs: 20 });
    c.open({ srcPort: 1, dstPort: 2, seq: 5000, ack: 0, flags: SYN, window: 1000, mss: 1000, payload: Buffer.alloc(0) });
    const d = new PassThrough();
    c.attach(d);
    c.input({ srcPort: 1, dstPort: 2, seq: 5001, ack: 101, flags: ACK, window: 1000, payload: Buffer.alloc(0) });
    d.write(Buffer.alloc(2500, 7));
    await new Promise((r) => setTimeout(r, 5));
    // The device takes 1000 bytes and closes its window (it is busy playing audio, say).
    c.input({ srcPort: 1, dstPort: 2, seq: 5001, ack: 1101, flags: ACK, window: 0, payload: Buffer.alloc(0) });
    await new Promise((r) => setTimeout(r, 30));
    const probe = sent.filter((s) => s.len).at(-1)!;
    expect(probe).toEqual({ seq: 1101, len: 1 });
    // Its window opened meanwhile: it kept the probe byte and acknowledges it with room for more.
    c.input({ srcPort: 1, dstPort: 2, seq: 5001, ack: 1102, flags: ACK, window: 2000, payload: Buffer.alloc(0) });
    expect(sent.filter((s) => s.len).slice(-2)).toEqual([{ seq: 1102, len: 1000 }, { seq: 2102, len: 499 }]);
    c.input({ srcPort: 1, dstPort: 2, seq: 5001, ack: 2601, flags: ACK, window: 2000, payload: Buffer.alloc(0) });
    c.reset();
  });
});

describe("netstack + gateway", () => {
  it("gives a lease, answers ARP and DNS, and serves a mocked API over plain TCP", async () => {
    const { dn, dev, stack } = lan();
    expect(await dev.dhcp()).toBe("10.0.2.15");
    expect(dev.gwMac && [...dev.gwMac].map((b) => b.toString(16).padStart(2, "0")).join(":")).toBe(stack.gatewayMac);
    const a = await dev.dns("api.weather.test");
    expect(a).toEqual({ rcode: 0, ip: "198.18.0.1" });
    const r = await dev.tcp(a.ip!, 80, "GET /v1/now HTTP/1.1\r\nHost: api.weather.test\r\nConnection: close\r\n\r\n");
    expect(r.got.toString()).toContain('{"temp_c":21.5}');
    expect(r.reset).toBe(false);
    const kinds = readNetwork(dn).entries as Array<{ kind: string; summary: string }>;
    expect(kinds.some((e) => e.kind === "dhcp" && e.summary.includes("10.0.2.15"))).toBe(true);
    expect(kinds.some((e) => e.kind === "http" && e.summary.includes("200"))).toBe(true);
    stack.close();
  });

  it("streams a 50 kB body through the device's small window", async () => {
    const { dev, stack } = lan();
    await dev.dhcp();
    const { ip } = await dev.dns("api.weather.test");
    const r = await dev.tcp(ip!, 80, "GET /v1/big HTTP/1.1\r\nHost: api.weather.test\r\nConnection: close\r\n\r\n", { window: 2920 });
    expect(r.got.toString()).toContain(BIG.slice(0, 1000));
    expect(r.got.length).toBeGreaterThan(50_000);
    expect(r.segments).toBeGreaterThan(30);
    stack.close();
  });

  it("refuses a blocked host at DNS, and resets a direct connection with why and fix in the log", async () => {
    const { dn, dev, stack } = lan();
    await dev.dhcp();
    expect((await dev.dns("evil.example.test")).rcode).toBe(3);
    const r = await dev.tcp("93.184.216.34", 443, "");
    expect(r.reset).toBe(true);
    const blocked = dn.log.since(0).filter((e) => e.kind === "blocked");
    expect(blocked.length).toBe(2);
    expect(blocked[1]!.why).toContain("without looking a name up");
    expect(blocked[1]!.fix).toBeTruthy();
    stack.close();
  });

  it("terminates TLS with the sandbox CA for a device that trusts it, and the device refusing it is logged with a fix", async () => {
    const { dn, dev, stack } = lan();
    await dev.dhcp();
    const { ip } = await dev.dns("api.weather.test");
    const raw = await dev.openStream(ip!, 443);
    const t = tls.connect({ socket: raw as never, servername: "api.weather.test", ca: ca.certPem });
    const body = await new Promise<string>((resolve, reject) => {
      let got = "";
      t.on("secureConnect", () => t.write("GET /v1/now HTTP/1.1\r\nHost: api.weather.test\r\nConnection: close\r\n\r\n"));
      t.on("data", (c: Buffer) => (got += c.toString()));
      t.on("end", () => resolve(got));
      t.on("error", reject);
    });
    expect(body).toContain('{"temp_c":21.5}');
    // A device with only a public root CA refuses the sandbox certificate.
    const raw2 = await dev.openStream(ip!, 443);
    const t2 = tls.connect({ socket: raw2 as never, servername: "api.weather.test", ca: [] as never });
    await new Promise<void>((resolve) => t2.on("error", () => resolve()));
    raw2.destroy();
    await new Promise((r) => setTimeout(r, 300));
    const failed = dn.log.since(0).find((e) => e.kind === "connect" && e.tls === "inspect");
    expect(failed?.fix).toContain("sandbox CA");
    stack.close();
  });
});


describe("Wi-Fi control channel", () => {
  it("joins, sends the sandbox CA, scans, drops and restores, and follows weak_signal", async () => {
    const { dn, dev, stack } = lan({ mode: "mock", wifi: { ssid: "Home", password: "secret12" } });
    dev.sendWifi([{ verb: "hello", args: { chip: "esp32s3", shim: "1" } }]);
    dev.sendWifi([{ verb: "scan", args: {} }]);
    expect((await dev.waitWifi("scan_done")).args.n).toBe("1");
    expect(dev.wifi.find((m) => m.verb === "ap")!.args.ssid).toBe("Home");
    // A shim device cannot use the LAN before it joins.
    await expect(dev.dhcp()).rejects.toThrow(/timeout/);
    dev.sendWifi([{ verb: "connect", args: { ssid: "Home", pass: "wrong" } }]);
    expect((await dev.waitWifi("failed")).args.reason).toBe("15");
    dev.wifi = [];
    dev.sendWifi([{ verb: "connect", args: { ssid: "Home", pass: "secret12" } }]);
    const c = await dev.waitWifi("connected");
    expect(c.args).toMatchObject({ ssid: "Home", rssi: "-55" });
    const caMsg = await dev.waitWifi("ca");
    expect(Buffer.from(caMsg.args.der!, "hex").equals(pemToDer(ca.certPem))).toBe(true);
    expect(await dev.dhcp()).toBe("10.0.2.15");
    dn.inject({ kind: "weak_signal", rssi: -88 });
    expect((await dev.waitWifi("rssi")).args.v).toBe("-88");
    dev.wifi = [];
    dn.inject({ kind: "wifi_drop" });
    expect((await dev.waitWifi("lost")).args.reason).toBe("200");
    dev.wifi = [];
    dev.sendWifi([{ verb: "connect", args: { ssid: "Home", pass: "secret12" } }]);
    expect((await dev.waitWifi("failed")).args.reason).toBe("201");
    dev.wifi = [];
    dev.sendWifi([{ verb: "connect", args: { ssid: "Home", pass: "secret12" } }]);
    await new Promise((r) => setTimeout(r, 20));
    dn.clearFaults();
    dev.wifi = [];
    dev.sendWifi([{ verb: "connect", args: { ssid: "Home", pass: "secret12" } }]);
    expect((await dev.waitWifi("connected")).args.rssi).toBe("-55");
    const wifi = dn.log.since(0).filter((e) => e.kind === "wifi").map((e) => e.summary);
    expect(wifi.some((s) => s.includes("after 2 refused attempts"))).toBe(true);
    expect(wifi.filter((s) => s.startsWith("could not join")).length).toBe(2);
    expect(stack.list()[0]).toMatchObject({ shim: true, joined: true, chip: "esp32s3", ssid: "Home" });
    stack.close();
  });
});

describe("DeviceNetHost (worker thread)", () => {
  it("serves frames over TCP from its own thread, and the main thread reads the log synchronously", async () => {
    const host = await DeviceNetHost.start({ config: parseNetworkConfig({ mode: "mock" }), mocks: MOCKS, caDir: join(dir, "ca") });
    try {
      const dev = new TestDevice("02:00:00:00:00:21");
      const sock = await dev.plugTcp(host.framePort);
      expect(await dev.dhcp()).toBe("10.0.2.15");
      const { ip } = await dev.dns("api.weather.test");
      const r = await dev.tcp(ip!, 80, "GET /v1/now HTTP/1.1\r\nHost: api.weather.test\r\nConnection: close\r\n\r\n");
      expect(r.got.toString()).toContain("21.5");
      // Block this thread the way a lockstep emulator step does, then read: drain() sees it all.
      const until = Date.now() + 100;
      while (Date.now() < until) {
        /* busy */
      }
      host.drain();
      const out = readNetwork(host) as { entries: Array<{ kind: string; summary: string }> };
      expect(out.entries.some((e) => e.kind === "http" && e.summary.includes("→ 200"))).toBe(true);
      host.inject({ kind: "http_error", status: 503, host: "api.weather.test", count: 1 });
      host.mocks.upsert({ host: "api.weather.test", path: "/v2/now", response: { body: { v: 2 } } });
      await new Promise((r) => setTimeout(r, 50));
      const r2 = await dev.tcp(ip!, 80, "GET /v2/now HTTP/1.1\r\nHost: api.weather.test\r\nConnection: close\r\n\r\n");
      expect(r2.got.toString()).toContain("503");
      const r3 = await dev.tcp(ip!, 80, "GET /v2/now HTTP/1.1\r\nHost: api.weather.test\r\nConnection: close\r\n\r\n");
      expect(r3.got.toString()).toContain('{"v":2}');
      sock.destroy();
    } finally {
      await host.close();
    }
  });
});
