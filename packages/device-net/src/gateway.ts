// The device network gateway: the one place an emulated board's packets leave the simulation.
// Backends (QEMU slirp / open_eth, Renode's network, the ESP-01 AT part) hand it what the device
// does at the transport level: DNS and other UDP datagrams, and TCP flows to (ip, port). It knows
// nothing about the chip, and nothing about what an API is for.
//
// For each TCP flow it decides by policy (offline / mock / internet + allow list), then looks at
// the first bytes: TLS is terminated with the sandbox CA ("inspect") or forwarded untouched
// ("passthrough"); the plaintext is HTTP (incl. WebSocket upgrades), MQTT, or raw bytes. Mocks win,
// then recorded cassettes, then the real internet for allow-listed hosts. Secrets are injected at
// this edge and every log line is redacted.
import { duplexPair, type Duplex } from "node:stream";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { WebSocketServer } from "ws";
import type { SandboxCA } from "./ca.ts";
import { Cassette } from "./cassette.ts";
import { hostMatches, mockKey, validateMock, type AllowEntry, type Mock, type MqttMock, type NetworkConfig } from "./config.ts";
import { buildDnsAnswer, buildNtpReply, FakeIpPool, parseDnsQuery } from "./dns.ts";
import { NetLog, type NetEvent } from "./log.ts";
import { describeBody } from "./body.ts";
import { guardedLookup, LocalAddressRefused, parseLocalTarget } from "./local.ts";
import { listOperations, validateRequest } from "./openapi.ts";
import { answerHttp, MockBroker, MockSet, readBody, runWsMock } from "./mocks.ts";
import { readPackets, summarizePacket } from "./mqtt.ts";
import { expandSecrets, MissingSecretError, Redactor } from "./secrets.ts";
import { FrameReader, opName } from "./ws-frames.ts";
import { relaySpecFrom } from "./relay.ts";
import { authorize, RateLimiter, RelayError, sha256Hex, SIM_DEVICE_TOKEN, SIM_RELAY_HOST, TOKEN_HEADER, type RelayTarget } from "./relay/relay-core.mjs";

export interface Clock {
  /** ms since the network started (virtual time when a backend drives it). */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Unix ms the device sees for NTP. */
  wallMs?(): number;
}

export interface Upstream {
  host: string;
  port: number;
  /** Extra CA to trust for this upstream (tests use a local server). */
  ca?: string;
  /** Round 14: an allow entry's "to" decides the scheme (http to a local dev server behind an https name). */
  protocol?: "http:" | "https:";
  /** Round 14: resolve with the local-address guard (unset for a test's fixed upstream). */
  lookup?: ReturnType<typeof guardedLookup>;
}

export interface DeviceNetOptions {
  config: NetworkConfig;
  mocks?: Mock[];
  /** Secret values by name (loadSecrets(...).values). Never logged. */
  secrets?: Map<string, string>;
  ca: SandboxCA;
  /** Absolute path of the cassette file (network/cassettes/<name>.json). */
  cassetteFile?: string;
  clock?: Clock;
  /** Where an allowed host is really reached (default: itself). Tests point it at a local server. */
  upstream?: (host: string, port: number) => Upstream;
}

export type Fault =
  | { kind: "wifi_drop" }
  | { kind: "latency"; ms: number }
  | { kind: "http_error"; status: number; host?: string; path?: string; count?: number }
  | { kind: "timeout"; host?: string }
  | { kind: "dns_fail"; host?: string }
  /** Weak Wi-Fi signal: the RSSI the firmware reads (default -85 dBm). Traffic is not slowed; add a latency fault for that. */
  | { kind: "weak_signal"; rssi?: number };

interface Decision {
  ok: boolean;
  /** Where answers come from: the sandbox (mocks / cassette) or the real host. */
  internet?: AllowEntry;
  why?: string;
  fix?: string;
}

interface FlowCtx {
  host: string;
  port: number;
  tls: "inspect" | "passthrough" | "none";
  decision: Decision;
  /** Round 13: the request came through the sandbox relay (relay.sandbox.jumper/<host>/<path>). */
  via?: "relay";
}

/** What the sandbox relay decided for one request: the target's flow, or the relay's own answer. */
type RelayUnwrap = { ctx: FlowCtx; device: string; maxBody: number } | { error: RelayError };

/** Public time servers firmware asks for by name (configTime, SNTP); the sandbox answers NTP itself. */
const NTP_HOST = /^((\d+|[a-z]{2,3})\.)?(pool\.ntp\.org|[a-z0-9-]+\.pool\.ntp\.org)$|^time\.(google|cloudflare|windows|apple|nist|facebook)\.com$|^time\.nist\.gov$|^(ntp|time)\d?\.[a-z0-9-]+\.(com|org|net|gov)$/;

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const HTTP_START = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

/** Make a stream.Duplex look enough like a net.Socket for node:http and ws. */
function socketish(d: Duplex, remote = "10.0.2.15"): Duplex {
  const s = d as Duplex & Record<string, unknown>;
  s.setTimeout ??= () => s;
  s.setNoDelay ??= () => s;
  s.setKeepAlive ??= () => s;
  s.remoteAddress ??= remote;
  s.remotePort ??= 49152;
  return d;
}

function peek(s: Duplex): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const done = (b?: Buffer) => {
      s.off("data", onData);
      s.off("end", onEnd);
      s.off("close", onEnd);
      resolve(b);
    };
    const onData = (b: Buffer) => {
      s.pause();
      s.unshift(b);
      done(b);
    };
    const onEnd = () => done(undefined);
    s.on("data", onData);
    s.once("end", onEnd);
    s.once("close", onEnd);
    s.resume();
  });
}

