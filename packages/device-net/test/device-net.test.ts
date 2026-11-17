import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { SandboxCA } from "../src/ca.ts";
import { ConfigError, parseMocks, parseNetworkConfig, type Mock } from "../src/config.ts";
import { DeviceNet } from "../src/gateway.ts";
import { enc, readPackets, decodePublish } from "../src/mqtt.ts";
import { loadSecrets, Redactor } from "../src/secrets.ts";
import { addMockApi, checkRequest, factoryNetworkNotes, readNetwork } from "../src/tools.ts";
import { lookup, request, tlsTo, wsTo } from "./harness.ts";

const SECRET = "sk-test-0123456789abcdefSECRETVALUE";
let dir: string;
let ca: SandboxCA;
/** Stands in for the public internet: its own CA, so only tests trust it. */
let publicCa: SandboxCA;
let upstream: https.Server;
let upstreamPort: number;
let upstreamHits: Array<{ path: string; auth?: string }> = [];

const MOCKS: Mock[] = parseMocks({
  mocks: [
    { host: "api.weather.test", method: "GET", path: "/v1/now", response: { status: 200, body: { temp_c: 21.5, sky: "clear" } } },
    // A streamed HTTP body: 10 chunks, 40 ms apart.
    { host: "api.weather.test", method: "GET", path: "/v1/stream", response: { chunks: Array.from({ length: 10 }, (_, i) => ({ data: `data: ${i}\n\n`, delay_ms: 40 })) } },
    // A generic WebSocket stream: on "start", 50 binary frames of 3200 B (any binary payload; audio-sized here), 20 ms apart, then a text "done".
    { kind: "ws", host: "stream.example.test", path: "/v1/stream", on_open: [{ text: '{"ready":true}' }], on_message: [{ match: "start", send: [{ bytes: 3200, delay_ms: 20, repeat: 50 }, { text: '{"done":true}' }] }] },
    { kind: "mqtt", host: "mqtt.example.test", on_publish: [{ topic: "devices/+/telemetry", reply: [{ topic: "devices/d1/cmd", payload: '{"led":"on"}' }] }], retained: [{ topic: "devices/d1/config", payload: '{"interval_s":30}' }] },
  ],
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fabwright-net-"));
  ca = await SandboxCA.open(join(dir, "ca"));
  publicCa = await SandboxCA.open(join(dir, "public-ca"));
  upstream = https.createServer({ SNICallback: (name, cb) => publicCa.contextFor(name).then((c) => cb(null, c), cb) }, (req, res) => {
    upstreamHits.push({ path: req.url!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    // An API that (badly) echoes the key back: the device must still never see it.
    const body = JSON.stringify({ ok: true, path: req.url, echoed_auth: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    res.end(body);
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => {
    upstreamHits.push({ path: req.url!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    ws.on("message", (d, bin) => ws.send(d, { binary: bin }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterAll(() => {
  upstream?.close();
  rmSync(dir, { recursive: true, force: true });
});

function mockNet(mode: "offline" | "mock" = "mock", cassetteFile?: string): DeviceNet {
  return new DeviceNet({ config: parseNetworkConfig({ mode }), mocks: MOCKS, ca, ...(cassetteFile ? { cassetteFile } : {}) });
}

function internetNet(cassetteFile?: string, record = false): DeviceNet {
  const config = parseNetworkConfig({
    mode: "internet",
    secrets: ["OPENAI_API_KEY"],
    allow: [{ host: "api.echo.test", secrets: ["OPENAI_API_KEY"], headers: { Authorization: "Bearer {{secret:OPENAI_API_KEY}}" } }],
    ...(cassetteFile ? { cassette: "echo", record } : {}),
  });
  const { values } = loadSecrets(config.secrets, { env: { OPENAI_API_KEY: SECRET } });
  return new DeviceNet({ config, mocks: MOCKS, ca, secrets: values, ...(cassetteFile ? { cassetteFile } : {}), upstream: () => ({ host: "127.0.0.1", port: upstreamPort, ca: publicCa.certPem }) });
}

describe("device network sandbox", () => {
  it("HTTPS GET to a mocked API, through sandbox DNS and TLS", async () => {
    const n = mockNet();
    const t0 = performance.now();
    const r = await request(n, { host: "api.weather.test", path: "/v1/now", ca: ca.certPem });
    const ms = performance.now() - t0;
    console.log(`[timing] first HTTPS GET (DNS + TLS handshake with a fresh leaf cert + mock): ${ms.toFixed(1)} ms`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString())).toEqual({ temp_c: 21.5, sky: "clear" });
    const t1 = performance.now();
    await request(n, { host: "api.weather.test", path: "/v1/now", ca: ca.certPem });
    console.log(`[timing] second HTTPS GET (leaf cert cached): ${(performance.now() - t1).toFixed(1)} ms`);
    const http = readNetwork(n, { kind: "http" }).entries as Array<Record<string, unknown>>;
    expect(http[0]).toMatchObject({ method: "GET", host: "api.weather.test", path: "/v1/now", status: 200, source: "mock", tls: "inspect" });
    expect(checkRequest(n, { host: "api.weather.test", path: "/v1/now", count: 2 }).ok).toBe(true);
    const miss = checkRequest(n, { host: "api.weather.test", path: "/v1/forecast" });
    expect(miss.ok).toBe(false);
    expect(miss.why).toContain("/v1/now");
    n.close();
  });

  it("streams a chunked HTTP body as it is produced", async () => {
    const n = mockNet();
    const r = await request(n, { host: "api.weather.test", path: "/v1/stream", ca: ca.certPem });
    expect(r.body.toString()).toBe(Array.from({ length: 10 }, (_, i) => `data: ${i}\n\n`).join(""));
    expect(r.chunkTimes.length).toBeGreaterThanOrEqual(8);
    expect(r.chunkTimes[r.chunkTimes.length - 1]! - r.chunkTimes[0]!).toBeGreaterThan(250);
    n.close();
  });

  it("WebSocket stream: 50 binary frames of 3200 B arrive in order and on time, generically", async () => {
    const n = mockNet();
    const ws = wsTo(n, "stream.example.test", "/v1/stream", ca.certPem);
    const got: Array<{ t: number; len: number; bin: boolean }> = [];
    const t0 = performance.now();
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (d, bin) => {
        const b = d as Buffer;
        got.push({ t: performance.now() - t0, len: b.length, bin });
        if (!bin && b.toString().includes("ready")) ws.send("start");
        if (!bin && b.toString().includes("done")) resolve();
      });
    });
    ws.close();
    const bins = got.filter((g) => g.bin);
    expect(bins).toHaveLength(50);
    expect(bins.every((b) => b.len === 3200)).toBe(true);
    const span = bins[49]!.t - bins[0]!.t;
    console.log(`[timing] ws stream: 50 x 3200 B frames over ${span.toFixed(0)} ms (scripted 49 x 20 = 980 ms), ${(160000 / (span / 1000) / 1024).toFixed(0)} KiB/s`);
    expect(span).toBeGreaterThan(900);
    await new Promise((r) => setTimeout(r, 20));
    const e = (readNetwork(n, { kind: "ws" }).entries as Array<{ frames: { in: number; out: number; bytes_in: number; samples: string[] } }>)[0]!;
    expect(e.frames.in).toBe(52);
    expect(e.frames.bytes_in).toBe(50 * 3200 + 14 + 13);
    expect(e.frames.samples.length).toBeLessThanOrEqual(12);
    n.close();
  });

  it("MQTT: publish, retained config on subscribe, and a rule that answers on another topic", async () => {
    const n = mockNet();
    const ip = lookup(n, "mqtt.example.test").ip!;
    const s = n.connect({ ip, port: 1883 });
    let buf: Buffer = Buffer.alloc(0);
    const pkts: Array<{ type: number; topic?: string; payload?: string }> = [];
    const want = (pred: () => boolean) =>
      new Promise<void>((r) => {
        const check = () => (pred() ? r() : setTimeout(check, 5));
        check();
      });
    s.on("data", (c: Buffer) => {
      const r = readPackets(Buffer.concat([buf, c]));
      buf = r.rest;
      for (const p of r.packets) pkts.push(p.type === 3 ? { type: 3, topic: decodePublish(p).topic, payload: decodePublish(p).payload.toString() } : { type: p.type });
    });
    s.write(enc.connect("d1", { username: "device" }));
    s.write(enc.subscribe(1, "devices/d1/#"));
    s.write(enc.publish("devices/d1/telemetry", '{"temp":21.5}', 1, 7));
    await want(() => pkts.some((p) => p.topic === "devices/d1/cmd"));
    expect(pkts.map((p) => p.type)).toEqual(expect.arrayContaining([2, 9, 4, 3]));
    expect(pkts.find((p) => p.topic === "devices/d1/config")?.payload).toBe('{"interval_s":30}');
    expect(pkts.find((p) => p.topic === "devices/d1/telemetry")?.payload).toBe('{"temp":21.5}');
    expect(pkts.find((p) => p.topic === "devices/d1/cmd")?.payload).toBe('{"led":"on"}');
    s.destroy();
    await new Promise((r) => setTimeout(r, 10));
    const e = (readNetwork(n, { kind: "mqtt" }).entries as Array<{ frames: { samples: string[] }; summary: string }>)[0]!;
    expect(e.frames.samples.join("\n")).toContain('device → PUBLISH devices/d1/telemetry qos1 13 B "{\\"temp\\":21.5}"');
    n.close();
  });

  it("blocks a host that is not allowed, with why and fix, at DNS and at TCP", async () => {
    const n = internetNet();
    expect(lookup(n, "evil.example.com").rcode).toBe(3);
    const s = n.connect({ ip: "93.184.215.14", port: 443 });
    await new Promise((r) => s.on("close", r));
    const blocked = readNetwork(n, { kind: "blocked" }).entries as Array<{ summary: string; why: string; fix: string }>;
    expect(blocked).toHaveLength(2);
    expect(blocked[0]!.summary).toBe("blocked: DNS evil.example.com → NXDOMAIN");
    expect(blocked[0]!.why).toContain("not on the project's allow list");
    expect(blocked[0]!.fix).toContain('add {"host": "evil.example.com"} to network.allow');
    expect(blocked[1]!.why).toContain("without looking a name up");
    // offline mode: everything fails, and says so.
    const off = mockNet("offline");
    expect(lookup(off, "api.weather.test").rcode).toBe(3);
    expect((readNetwork(off).entries as Array<{ why: string }>)[0]!.why).toContain("offline");
    // mock mode: an unmocked host is refused even if it is real.
    const mock = mockNet();
    expect(lookup(mock, "api.openai.com").rcode).toBe(3);
    expect((readNetwork(mock).entries as Array<{ why: string }>)[0]!.why).toContain('never reaches the internet');
    n.close();
    off.close();
    mock.close();
  });

  it("injects a secret at the edge and redacts it everywhere (log, tool output, cassette, device, factory pack)", async () => {
    const cassetteFile = join(dir, "network", "cassettes", "echo.json");
    const n = internetNet(cassetteFile, true);
    upstreamHits = [];
    const r = await request(n, { host: "api.echo.test", path: "/v1/models", ca: ca.certPem });
    expect(r.status).toBe(200);
    // The upstream got the real key...
    expect(upstreamHits[0]!.auth).toBe(`Bearer ${SECRET}`);
    // ...the device did not (the echo was masked, same length).
    expect(r.body.toString()).not.toContain(SECRET);
    expect(r.body.toString()).toContain("Bearer ****");
    // The firmware may also write the template itself; same result.
    const r2 = await request(n, { host: "api.echo.test", path: "/v1/x", ca: ca.certPem, headers: { "x-api-key": "{{secret:OPENAI_API_KEY}}" } });
    expect(r2.status).toBe(200);
    const out = JSON.stringify(readNetwork(n));
    expect(out).not.toContain(SECRET);
    expect(out).toContain("Bearer [secret:OPENAI_API_KEY]");
    expect(out).toContain('"secrets_used":["OPENAI_API_KEY"]');
    expect(readFileSync(cassetteFile, "utf8")).not.toContain(SECRET);
    expect(existsSync(cassetteFile)).toBe(true);
    expect(factoryNetworkNotes(n.config)).not.toContain(SECRET);
    expect(factoryNetworkNotes(n.config)).toContain("OPENAI_API_KEY");
    // A secret sent to a host that was not given it is refused, with why and fix.
    const n3 = new DeviceNet({
      config: parseNetworkConfig({ mode: "internet", secrets: ["OPENAI_API_KEY"], allow: [{ host: "api.echo.test" }] }),
      ca,
      secrets: new Map([["OPENAI_API_KEY", SECRET]]),
      upstream: () => ({ host: "127.0.0.1", port: upstreamPort, ca: publicCa.certPem }),
    });
    const r3 = await request(n3, { host: "api.echo.test", path: "/", ca: ca.certPem, headers: { authorization: "Bearer {{secret:OPENAI_API_KEY}}" } });
    expect(r3.status).toBe(502);
    expect(JSON.parse(r3.body.toString()).why).toContain("not allowed to receive the secret OPENAI_API_KEY");
    n.close();
    n3.close();
  });

  it("replays the cassette offline, identically, with the upstream gone", async () => {
    const cassetteFile = join(dir, "network", "cassettes", "echo.json");
    const n = new DeviceNet({ config: parseNetworkConfig({ mode: "mock", cassette: "echo" }), ca, cassetteFile, upstream: () => ({ host: "127.0.0.1", port: 1, ca: "" }) });
    upstreamHits = [];
    const r = await request(n, { host: "api.echo.test", path: "/v1/models", ca: ca.certPem });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString())).toMatchObject({ ok: true, path: "/v1/models", echoed_auth: expect.stringMatching(/^Bearer \*+$/) });
    expect(upstreamHits).toHaveLength(0);
    expect((readNetwork(n, { kind: "http" }).entries as Array<{ source: string }>)[0]!.source).toBe("cassette");
    n.close();
  });

  it("forwards a WebSocket to an allowed host with the secret injected, frames summarized", async () => {
    const n = internetNet();
    upstreamHits = [];
    const ws = wsTo(n, "api.echo.test", "/v1/realtime", ca.certPem);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      ws.on("open", () => ws.send(Buffer.alloc(4096, 1)));
      ws.on("message", (d) => resolve(d as Buffer));
      ws.on("error", reject);
    });
    ws.close();
    expect(echoed.length).toBe(4096);
    expect(upstreamHits[0]).toMatchObject({ path: "/v1/realtime", auth: `Bearer ${SECRET}` });
    await new Promise((r) => setTimeout(r, 20));
    const e = (readNetwork(n, { kind: "ws" }).entries as Array<{ source: string; frames: { samples: string[] }; headers: Record<string, string> }>)[0]!;
    expect(e.source).toBe("internet");
    expect(e.headers.authorization).toBe("Bearer [secret:OPENAI_API_KEY]");
    expect(e.frames.samples[0]).toContain("device → binary 4096 B");
    n.close();
  });

  it("faults: http_error, latency, timeout, wifi_drop", async () => {
    const n = mockNet();
    n.inject({ kind: "http_error", status: 500, host: "api.weather.test", count: 1 });
    expect((await request(n, { host: "api.weather.test", path: "/v1/now", ca: ca.certPem })).status).toBe(500);
    expect((await request(n, { host: "api.weather.test", path: "/v1/now", ca: ca.certPem })).status).toBe(200);
    n.inject({ kind: "latency", ms: 300 });
    const t0 = performance.now();
    await request(n, { host: "api.weather.test", path: "/v1/now", ca: ca.certPem });
    expect(performance.now() - t0).toBeGreaterThan(290);
    n.clearFaults();
    n.inject({ kind: "timeout", host: "api.weather.test" });
    const hang = request(n, { host: "api.weather.test", path: "/v1/now", ca: ca.certPem }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 100));
    expect((readNetwork(n, { kind: "http" }).entries as Array<{ summary: string }>).at(-1)!.summary).toContain("no answer (timeout fault)");
    n.inject({ kind: "wifi_drop" }); // the link goes: the hanging request is reset
    expect(await hang).toBeInstanceOf(Error);
    n.clearFaults();
    // An open WebSocket dies when Wi-Fi drops; new lookups fail with the reason.
    const ws = wsTo(n, "stream.example.test", "/v1/stream", ca.certPem);
    await new Promise((r) => ws.on("message", r));
    const closed = new Promise((r) => ws.on("close", r));
    n.inject({ kind: "wifi_drop" });
    await closed;
    expect(lookup(n, "api.weather.test").rcode).toBe(3);
    n.clearFaults();
    expect(lookup(n, "api.weather.test").ip).toBeDefined();
    n.close();
  });

  it("masks a secret split across stream chunks without stalling the stream", async () => {
    const red = new Redactor(new Map([["K", SECRET]]));
    const out: Buffer[] = [];
    const m = red.maskStream();
    m.on("data", (c: Buffer) => out.push(c));
    const whole = Buffer.from(`{"a":"${SECRET}","b":1}`);
    m.write(whole.subarray(0, 12));
    m.write(whole.subarray(12, 25));
    m.write(whole.subarray(25));
    // A chunk that cannot start a secret goes through at once.
    m.write(Buffer.from("plain"));
    await new Promise((r) => setTimeout(r, 5));
    expect(Buffer.concat(out).toString()).toBe(`{"a":"${"*".repeat(SECRET.length)}","b":1}plain`);
    m.end();
  });

  it("config refuses literal keys and undeclared secrets with why / fix", () => {
    const bad = () => parseNetworkConfig({ mode: "internet", allow: [{ host: "api.openai.com", headers: { Authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz" } }] });
    expect(bad).toThrow(ConfigError);
    try {
      bad();
    } catch (e) {
      expect((e as ConfigError).fix).toContain("{{secret:NAME}}");
      expect((e as ConfigError).field).toBe("network.allow[0].headers.Authorization");
    }
    expect(() => parseNetworkConfig({ mode: "internet", allow: [{ host: "x.test", headers: { a: "{{secret:K1}}" } }] })).toThrow(/is not given it/);
    expect(() => parseNetworkConfig({ secrets: ["sk-live-123"] })).toThrow(/not a secret name/);
  });

  it("add_mock_api applies live and persists to network/mocks.json", async () => {
    const n = mockNet();
    const file = join(dir, "proj", "network", "mocks.json");
    const res = addMockApi(n, { host: "hooks.example.test", method: "POST", path: "/hook", response: { status: 204 } }, file);
    expect(res.ok).toBe(true);
    const r = await request(n, { host: "hooks.example.test", path: "/hook", method: "POST", body: '{"event":"button"}', ca: ca.certPem });
    expect(r.status).toBe(204);
    expect(JSON.parse(readFileSync(file, "utf8")).mocks).toHaveLength(1);
    expect(addMockApi(n, { host: "x.test", path: "/", response: { headers: { a: "{{secret:K}}" } } }).ok).toBe(false);
    expect(addMockApi(n, { host: "x.test", path: "nope", response: {} } as Mock)).toMatchObject({ ok: false, field: "mock.path" });
    n.close();
  });

  it("plain-TCP sanity: TLS with a CA the device does not trust is logged with a fix", async () => {
    const n = mockNet();
    const other = await SandboxCA.open(join(dir, "other-ca"));
    const s = tlsTo(n, "api.weather.test", other.certPem);
    await new Promise((r) => s.on("error", r));
    await new Promise((r) => setTimeout(r, 20));
    const e = (readNetwork(n, { kind: "connect" }).entries as Array<{ fix: string }>)[0];
    expect(e?.fix).toContain("sandbox CA");
    n.close();
  });
});