export class DeviceNet {
  readonly redactor: Redactor;
  readonly log: NetLog;
  readonly pool = new FakeIpPool();
  readonly mocks: MockSet;
  readonly cassette?: Cassette;
  faults: Fault[] = [];
  private brokers = new Map<MqttMock, MockBroker>();
  private flows = new Set<Duplex>();
  private ctx = new WeakMap<object, FlowCtx>();
  private httpServer: http.Server;
  private wss = new WebSocketServer({ noServer: true });
  private clock: Clock;
  private secrets: Map<string, string>;
  private faultListeners = new Set<(faults: Fault[]) => void>();
  private relayLimiter: RateLimiter | undefined;
  private relayTokens: Promise<string> | undefined;

  constructor(private opts: DeviceNetOptions) {
    this.secrets = opts.secrets ?? new Map();
    this.redactor = new Redactor(this.secrets);

    this.mocks = new MockSet([...(opts.mocks ?? [])]);
    if (opts.cassetteFile) this.cassette = new Cassette(opts.cassetteFile, this.redactor);
    const t0 = Date.now();
    this.clock = opts.clock ?? { now: () => Date.now() - t0, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), wallMs: () => Date.now() };
    this.log = new NetLog(this.redactor, 2000, () => this.clock.now());
    this.httpServer = http.createServer((req, res) => void this.onRequest(req, res));
    this.httpServer.on("upgrade", (req, socket, head) => void this.onUpgrade(req, socket as Duplex, head));
  }

  get config(): NetworkConfig {
    return this.opts.config;
  }

  /** Change mode / allow list / secrets policy live (set_network). Open flows keep their decision. */
  setConfig(c: NetworkConfig): void {
    this.opts.config = c;
    this.relayLimiter = undefined;
    this.log.push({ kind: "fault", source: "sandbox", summary: `network mode is now ${c.mode}${c.allow.length ? ` (allow: ${c.allow.map((a) => a.host).join(", ")})` : ""}` });
  }

  /** The sandbox CA (its public certificate goes to firmware built with the Wi-Fi shim). */
  get ca(): SandboxCA {
    return this.opts.ca;
  }

  /** Called whenever faults change (the netstack follows wifi_drop and weak_signal). */
  onFaults(cb: (faults: Fault[]) => void): () => void {
    this.faultListeners.add(cb);
    return () => void this.faultListeners.delete(cb);
  }

  // ---------------------------------------------------------------- policy

  private fault<K extends Fault["kind"]>(kind: K, host?: string): Extract<Fault, { kind: K }> | undefined {
    return this.faults.find((f) => f.kind === kind && (!("host" in f) || !f.host || (host !== undefined && hostMatches(f.host, host)))) as Extract<Fault, { kind: K }> | undefined;
  }

  /** Round 14: NTP time set by a test (unix ms at the network clock's atMs), else wall time. */
  private ntpClock: { unixMs: number; atMs: number } | undefined;

  /** Round 14: the time NTP gives the device from now on (unix ms, advancing with the network clock); undefined: wall time. */
  setClock(unixMs: number | undefined): void {
    this.ntpClock = unixMs === undefined ? undefined : { unixMs, atMs: this.clock.now() };
    if (unixMs !== undefined) this.log.push({ kind: "udp", port: 123, source: "sandbox", summary: `clock set: NTP answers ${new Date(unixMs).toISOString()} from now on` });
  }

  /** May the device reach host:port, and who answers? */
  decide(host: string, port?: number): Decision {
    const { mode, allow } = this.opts.config;
    const mockHint = `add a mock for ${host} (add_mock_api {"host": "${host}", "path": "/...", "response": {...}} or network/mocks.json)`;
    if (mode === "offline") {
      return { ok: false, why: `the project's network mode is offline: the device has Wi-Fi but no host answers (this is how a test checks the no-internet path)`, fix: `set jumper.json network.mode to "mock" and ${mockHint}, or to "internet" with {"host": "${host}"} in network.allow` };
    }
    // Round 13: the simulator plays the project's API relay (same allow list, token and limits as the real one).
    if (host === SIM_RELAY_HOST) return { ok: true };
    const sandbox = this.mocks.hasHost(host) || this.cassette?.hasHost(host);
    const entry = allow.find((a) => hostMatches(a.host, host));
    if (mode === "internet" && entry) {
      const ports = entry.ports ?? [443, 80];
      if (port !== undefined && !ports.includes(port) && !sandbox) {
        return { ok: false, why: `${host} is allowed only on port(s) ${ports.join(", ")}, the device used ${port}`, fix: `add ${port} to "ports" of the ${entry.host} entry in network.allow` };
      }
      return { ok: true, internet: entry };
    }
    // Round 14: a host opted in to a service on this computer ("local": true, "to") works in mock mode
    // too: nothing leaves this computer. Mocks and cassettes still answer first.
    if (mode === "mock" && entry?.local && entry.to) return { ok: true, internet: entry };
    if (sandbox) return { ok: true };
    if (mode === "mock") {
      return { ok: false, why: `${host} has no mock and no recorded cassette, and mode "mock" never reaches the internet`, fix: `${mockHint}, or set network.mode "internet" and add {"host": "${host}"} to network.allow` };
    }
    return { ok: false, why: `${host} is not on the project's allow list (jumper.json network.allow), so the sandbox refuses it`, fix: `if the device should reach it, add {"host": "${host}"} to network.allow; otherwise ${mockHint}` };
  }

  private blocked(d: Omit<NetEvent, "seq" | "t_ms" | "kind" | "summary">, why: string, fix: string, what: string): NetEvent {
    return this.log.push({ ...d, kind: "blocked", source: "sandbox", why, fix, summary: `blocked: ${what}` });
  }

  // ---------------------------------------------------------------- DNS / UDP

  /** DNS for a name: the sandbox address, or undefined (NXDOMAIN) with the reason logged. */
  resolve(name: string): string | undefined {
    const host = name.toLowerCase();
    if (this.fault("wifi_drop")) {
      this.blocked({ host }, "Wi-Fi is down (wifi_drop fault)", "clear the fault (inject_network_fault clear) or test that the firmware retries", `DNS ${host}`);
      return undefined;
    }
    if (this.fault("dns_fail", host)) {
      this.blocked({ host, source: "fault" }, `a dns_fail fault is active for ${host}`, "clear the fault to restore DNS", `DNS ${host}`);
      return undefined;
    }
    // Round 14: time servers are part of the sandbox (it answers NTP itself, with the test's clock or
    // this computer's), so configTime("pool.ntp.org") works in mock mode too; offline has no internet.
    if (NTP_HOST.test(host) && this.opts.config.mode !== "offline" && !this.opts.config.allow.some((a) => hostMatches(a.host, host))) {
      const ip = this.pool.ipFor(host);
      this.log.push({ kind: "dns", host, source: "sandbox", summary: `DNS ${host} → ${ip} (the sandbox's NTP server)` });
      return ip;
    }
    const d = this.decide(host);
    if (!d.ok) {
      this.blocked({ host }, d.why!, d.fix!, `DNS ${host} → NXDOMAIN`);
      return undefined;
    }
    const ip = this.pool.ipFor(host);
    this.log.push({ kind: "dns", host, source: d.internet ? "internet" : "mock", summary: `DNS ${host} → ${ip}` });
    return ip;
  }

  /**
   * Round 14: a multicast DNS question from the device ("mystar.local", how firmware finds a computer
   * on the LAN). Answered only for a host the sandbox serves (an allow entry with "local" / "to", or a
   * mock); otherwise silence, as on a LAN where nobody has that name.
   */
  mdns(payload: Buffer): Buffer | undefined {
    const q = parseDnsQuery(payload);
    if (!q || (q.qtype !== 1 && q.qtype !== 255) || !q.name.endsWith(".local")) return undefined;
    if (!this.decide(q.name).ok) {
      this.log.push({ kind: "dns", host: q.name, source: "sandbox", summary: `mDNS ${q.name}: no answer`, why: `nothing on the sandbox LAN is called ${q.name}`, fix: `add {"host": "${q.name}", "local": true, "to": "http://127.0.0.1:<port>"} to network.allow (a service on this computer), or a mock for ${q.name}` });
      return undefined;
    }
    const ip = this.resolve(q.name);
    return ip ? buildDnsAnswer({ ...q, qtype: 1 }, ip) : undefined;
  }

  /** A UDP datagram from the device. Returns the reply datagram (DNS on 53, SNTP on 123) or undefined. */
  udp(dstIp: string, dstPort: number, payload: Buffer): Buffer | undefined {
    if (dstPort === 53) {
      const q = parseDnsQuery(payload);
      if (!q) return undefined;
      const ip = q.qtype === 1 || q.qtype === 28 ? this.resolve(q.name) : undefined;
      return buildDnsAnswer(q, ip);
    }
    if (dstPort === 123) {
      const set = this.ntpClock;
      const ms = set ? set.unixMs + (this.clock.now() - set.atMs) : (this.clock.wallMs?.() ?? Date.now());
      this.log.push({ kind: "udp", port: 123, source: "sandbox", summary: `NTP → ${new Date(ms).toISOString()}` });
      return buildNtpReply(payload, ms);
    }
    const host = this.pool.hostFor(dstIp) ?? dstIp;
    this.blocked({ host, port: dstPort, bytes_out: payload.length }, `UDP to port ${dstPort} is not routed by the sandbox (only DNS and NTP are)`, "use TCP (HTTP, WebSocket, MQTT) for APIs; raw UDP to the internet is a gap of this prototype", `UDP ${host}:${dstPort}`);
    return undefined;
  }

  // ---------------------------------------------------------------- TCP

  /** Open a TCP flow from the device: returns the device's end of the connection. */
  connect(dst: { ip: string; port: number }): Duplex {
    const [dev, gw] = duplexPair();
    socketish(dev);
    // Either end going away closes the other, like a TCP reset.
    dev.on("close", () => gw.destroy());
    gw.on("close", () => dev.destroy());
    void this.attach(socketish(gw), dst);
    return dev;
  }

  /** Serve a flow whose device end is elsewhere (a socket from a QEMU / Renode backend). */
  async attach(sock: Duplex, dst: { ip: string; port: number }): Promise<void> {
    this.flows.add(sock);
    sock.on("close", () => this.flows.delete(sock));
    sock.on("error", () => {});
    const host = this.pool.hostFor(dst.ip) ?? dst.ip;
    if (this.fault("wifi_drop")) {
      this.blocked({ host, port: dst.port }, "Wi-Fi is down (wifi_drop fault)", "clear the fault or test that the firmware reconnects", `TCP ${host}:${dst.port}`);
      sock.destroy();
      return;
    }
    if (dst.ip === "0.0.0.0") {
      this.blocked({ host, port: dst.port }, "the firmware connected to 0.0.0.0, which is what a failed DNS lookup leaves behind (see the blocked DNS entry before this one)", "check the result of the lookup / connect in the firmware before using the connection, and make the host reachable (a mock, or the allow list in internet mode)", `TCP 0.0.0.0:${dst.port}`);
      sock.destroy();
      return;
    }
    const decision = this.decide(host, dst.port);
    if (!decision.ok) {
      const direct = !this.pool.hostFor(dst.ip);
      this.blocked({ host, port: dst.port }, direct ? `the device connected to the address ${dst.ip} without looking a name up; ${decision.why}` : decision.why!, direct ? `use the host name in the firmware (the sandbox works by name); ${decision.fix}` : decision.fix!, `TCP ${host}:${dst.port}`);
      sock.destroy();
      return;
    }
    const lat = this.fault("latency");
    if (lat) await this.clock.sleep(lat.ms);
    const first = await peek(sock);
    if (!first) return;
    const sandboxAnswers = this.mocks.hasHost(host) || this.cassette?.hasHost(host);
    if (first[0] === 0x16) {
      if (decision.internet?.tls === "passthrough" && !sandboxAnswers) {
        this.passthrough(sock, host, dst.port, decision.internet);
        return;
      }
      const ctx = await this.opts.ca.contextFor(host);
      const t = new tls.TLSSocket(sock as unknown as net.Socket, { isServer: true, secureContext: ctx });
      sock.resume();
      // A handshake that never completes is almost always the firmware refusing the sandbox CA.
      let secured = false;
      let failed = false;
      t.once("secure", () => (secured = true));
      const handshakeFailed = (e?: Error) => {
        if (secured || failed) return;
        failed = true;
        this.log.push({ kind: "connect", host, port: dst.port, tls: "inspect", source: "sandbox", summary: `TLS handshake with the device failed${e ? `: ${e.message}` : " (the device closed the connection)"}`, why: "the firmware did not accept the Jumper sandbox certificate for this host, or closed during the handshake", fix: "build with Jumper's ESP32 image (its simulation build trusts the sandbox CA next to the sketch's own CAs), or set tls passthrough for this host in network.allow" });
      };
      t.on("error", handshakeFailed);
      t.on("close", () => handshakeFailed());
      const app = await peek(t);
      if (!app) {
        // Some TLS stacks finish the handshake and only then check the certificate, and close.
        if (secured && !failed) {
          this.log.push({ kind: "connect", host, port: dst.port, tls: "inspect", source: "sandbox", summary: `TLS session with ${host} closed by the device before any request`, why: "the device closed right after the handshake; usually its TLS rejected the Jumper sandbox certificate after checking it", fix: "build with Jumper's ESP32 image (its simulation build trusts the sandbox CA), or set tls passthrough for this host in network.allow" });
        }
        return;
      }
      this.serveApp(t, app, { host, port: dst.port, tls: "inspect", decision });
      return;
    }
    this.serveApp(sock, first, { host, port: dst.port, tls: "none", decision });
  }

  private serveApp(s: Duplex, first: Buffer, ctx: FlowCtx): void {
    this.ctx.set(s, ctx);
    if (HTTP_START.test(first.subarray(0, 8).toString("latin1"))) {
      this.httpServer.emit("connection", s);
      s.resume();
      return;
    }
    if (first[0] === 0x10) {
      const mock = this.mocks.mqtt(ctx.host);
      if (mock) return this.serveMqtt(s, mock, ctx);
      if (ctx.decision.internet) return this.forwardRaw(s, ctx, "mqtt");
    }
    if (ctx.decision.internet) return this.forwardRaw(s, ctx, "connect");
    this.blocked({ host: ctx.host, port: ctx.port, tls: ctx.tls }, `${ctx.host}:${ctx.port} is mocked, but the device spoke a protocol the mocks do not answer (first bytes ${first.subarray(0, 8).toString("hex")})`, "mocks answer HTTP, WebSocket and MQTT; for another protocol allow the real host (internet mode)", `TCP ${ctx.host}:${ctx.port}`);
    s.destroy();
  }

  private ctxOf(s: object): FlowCtx {
    return this.ctx.get(s)!;
  }

  // ---------------------------------------------------------------- HTTP

  /**
   * Where a forwarded flow goes: a test's fixed upstream, an allow entry's "to" (a service on this
   * computer), or the host itself, resolved with the local-address guard (round 14).
   */
  private upstream(host: string, port: number, entry?: AllowEntry): Upstream {
    const fixed = this.opts.upstream?.(host, port);
    if (fixed) return fixed;
    if (entry?.to) {
      const t = parseLocalTarget(entry.to);
      return { host: t.host, port: t.port, protocol: t.protocol, lookup: guardedLookup(true) };
    }
    return { host, port, lookup: guardedLookup(entry?.local === true) };
  }

  /** The why / fix of a failed upstream connection (a refused local address says how to opt in). */
  private upstreamError(ctx: { host: string; port: number }, err: Error, up: Upstream): { why: string; fix: string } {
    if (err instanceof LocalAddressRefused) return { why: err.why, fix: err.fix };
    const where = up.protocol ? `${up.protocol}//${up.host}:${up.port} (network.allow "to" of ${ctx.host})` : `the real ${ctx.host}:${ctx.port}`;
    return {
      why: `${where} could not be reached from this machine (${err.message})`,
      fix: up.protocol ? `start the service on ${up.host}:${up.port} (is it running? is the port right?), or change "to" in the ${ctx.host} entry of network.allow` : "check this computer's internet connection, or record a cassette while online and replay it",
    };
  }

  /** The headers sent upstream: device headers ({{secret:X}} expanded), plus the allow entry's templates. */
  private upstreamHeaders(req: IncomingMessage, ctx: FlowCtx): { headers: Record<string, string>; used: string[] } {
    const entry = ctx.decision.internet!;
    const allowed = entry.secrets ?? [];
    const used: string[] = [];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k)) continue;
      const r = expandSecrets(Array.isArray(v) ? v.join(", ") : v, this.secrets, allowed, ctx.host);
      used.push(...r.used);
      headers[k] = r.value;
    }
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      const r = expandSecrets(v, this.secrets, allowed, ctx.host);
      used.push(...r.used);
      headers[k.toLowerCase()] = r.value;
    }
    headers.host = ctx.port === 443 || ctx.port === 80 ? ctx.host : `${ctx.host}:${ctx.port}`;
    return { headers, used: [...new Set(used)] };
  }

  /**
   * Round 13: a request to the sandbox relay. The same checks as the real relay (relay-core.mjs
   * authorize: device token, rate, allow list, ports, size), then the request continues as one to the
   * target host, so mocks, cassettes, faults, secrets and the log work as for a direct request.
   */
  private async relayUnwrap(req: IncomingMessage, _ctx: FlowCtx): Promise<RelayUnwrap> {
    const spec = relaySpecFrom(this.opts.config, "simulator");
    this.relayLimiter ??= new RateLimiter(spec.limits.requests_per_minute, () => this.clock.now());
    this.relayTokens ??= sha256Hex(SIM_DEVICE_TOKEN).then((h) => `simulator:${h}`);
    let a: Awaited<ReturnType<typeof authorize>>;
    try {
      const header = (n: string) => {
        const v = req.headers[n];
        return v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
      };
      a = await authorize({ method: req.method ?? "GET", url: req.url ?? "/", header }, { spec, env: { RELAY_DEVICE_TOKENS: await this.relayTokens }, limiter: this.relayLimiter });
    } catch (e) {
      if (e instanceof RelayError) return { error: e };
      throw e;
    }
    delete req.headers[TOKEN_HEADER];
    const t: RelayTarget = a.target;
    req.url = t.path;
    req.headers.host = t.port === 443 || t.port === 80 ? t.host : `${t.host}:${t.port}`;
    return { ctx: { host: t.host, port: t.port, tls: t.scheme === "https" ? "inspect" : "none", decision: this.decide(t.host, t.port), via: "relay" }, device: a.device, maxBody: a.limits.max_request_bytes };
  }

  private relayRefused(e: RelayError, method: string, path: string, write: (status: number, headers: Record<string, string>, body: string) => void): void {
    const body = JSON.stringify(e.body());
    write(e.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...e.headers }, body);
    this.log.push({ kind: "http", host: SIM_RELAY_HOST, method, path, status: e.status, source: "sandbox", via: "relay", why: e.why, fix: e.fix, summary: `relay refused ${method} ${path} → ${e.status} ${e.code}` });
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let ctx = this.ctxOf(req.socket);
    let maxBody = Infinity;
    if (ctx.host === SIM_RELAY_HOST) {
      const r = await this.relayUnwrap(req, ctx);
      if ("error" in r) {
        req.resume();
        return this.relayRefused(r.error, req.method ?? "GET", req.url ?? "/", (st, h, b) => {
          res.writeHead(st, h);
          res.end(b);
        });
      }
      ctx = r.ctx;
      maxBody = r.maxBody;
    }
    const t0 = this.clock.now();
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const e = this.log.push({ kind: "http", host: ctx.host, port: ctx.port, tls: ctx.tls, method, path, open: true, ...(ctx.via ? { via: ctx.via } : {}), summary: `${ctx.via ? "relay → " : ""}${method} ${ctx.host}${path}` });
    const finish = (status: number, source: NetEvent["source"], bytes_in: number, extra: Partial<NetEvent> = {}) =>
      this.log.update(e, { status, source, bytes_in, duration_ms: Math.round(this.clock.now() - t0), open: false, summary: `${ctx.via ? "relay → " : ""}${method} ${ctx.host}${path} → ${status} (${source}, ${bytes_in} B)`, ...extra });
    res.on("close", () => {
      if (e.open) this.log.update(e, { open: false, duration_ms: Math.round(this.clock.now() - t0), summary: `${method} ${ctx.host}${path} → closed before an answer` });
    });

    // Round 14: the body first (a device sends it before it waits for an answer), so the log says
    // what every request carried, faults included; tests check it (content type, fields, parts).
    const reqBody = await readBody(req);
    e.bytes_out = reqBody.length;
    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined;
    const bodyInfo = describeBody(contentType, reqBody);
    if (contentType || bodyInfo) this.log.update(e, { ...(contentType ? { content_type: contentType } : {}), ...(bodyInfo ? { body: bodyInfo } : {}) });
    if (this.fault("timeout", ctx.host)) {
      this.log.update(e, { source: "fault", summary: `${method} ${ctx.host}${path} → no answer (timeout fault)` });
      return; // never answer; the device's own timeout fires
    }
    const err = this.faults.find((f): f is Extract<Fault, { kind: "http_error" }> => f.kind === "http_error" && (!f.host || hostMatches(f.host, ctx.host)) && (!f.path || path.startsWith(f.path)) && (f.count === undefined || f.count > 0));
    if (err) {
      if (err.count !== undefined) err.count--;
      const body = Buffer.from(JSON.stringify({ error: `injected fault: HTTP ${err.status}` }));
      res.writeHead(err.status, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      finish(err.status, "fault", body.length);
      return;
    }
    const mock = this.mocks.http(ctx.host, method, path);
    if (ctx.via && reqBody.length > maxBody) {
      const err = new RelayError(413, "request-too-large", `the request body is ${reqBody.length} bytes, over the relay's limit of ${maxBody}`, "send less (or stream it in parts), or raise network.relay.max_request_kb in jumper.json");
      const body = Buffer.from(JSON.stringify(err.body()));
      res.writeHead(413, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      finish(413, "sandbox", body.length, { why: err.why, fix: err.fix });
      return;
    }
    if (ctx.via && !ctx.decision.ok && !mock) {
      const body = Buffer.from(JSON.stringify({ error: "blocked", why: ctx.decision.why, fix: ctx.decision.fix }));
      res.writeHead(502, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      finish(502, "sandbox", body.length, { why: ctx.decision.why!, fix: ctx.decision.fix! });
      return;
    }
    if (mock && "openapi" in mock) {
      // Round 14: an OpenAPI mock checks the request against the operation before answering.
      const { mock: om, hit } = mock.openapi;
      if (!om.spec_doc) {
        const why = `the OpenAPI mock for ${om.host} has no loaded spec (${typeof om.spec === "string" ? om.spec : "inline"})`;
        const fix = "add it with add_mock_api or network/mocks.json in the project, so Jumper reads the spec file";
        const body = Buffer.from(JSON.stringify({ error: "mock spec not loaded", why, fix }));
        res.writeHead(500, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
        finish(500, "mock", body.length, { why, fix });
        return;
      }
      const problems = om.validate === false ? [] : validateRequest(om, hit, path, contentType, reqBody, bodyInfo);
      if (problems.length) {
        const why = `${method} ${path} does not match the API's ${hit.key} operation (${hit.method.toUpperCase()} ${hit.template}): ${problems.slice(0, 6).join("; ")}`;
        const fix = "change what the firmware sends to match the OpenAPI spec (or fix the spec if the API really takes it)";
        const body = Buffer.from(JSON.stringify({ error: "request does not match the API", operation: hit.key, problems, fix }));
        res.writeHead(400, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
        finish(400, "mock", body.length, { why, fix });
        return;
      }
      const n = await answerHttp(mock, res, (ms) => this.clock.sleep(ms));
      finish(res.statusCode, "mock", n);
      return;
    }
    if (mock) {
      const n = await answerHttp(mock, res, (ms) => this.clock.sleep(ms));
      finish(res.statusCode, "mock", n);
      return;
    }
    const rec = this.cassette?.find(method, ctx.host, path, reqBody);
    if (rec) {
      const body = Buffer.from(rec.response.body_b64, "base64");
      res.writeHead(rec.response.status, { ...rec.response.headers, "content-length": String(body.length) });
      res.end(body);
      finish(rec.response.status, "cassette", body.length);
      return;
    }
    const api = this.mocks.openapi(ctx.host);
    if (api && !ctx.decision.internet) {
      const ops = api.spec_doc ? listOperations(api.spec_doc as Parameters<typeof listOperations>[0]) : [];
      const why = `${method} ${path} is not an operation of the API's OpenAPI spec for ${ctx.host}${ops.length ? ` (it has ${ops.slice(0, 10).join(", ")}${ops.length > 10 ? ", …" : ""})` : ""}`;
      const fix = "call one of those operations from the firmware (check the method, the path and the base path), or add the operation to the spec";
      const body = Buffer.from(JSON.stringify({ error: "no such operation", why, fix }));
      res.writeHead(404, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      finish(404, "mock", body.length, { why, fix });
      return;
    }
    if (!ctx.decision.internet) {
      const why = `${ctx.host} is mocked, but no mock matches ${method} ${path} and the cassette has no recording of it`;
      const fix = `add a mock {"host": "${ctx.host}", "method": "${method}", "path": "${path.split("?")[0]}", "response": {...}}`;
      const body = Buffer.from(JSON.stringify({ error: "no mock for this request", why, fix }));
      res.writeHead(404, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      finish(404, "sandbox", body.length, { why, fix });
      return;
    }
    await this.forwardHttp(req, res, reqBody, ctx, e, finish);
  }

  private async forwardHttp(req: IncomingMessage, res: ServerResponse, reqBody: Buffer, ctx: FlowCtx, e: NetEvent, finish: (s: number, src: NetEvent["source"], n: number, x?: Partial<NetEvent>) => void): Promise<void> {
    let sent: { headers: Record<string, string>; used: string[] };
    try {
      sent = this.upstreamHeaders(req, ctx);
    } catch (err) {
      if (!(err instanceof MissingSecretError)) throw err;
      const body = Buffer.from(JSON.stringify({ error: `secret ${err.secret} not available`, why: err.why, fix: err.fix }));
      res.writeHead(502, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      finish(502, "sandbox", body.length, { why: err.why, fix: err.fix });
      return;
    }
    sent.headers["content-length"] = String(reqBody.length);
    const up = this.upstream(ctx.host, ctx.port, ctx.decision.internet);
    const mod = (up.protocol ? up.protocol === "http:" : ctx.tls === "none") ? http : https;
    const upReq = mod.request({ host: up.host, port: up.port, method: req.method, path: req.url, headers: sent.headers, servername: ctx.host, ...(up.ca ? { ca: up.ca } : {}), ...(up.lookup ? { lookup: up.lookup } : {}) });
    this.log.update(e, { headers: sent.headers, secrets_used: sent.used, source: "internet" });
    upReq.on("error", (err) => {
      const { why, fix } = this.upstreamError(ctx, err, up);
      if (!res.headersSent) {
        const body = Buffer.from(JSON.stringify({ error: "upstream unreachable", why, fix }));
        res.writeHead(502, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
      } else res.destroy();
      finish(502, "internet", 0, { why, fix });
    });
    upReq.on("response", (upRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
      const status = upRes.statusCode ?? 502;
      res.writeHead(status, headers);
      const parts: Buffer[] = [];
      let n = 0;
      upRes.on("data", (c: Buffer) => {
        n += c.length;
        if (this.opts.config.record) parts.push(c);
      });
      upRes.on("end", () => {
        if (this.opts.config.record && this.cassette) {
          this.cassette.record({ method: req.method ?? "GET", host: ctx.host, path: req.url ?? "/", body: reqBody, headerNames: Object.keys(sent.headers) }, { status, headers: upRes.headers, body: Buffer.concat(parts) });
          this.cassette.save();
        }
        finish(status, "internet", n);
      });
      // The device never sees a secret value, even if the upstream echoes one back.
      upRes.pipe(this.redactor.maskStream()).pipe(res);
    });
    upReq.end(reqBody);
  }

  // ---------------------------------------------------------------- WebSocket

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let ctx = this.ctxOf(socket);
    if (ctx.host === SIM_RELAY_HOST) {
      const r = await this.relayUnwrap(req, ctx);
      if ("error" in r) {
        return this.relayRefused(r.error, "WS", req.url ?? "/", (st, h, b) => {
          socket.end(`HTTP/1.1 ${st} ${http.STATUS_CODES[st] ?? "Error"}\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join("")}connection: close\r\n\r\n${b}`);
        });
      }
      ctx = r.ctx;
      this.ctx.set(socket, ctx);
      if (!ctx.decision.ok && !this.mocks.ws(ctx.host, req.url ?? "/")) {
        const body = JSON.stringify({ error: "blocked", why: ctx.decision.why, fix: ctx.decision.fix });
        socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        this.log.push({ kind: "ws", host: ctx.host, port: ctx.port, path: req.url ?? "/", status: 502, source: "sandbox", via: "relay", why: ctx.decision.why!, fix: ctx.decision.fix!, summary: `relay → WebSocket ${ctx.host}${req.url ?? "/"} → blocked` });
        return;
      }
    }
    const path = req.url ?? "/";
    const t0 = this.clock.now();
    const e = this.log.push({ kind: "ws", host: ctx.host, port: ctx.port, tls: ctx.tls, path, open: true, ...(ctx.via ? { via: ctx.via } : {}), summary: `${ctx.via ? "relay → " : ""}WebSocket ${ctx.host}${path}` });
    const sample = (dir: "in" | "out", d: string | Buffer) => this.log.sample(e, `${dir === "out" ? "device →" : "→ device"} ${typeof d === "string" ? `text ${JSON.stringify(d.length > 64 ? `${d.slice(0, 64)}…` : d)}` : `binary ${d.length} B`}`, dir, typeof d === "string" ? Buffer.byteLength(d) : d.length);
    const closeEntry = (source: NetEvent["source"]) => {
      const f = e.frames;
      this.log.update(e, { open: false, source, duration_ms: Math.round(this.clock.now() - t0), summary: `WebSocket ${ctx.host}${path}: ${f?.out ?? 0} frames out (${f?.bytes_out ?? 0} B), ${f?.in ?? 0} in (${f?.bytes_in ?? 0} B)` });
    };
    const mock = this.mocks.ws(ctx.host, path);
    if (mock) {
      this.wss.handleUpgrade(req, socket as unknown as net.Socket, head, (ws) => {
        this.log.update(e, { status: 101, source: "mock" });
        ws.on("close", () => closeEntry("mock"));
        runWsMock(mock, ws, (ms) => this.clock.sleep(ms), { frame: (dir, d) => sample(dir, d) });
      });
      return;
    }
    if (!ctx.decision.internet) {
      const why = `${ctx.host} is mocked, but no WebSocket mock matches ${path}`;
      const fix = `add {"kind": "ws", "host": "${ctx.host}", "path": "${path.split("?")[0]}", "on_message": [...]}`;
      socket.end(`HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ why, fix })}`);
      this.log.update(e, { status: 404, open: false, source: "sandbox", why, fix });
      return;
    }
    // Forward the upgrade to the real host, then relay frames both ways, summarizing them.
    let sent: { headers: Record<string, string>; used: string[] };
    try {
      sent = this.upstreamHeaders(req, ctx);
    } catch (err) {
      if (!(err instanceof MissingSecretError)) throw err;
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n`);
      this.log.update(e, { status: 502, open: false, source: "sandbox", why: err.why, fix: err.fix });
      return;
    }
    sent.headers.connection = "Upgrade";
    sent.headers.upgrade = "websocket";
    const up = this.upstream(ctx.host, ctx.port, ctx.decision.internet);
    const mod = (up.protocol ? up.protocol === "http:" : ctx.tls === "none") ? http : https;
    const upReq = mod.request({ host: up.host, port: up.port, path, headers: sent.headers, servername: ctx.host, ...(up.ca ? { ca: up.ca } : {}), ...(up.lookup ? { lookup: up.lookup } : {}) });
    this.log.update(e, { headers: sent.headers, secrets_used: sent.used, source: "internet" });
    upReq.on("upgrade", (upRes, upSock, upHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      this.log.update(e, { status: 101 });
      const fromDev = new FrameReader();
      const toDev = new FrameReader();
      const note = (dir: "in" | "out", fs: ReturnType<FrameReader["push"]>) => {
        for (const f of fs) this.log.sample(e, `${dir === "out" ? "device →" : "→ device"} ${opName(f.opcode)} ${f.length} B${f.opcode === 1 ? ` ${JSON.stringify(f.preview.toString("utf8"))}` : ""}`, dir, f.length);
      };
      if (upHead.length) {
        note("in", toDev.push(upHead));
        socket.write(upHead);
      }
      if (head.length) {
        note("out", fromDev.push(head));
        upSock.write(head);
      }
      socket.on("data", (c: Buffer) => {
        note("out", fromDev.push(c));
        upSock.write(c);
      });
      upSock.on("data", (c: Buffer) => {
        note("in", toDev.push(c));
        socket.write(c);
      });
      const end = () => {
        socket.destroy();
        upSock.destroy();
        if (e.open) closeEntry("internet");
      };
      socket.on("close", end);
      upSock.on("close", end);
      socket.on("error", end);
      upSock.on("error", end);
    });
    upReq.on("response", (r) => {
      socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nconnection: close\r\n\r\n`);
      this.log.update(e, { status: r.statusCode, open: false, source: "internet" });
    });
    upReq.on("error", (err) => {
      socket.destroy();
      this.log.update(e, { status: 502, open: false, source: "internet", why: `could not reach ${ctx.host}: ${err.message}`, fix: "check this computer's connection, or mock the stream" });
    });
    upReq.end();
  }

  // ---------------------------------------------------------------- MQTT and raw

  private serveMqtt(s: Duplex, mock: MqttMock, ctx: FlowCtx): void {
    let broker = this.brokers.get(mock);
    if (!broker) this.brokers.set(mock, (broker = new MockBroker(mock)));
    const t0 = this.clock.now();
    const e = this.log.push({ kind: "mqtt", host: ctx.host, port: ctx.port, tls: ctx.tls, source: "mock", open: true, summary: `MQTT ${ctx.host}:${ctx.port}` });
    const conn = broker.attach(
      (b) => s.write(b),
      (line, dir, bytes) => this.log.sample(e, line, dir, bytes),
    );
    s.on("data", (c: Buffer) => conn.feed(c));
    s.resume();
    s.on("close", () => {
      conn.close();
      const f = e.frames;
      this.log.update(e, { open: false, duration_ms: Math.round(this.clock.now() - t0), summary: `MQTT ${ctx.host}:${ctx.port}: ${f?.out ?? 0} packets out, ${f?.in ?? 0} in` });
    });
  }

  /** Relay bytes to the real host (re-encrypting when TLS was inspected). MQTT packets are summarized. */
  private forwardRaw(s: Duplex, ctx: FlowCtx, kind: "mqtt" | "connect"): void {
    const up = this.upstream(ctx.host, ctx.port, ctx.decision.internet);
    const t0 = this.clock.now();
    const e = this.log.push({ kind, host: ctx.host, port: ctx.port, tls: ctx.tls, source: "internet", open: true, summary: `${kind === "mqtt" ? "MQTT" : "TCP"} ${ctx.host}:${ctx.port}` });
    const look = up.lookup ? { lookup: up.lookup } : {};
    const upSock: net.Socket = (up.protocol ? up.protocol === "https:" : ctx.tls === "inspect") ? tls.connect({ host: up.host, port: up.port, servername: ctx.host, ...(up.ca ? { ca: up.ca } : {}), ...look }) : net.connect({ port: up.port, host: up.host, ...look });
    let bufOut: Buffer = Buffer.alloc(0);
    let bufIn: Buffer = Buffer.alloc(0);
    const count = (dir: "in" | "out", c: Buffer) => {
      if (kind !== "mqtt") {
        if (dir === "out") e.bytes_out = (e.bytes_out ?? 0) + c.length;
        else e.bytes_in = (e.bytes_in ?? 0) + c.length;
        return;
      }
      const r = readPackets(Buffer.concat([dir === "out" ? bufOut : bufIn, c]));
      if (dir === "out") bufOut = r.rest;
      else bufIn = r.rest;
      for (const p of r.packets) this.log.sample(e, summarizePacket(p, dir), dir, p.body.length + 2);
    };
    s.on("data", (c: Buffer) => {
      count("out", c);
      upSock.write(c);
    });
    upSock.on("data", (c: Buffer) => {
      count("in", c);
      s.write(this.redactor.maskBytes(c));
    });
    s.resume();
    const end = () => {
      s.destroy();
      upSock.destroy();
      if (e.open) this.log.update(e, { open: false, duration_ms: Math.round(this.clock.now() - t0) });
    };
    s.on("close", end);
    upSock.on("close", end);
    upSock.on("error", (err) => {
      this.log.update(e, this.upstreamError(ctx, err, up));
      end();
    });
  }

  /** TLS passthrough: bytes go end to end; only host, port, bytes and timing are known. */
  private passthrough(s: Duplex, host: string, port: number, entry?: AllowEntry): void {
    const up = this.upstream(host, port, entry);
    const t0 = this.clock.now();
    const e = this.log.push({ kind: "connect", host, port, tls: "passthrough", source: "internet", open: true, bytes_out: 0, bytes_in: 0, summary: `TLS passthrough ${host}:${port}` });
    const upSock = net.connect({ port: up.port, host: up.host, ...(up.lookup ? { lookup: up.lookup } : {}) });
    upSock.on("error", (err) => this.log.update(e, this.upstreamError({ host, port }, err, up)));
    s.on("data", (c: Buffer) => {
      e.bytes_out! += c.length;
      upSock.write(c);
    });
    upSock.on("data", (c: Buffer) => {
      e.bytes_in! += c.length;
      s.write(c);
    });
    s.resume();
    const end = () => {
      s.destroy();
      upSock.destroy();
      if (e.open) this.log.update(e, { open: false, duration_ms: Math.round(this.clock.now() - t0), summary: `TLS passthrough ${host}:${port}: ${e.bytes_out} B out, ${e.bytes_in} B in` });
    };
    s.on("close", end);
    upSock.on("close", end);
    upSock.on("error", end);
  }

  // ---------------------------------------------------------------- faults and lifecycle

  inject(f: Fault): string {
    this.faults.push({ ...f });
    this.log.push({ kind: "fault", source: "fault", summary: `fault on: ${JSON.stringify(f)}` });
    // Listeners first: the netstack takes the link down before the flows die, so their resets are lost like on real Wi-Fi.
    for (const l of this.faultListeners) l(this.faults);
    if (f.kind === "wifi_drop") for (const s of [...this.flows]) s.destroy();
    return f.kind;
  }

  scenarioMock(m: Mock): void {
    const v = validateMock(m);
    this.mocks.list = [v, ...this.mocks.list.filter((x) => mockKey(x) !== mockKey(v))];
  }

  setMocks(list: Mock[]): void {
    this.mocks.list = [...list];
  }

  clearFaults(): void {
    this.faults = [];
    this.log.push({ kind: "fault", source: "fault", summary: "faults cleared" });
    for (const l of this.faultListeners) l(this.faults);
  }

  close(): void {
    for (const s of [...this.flows]) s.destroy();
    this.wss.close();
    this.cassette?.save();
  }
}
