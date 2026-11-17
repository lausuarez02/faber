// Round 13: the API relay for the REAL device (Node server + Cloudflare Worker, generated from the
// project's network config) and the simulator's sandbox relay, with the same rules.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { SandboxCA } from "../src/ca.ts";
import { parseMocks, parseNetworkConfig, type NetworkConfig } from "../src/config.ts";
import { DeviceNet } from "../src/gateway.ts";
import { deviceHeader, deviceTokensWith, newDeviceToken, RateLimiter, relayPack, relaySpecFrom, setEnvVar, simDeviceHeader, startRelay, SIM_DEVICE_TOKEN, SIM_RELAY_HOST, type RelaySpec } from "../src/relay.ts";
import { request, wsTo } from "./harness.ts";

const KEY = "sk-live-relaytest-0123456789abcdefKEY";
const OTHER = "wk-other-secret-value-777777";
let dir: string;
let upstream: http.Server;
let upPort: number;
let hits: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

const CONFIG: NetworkConfig = parseNetworkConfig({
  mode: "internet",
  secrets: ["API_KEY", "OTHER_KEY"],
  allow: [
    { host: "api.example.com", secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } },
    { host: "*.stream.example.com", secrets: ["API_KEY", "OTHER_KEY"] },
    { host: "plain.example.com", ports: [80], secrets: ["OTHER_KEY"] },
    { host: "direct.example.com", tls: "passthrough" },
  ],
  relay: { requests_per_minute: 100, max_request_kb: 4 },
});

function upstreamHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => {
    hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() });
    if (req.url!.startsWith("/v1/stream")) {
      // a streamed answer: 6 chunks, 80 ms apart (chunked transfer encoding)
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let i = 0;
      const t = setInterval(() => {
        res.write(Buffer.alloc(1000, 65 + i));
        if (++i === 6) {
          clearInterval(t);
          res.end();
        }
      }, 80);
      return;
    }
    // an API that (badly) echoes the key back
    const body = JSON.stringify({ ok: true, path: req.url, auth: req.headers.authorization ?? null, got: Buffer.concat(parts).length });
    res.writeHead(200, { "content-type": "application/json", "x-echo": String(req.headers.authorization ?? "") });
    res.end(body);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fabwright-relay-"));
  upstream = http.createServer(upstreamHandler);
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => {
    hits.push({ method: "WS", url: req.url!, headers: req.headers, body: "" });
    ws.on("message", (d, bin) => ws.send(d, { binary: bin }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upPort = (upstream.address() as AddressInfo).port;
});

afterAll(() => {
  upstream?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function relayWith(spec: RelaySpec, tokens: Array<[string, string]>) {
  const logs: Array<Record<string, unknown>> = [];
  const env: Record<string, string> = { API_KEY: KEY, OTHER_KEY: OTHER, RELAY_DEVICE_TOKENS: "" };
  for (const [name, hash] of tokens) env.RELAY_DEVICE_TOKENS = deviceTokensWith(env.RELAY_DEVICE_TOKENS, name, hash);
  const r = await startRelay({ spec, env, port: 0, host: "127.0.0.1", log: (e) => logs.push(e), upstream: () => `http://127.0.0.1:${upPort}` });
  return { ...r, logs };
}

describe("relay config from the project's network", () => {
  it("carries the allow list, secret names, header templates and limits, never values", () => {
    const spec = relaySpecFrom(CONFIG, "Star");
    expect(spec.allow.map((a) => a.host)).toEqual(["api.example.com", "*.stream.example.com", "plain.example.com"]);
    expect(spec.direct).toEqual([{ host: "direct.example.com" }]);
    expect(spec.secrets).toEqual(["API_KEY", "OTHER_KEY"]);
    expect(spec.allow[0]!.headers).toEqual({ Authorization: "Bearer {{secret:API_KEY}}" });
    expect(spec.limits).toEqual({ requests_per_minute: 100, max_request_bytes: 4096, max_response_bytes: 32 * 1024 * 1024, max_stream_seconds: 300 });
    expect(JSON.stringify(spec)).not.toContain(KEY);
  });

  it("refuses a bad relay setting with the field, why and fix", () => {
    expect(() => parseNetworkConfig({ relay: { requests_per_minute: 0 } })).toThrow(/requests_per_minute must be a whole number/);
    expect(() => parseNetworkConfig({ relay: { burst: 3 } })).toThrow(/not a relay setting/);
  });
});

describe("Node relay (fabwright relay serve / server.mjs)", () => {
  it("sends a host with \"to\" to that address (a service the person runs), the key added, the device keeping its own name", async () => {
    const config = parseNetworkConfig({ mode: "mock", secrets: ["API_KEY"], allow: [{ host: "social.local", local: true, to: `http://127.0.0.1:${upPort}`, secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } }] });
    const spec = relaySpecFrom(config, "Cam");
    expect(spec.allow[0]).toMatchObject({ host: "social.local", to: `http://127.0.0.1:${upPort}` });
    const pack = relayPack(config, "Cam");
    expect(pack["README.md"]).toContain(`| social.local | 443, 80 | API_KEY | Authorization | \`http://127.0.0.1:${upPort}\` |`);
    expect(pack["README.md"]).toContain("a relay in the cloud (2b) needs the service's public https URL");
    const { token, hash } = newDeviceToken();
    const env = { API_KEY: KEY, RELAY_DEVICE_TOKENS: deviceTokensWith("", "cam-1", hash) };
    const logs: Array<Record<string, unknown>> = [];
    const r = await startRelay({ spec, env, port: 0, host: "127.0.0.1", log: (e) => logs.push(e) });
    try {
      hits = [];
      const res = await fetch(`${r.url}/social.local/api/v1/posts?caption=hi`, { method: "POST", headers: { "x-device-token": token, "content-type": "image/jpeg" }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
      expect(res.status).toBe(200);
      expect(hits[0]!.url).toBe("/api/v1/posts?caption=hi");
      expect(hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      // the service is down: the error says where it was sent and how to fix it
      const down = await startRelay({ spec: { ...spec, allow: [{ ...spec.allow[0]!, to: "http://127.0.0.1:1" }] }, env, port: 0, host: "127.0.0.1", log: () => {} });
      try {
        const bad = await fetch(`${down.url}/social.local/api/v1/posts`, { method: "POST", headers: { "x-device-token": token }, body: "x" });
        expect(bad.status).toBe(502);
        const text = await bad.text();
        expect(text).toContain("sent to http://127.0.0.1:1");
        expect(text).toContain("public https URL");
      } finally {
        await down.close();
      }
    } finally {
      await r.close();
    }
  });

  it("forwards to an allowed host with the key injected, redacted in the logs and masked on the way back", async () => {
    const { token, hash } = newDeviceToken();
    const r = await relayWith(relaySpecFrom(CONFIG, "Star"), [["star-1", hash]]);
    try {
      hits = [];
      const res = await fetch(`${r.url}/api.example.com/v1/chat?lang=en&key=abc`, { method: "POST", headers: { "x-device-token": token, "content-type": "application/json", "x-trace": "{{secret:API_KEY}}" }, body: JSON.stringify({ say: "hi" }) });
      const text = await res.text();
      expect(res.status).toBe(200);
      // the API got the key (template header and the firmware's own {{secret:}}), never the device token
      expect(hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(hits[0]!.headers["x-trace"]).toBe(KEY);
      expect(hits[0]!.headers["x-device-token"]).toBeUndefined();
      expect(hits[0]!.url).toBe("/v1/chat?lang=en&key=abc");
      expect(hits[0]!.body).toBe('{"say":"hi"}');
      // the device never sees the key, even when the API echoes it (body and header)
      expect(text).not.toContain(KEY);
      expect(text).toContain("*".repeat(KEY.length));
      expect(res.headers.get("x-echo")).toBe("Bearer [secret:API_KEY]");
      await new Promise((ok) => setTimeout(ok, 50));
      const line = JSON.stringify(r.logs);
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(token);
      expect(line).not.toContain("abc"); // query values never logged
      expect(r.logs.at(-1)).toMatchObject({ kind: "http", device: "star-1", method: "POST", host: "api.example.com", path: "/v1/chat", query_keys: ["lang", "key"], status: 200, secrets_used: ["API_KEY"] });
    } finally {
      await r.close();
    }
  });

  it("rejects hosts not on the list, wrong ports, bad, missing and revoked tokens, and keys over plain HTTP", async () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    const spec = relaySpecFrom(CONFIG, "Star");
    let r = await relayWith(spec, [["star-1", a.hash], ["star-2", b.hash]]);
    try {
      hits = [];
      const call = async (path: string, token?: string, headers: Record<string, string> = {}) => {
        const res = await fetch(`${r.url}${path}`, { headers: { ...(token ? { "x-device-token": token } : {}), ...headers } });
        return { status: res.status, body: (await res.json()) as { error: string; why: string; fix: string } };
      };
      let x = await call("/evil.example.org/steal", a.token);
      expect(x).toMatchObject({ status: 403, body: { error: "host-not-allowed" } });
      expect(x.body.fix).toContain('"host": "evil.example.org"');
      expect((await call("/api.example.com:8443/x", a.token)).body.error).toBe("port-not-allowed");
      expect((await call("/direct.example.com/x", a.token)).body.error).toBe("host-not-relayed");
      expect((await call("/api.example.com/x")).status).toBe(401);
      expect((await call("/api.example.com/x", "jdt_not-a-real-token")).body.error).toBe("unknown-device-token");
      expect((await call("/plain.example.com:80/x", a.token, { "x-k": "{{secret:OTHER_KEY}}" })).body.error).toBe("secret-over-http");
      expect((await call("/api.example.com/x", a.token, { "x-k": "{{secret:OTHER_KEY}}" })).body.error).toBe("secret-not-for-host");
      expect((await call("/not-a-host/x", a.token)).body.error).toBe("bad-host");
      expect((await call("/%E0%A4%A/x", a.token)).body.error).toBe("bad-host");
      expect((await call("/api.example.com@evil.example.org/x", a.token)).body.error).toBe("bad-host");
      expect(hits).toHaveLength(0); // nothing refused ever reached an API
      expect((await call("/x.stream.example.com/ok", b.token)).status).toBe(200);
      await r.close();
      // revoke star-2: its token stops working, star-1 keeps working
      r = await relayWith(spec, [["star-1", a.hash]]);
      expect((await call("/api.example.com/x", b.token)).body.error).toBe("unknown-device-token");
      expect((await call("/api.example.com/x", a.token)).status).toBe(200);
      expect(JSON.stringify(r.logs)).not.toContain(b.token);
    } finally {
      await r.close();
    }
  });

  it("limits rate and request size per device", async () => {
    const { token, hash } = newDeviceToken();
    const spec = { ...relaySpecFrom(CONFIG, "Star"), limits: { ...relaySpecFrom(CONFIG, "Star").limits, requests_per_minute: 2 } };
    const r = await relayWith(spec, [["star-1", hash]]);
    try {
      const big = await fetch(`${r.url}/api.example.com/up`, { method: "POST", headers: { "x-device-token": token }, body: "x".repeat(5000) });
      expect(big.status).toBe(413);
      expect(((await big.json()) as { fix: string }).fix).toContain("max_request_kb");
      expect((await fetch(`${r.url}/api.example.com/a`, { headers: { "x-device-token": token } })).status).toBe(200);
      const limited = await fetch(`${r.url}/api.example.com/b`, { headers: { "x-device-token": token } });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  });

  it("streams answers as they come (chunked) and streams chunked uploads", async () => {
    const { token, hash } = newDeviceToken();
    const r = await relayWith(relaySpecFrom(CONFIG, "Star"), [["star-1", hash]]);
    try {
      const t0 = performance.now();
      const res = await fetch(`${r.url}/api.example.com/v1/stream`, { headers: { "x-device-token": token } });
      const times: number[] = [];
      let n = 0;
      for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
        n += c.length;
        times.push(performance.now() - t0);
      }
      expect(n).toBe(6000);
      // the first bytes arrive long before the last (6 x 80 ms upstream): not buffered
      expect(times[0]!).toBeLessThan(times.at(-1)! - 250);
      // a chunked upload (no Content-Length) goes through as a stream
      hits = [];
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("part1-"));
          c.enqueue(new TextEncoder().encode("part2"));
          c.close();
        },
      });
      const up = await fetch(`${r.url}/api.example.com/v1/upload`, { method: "POST", headers: { "x-device-token": token }, body, duplex: "half" } as RequestInit);
      expect(up.status).toBe(200);
      expect(hits[0]!.body).toBe("part1-part2");
    } finally {
      await r.close();
    }
  });

  it("passes a WebSocket through with the key added and logs frames' bytes, not their content", async () => {
    const { token, hash } = newDeviceToken();
    const r = await relayWith(relaySpecFrom(CONFIG, "Star"), [["star-1", hash]]);
    try {
      hits = [];
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api.example.com/v1/live`, { headers: { "x-device-token": token } });
      const got: Buffer[] = [];
      await new Promise<void>((ok, bad) => {
        ws.on("open", () => {
          for (let i = 0; i < 20; i++) ws.send(Buffer.alloc(3200, i));
        });
        ws.on("message", (d: Buffer) => {
          got.push(d);
          if (got.length === 20) ok();
        });
        ws.on("error", bad);
      });
      ws.close();
      expect(got.map((g) => g[0])).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(hits[0]!.headers["x-device-token"]).toBeUndefined();
      await new Promise((ok) => setTimeout(ok, 100));
      const e = r.logs.find((l) => l.kind === "ws")!;
      expect(e).toMatchObject({ device: "star-1", host: "api.example.com", path: "/v1/live", status: 101, secrets_used: ["API_KEY"] });
      expect(e.bytes_in as number).toBeGreaterThan(64000);
      expect(JSON.stringify(r.logs)).not.toContain(KEY);
      // a bad token never upgrades
      const bad = new WebSocket(`ws://127.0.0.1:${r.port}/api.example.com/v1/live`, { headers: { "x-device-token": "nope" } });
      const status = await new Promise<number>((ok) => bad.on("unexpected-response", (_q, res) => ok(res.statusCode!)));
      expect(status).toBe(401);
    } finally {
      await r.close();
    }
  });
});

describe("generated relay/ folder", () => {
  it("has the Node server, the Worker, wrangler.toml, README and the firmware header, MIT, no secret values", () => {
    const files = relayPack(CONFIG, "Star Keychain");
    for (const f of ["server.mjs", "worker.js", "relay-core.mjs", "relay.config.mjs", "wrangler.toml", "package.json", "README.md", "LICENSE", ".env.example", ".gitignore", "firmware/FabwrightRelay.h", "firmware/fabwright_device.example.h"]) expect(files[f], f).toBeTruthy();
    expect(files["wrangler.toml"]).toContain('name = "star-keychain-relay"');
    expect(files["wrangler.toml"]).toContain('main = "worker.js"');
    expect(files["wrangler.toml"]).toContain("wrangler secret put API_KEY");
    expect(files["README.md"]).toContain("wrangler secret put RELAY_DEVICE_TOKENS");
    expect(files["README.md"]).toContain("fabwright relay device-header");
    expect(files.LICENSE).toMatch(/^MIT License/);
    for (const f of ["server.mjs", "worker.js", "relay-core.mjs", "firmware/FabwrightRelay.h"]) expect(files[f]).toContain("SPDX-License-Identifier: MIT");
    expect(Object.values(files).join("\n")).not.toContain(KEY);
  });

  it("server.mjs runs on its own with node, reading relay.config.mjs and .env next to it", async () => {
    const out = join(dir, "pack-node");
    for (const [p, t] of Object.entries(relayPack(CONFIG, "Star"))) {
      mkdirSync(join(out, p, ".."), { recursive: true });
      writeFileSync(join(out, p), t);
    }
    const { token, hash } = newDeviceToken();
    writeFileSync(join(out, ".env"), `RELAY_DEVICE_TOKENS=star-1:${hash}\nAPI_KEY=${KEY}\n`);
    const child = spawn(process.execPath, ["server.mjs"], { cwd: out, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      // PORT=0 picks a free port; read it from the start line
      const url = await new Promise<string>((ok, bad) => {
        let err = "";
        child.stderr.on("data", (d: Buffer) => {
          err += d.toString();
          const m = /on (http:\/\/localhost:\d+)/.exec(err);
          if (m) ok(m[1]!);
        });
        child.on("exit", (c) => bad(new Error(`server.mjs exited ${c}: ${err}`)));
      });
      expect((await fetch(`${url}/health`)).status).toBe(200);
      const res = await fetch(`${url}/evil.example.org/`, { headers: { "x-device-token": token } });
      expect(res.status).toBe(403);
    } finally {
      child.kill();
    }
  });

  it("worker.js handles requests like the Node relay (node + a fetch mock in place of wrangler)", async () => {
    const out = join(dir, "pack-worker");
    for (const [p, t] of Object.entries(relayPack(CONFIG, "Star"))) {
      mkdirSync(join(out, p, ".."), { recursive: true });
      writeFileSync(join(out, p), t);
    }
    const worker = (await import(pathToFileURL(join(out, "worker.js")).href)).default as { fetch(r: Request, env: Record<string, string>): Promise<Response> };
    const { token, hash } = newDeviceToken();
    const env = { RELAY_DEVICE_TOKENS: `star-1:${hash}`, API_KEY: KEY };
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const logs: string[] = [];
    const realLog = console.log;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = new ReadableStream({
        async start(c) {
          for (let i = 0; i < 3; i++) {
            c.enqueue(new TextEncoder().encode(`chunk${i};echo=${(init.headers as Record<string, string>).authorization};`));
            await new Promise((ok) => setTimeout(ok, 30));
          }
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    console.log = (s: string) => logs.push(s);
    try {
      const res = await worker.fetch(new Request("https://star-relay.example.workers.dev/api.example.com/v1/x?q=1", { method: "POST", headers: { "x-device-token": token, "content-length": "2" }, body: "{}" }), env);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(calls[0]!.url).toBe("https://api.example.com/v1/x?q=1");
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      expect((calls[0]!.init.headers as Record<string, string>)["x-device-token"]).toBeUndefined();
      expect(text).toContain("chunk0;");
      expect(text).toContain("chunk2;");
      expect(text).not.toContain(KEY);
      expect((await worker.fetch(new Request("https://r.example/api.example.com/x", { headers: { "x-device-token": "bad" } }), env)).status).toBe(401);
      expect((await worker.fetch(new Request("https://r.example/evil.example.org/x", { headers: { "x-device-token": token } }), env)).status).toBe(403);
      expect(calls).toHaveLength(1);
      const joined = logs.join("\n");
      expect(joined).toContain('"device":"star-1"');
      expect(joined).not.toContain(KEY);
      expect(joined).not.toContain(token);

      // WebSocket: bridged with a WebSocketPair (faked here: Node has no Workers runtime)
      class FakeWs {
        peer?: FakeWs;
        sent: unknown[] = [];
        listeners: Record<string, Array<(e: unknown) => void>> = {};
        accept() {}
        addEventListener(t: string, f: (e: unknown) => void) {
          (this.listeners[t] ??= []).push(f);
        }
        send(d: unknown) {
          this.sent.push(d);
          this.peer?.emit("message", { data: d });
        }
        close() {}
        emit(t: string, e: unknown) {
          for (const f of this.listeners[t] ?? []) f(e);
        }
      }
      const api = new FakeWs();
      let device: FakeWs | undefined;
      (globalThis as Record<string, unknown>).WebSocketPair = class {
        0: FakeWs;
        1: FakeWs;
        constructor() {
          const client = new FakeWs();
          const server = new FakeWs();
          client.peer = server;
          server.peer = client;
          device = client;
          this[0] = client;
          this[1] = server;
        }
      };
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return Object.assign(new Response(null, { status: 200 }), { webSocket: api });
      }) as typeof fetch;
      const RealResponse = globalThis.Response;
      globalThis.Response = class extends RealResponse {
        webSocket?: unknown;
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          super(body, init?.status === 101 ? { ...init, status: 200 } : init);
          this.webSocket = init?.webSocket;
        }
      } as typeof Response;
      try {
        const wsRes = (await worker.fetch(new Request("https://r.example/x.stream.example.com/live", { headers: { "x-device-token": token, upgrade: "websocket", "sec-websocket-key": "abc" } }), { ...env, OTHER_KEY: OTHER })) as Response & { webSocket?: FakeWs };
        expect(wsRes.webSocket).toBe(device);
        expect(calls.at(-1)!.url).toBe("https://x.stream.example.com/live");
        expect((calls.at(-1)!.init.headers as Record<string, string>).upgrade).toBe("websocket");
        expect((calls.at(-1)!.init.headers as Record<string, string>)["sec-websocket-key"]).toBeUndefined();
        device!.send("hello"); // device → API
        expect(api.sent).toEqual(["hello"]);
        api.emit("message", { data: new Uint8Array(320) }); // API → device
        expect(device!.peer!.sent).toHaveLength(1); // the bridge passed it to the device
        api.emit("close", { code: 1000, reason: "" });
        expect(logs.some((l) => l.includes('"kind":"ws"') && l.includes('"bytes_in":320'))).toBe(true);
      } finally {
        globalThis.Response = RealResponse;
        delete (globalThis as Record<string, unknown>).WebSocketPair;
      }
    } finally {
      globalThis.fetch = realFetch;
      console.log = realLog;
    }
  });
});

describe("device tokens, .env and firmware headers", () => {
  it("adds, replaces and revokes tokens by name; keeps other .env lines", () => {
    let v = deviceTokensWith("", "star-1", "a".repeat(64));
    v = deviceTokensWith(v, "star-2", "b".repeat(64));
    v = deviceTokensWith(v, "star-1", "c".repeat(64));
    expect(v).toBe(`star-2:${"b".repeat(64)},star-1:${"c".repeat(64)}`);
    expect(deviceTokensWith(v, "star-2", undefined)).toBe(`star-1:${"c".repeat(64)}`);
    const env = setEnvVar("# keys\nAPI_KEY=x\n", "DEVICE_TOKEN", "jdt_1");
    expect(env).toBe("# keys\nAPI_KEY=x\nDEVICE_TOKEN=jdt_1\n");
    expect(setEnvVar(env, "API_KEY", undefined)).toBe("# keys\nDEVICE_TOKEN=jdt_1\n");
    expect(setEnvVar("", "WIFI_PASSWORD", "my pass#1")).toBe('WIFI_PASSWORD="my pass#1"\n');
  });

  it("the simulation header plays the sandbox relay; the device header carries the person's values", () => {
    const sim = simDeviceHeader(parseNetworkConfig({ wifi: { ssid: "Home" } }));
    expect(sim).toContain(`"https://${SIM_RELAY_HOST}"`);
    expect(sim).toContain(SIM_DEVICE_TOKEN);
    expect(sim).toContain('FABWRIGHT_WIFI_SSID "Home"');
    const dev = deviceHeader({ relayUrl: "https://r.example.workers.dev/", token: "jdt_x", ssid: "Home", password: 'p"w', rootCa: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----" });
    expect(dev).toContain('#define FABWRIGHT_RELAY_URL "https://r.example.workers.dev"');
    expect(dev).toContain('#define FABWRIGHT_WIFI_PASSWORD "p\\"w"');
    expect(dev).toContain("FABWRIGHT_RELAY_ROOT_CA");
    expect(readFileSync(new URL("../src/relay/firmware/FabwrightRelay.h", import.meta.url), "utf8")).toContain('__has_include("fabwright_device.h")');
  });
});

describe("the simulator plays the same relay", () => {
  let ca: SandboxCA;
  let caPem: string;
  beforeAll(async () => {
    ca = await SandboxCA.open(join(dir, "ca"));
    caPem = ca.certPem;
  });

  const mocks = parseMocks({ mocks: [{ host: "api.example.com", method: "POST", path: "/v1/chat", response: { body: { reply: "a mocked answer" } } }, { kind: "ws", host: "api.example.com", path: "/v1/live", on_message: [{ match: "*", send: [{ bytes: 100, repeat: 3 }] }] }] });

  it("answers through relay.sandbox.fabwright/<host>/<path> with the sim token, from mocks", async () => {
    const net = new DeviceNet({ config: parseNetworkConfig({ mode: "mock", secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } }] }), mocks, ca, secrets: new Map([["API_KEY", KEY]]) });
    const ok = await request(net, { host: SIM_RELAY_HOST, path: "/api.example.com/v1/chat", method: "POST", headers: { "x-device-token": SIM_DEVICE_TOKEN }, body: "{}", ca: caPem });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.toString())).toEqual({ reply: "a mocked answer" });
    const e = net.log.since().find((x) => x.kind === "http" && x.via === "relay")!;
    expect(e).toMatchObject({ host: "api.example.com", path: "/v1/chat", source: "mock", status: 200 });
    // the same refusals as the real relay, with the same codes
    const noTok = await request(net, { host: SIM_RELAY_HOST, path: "/api.example.com/v1/chat", ca: caPem });
    expect(noTok.status).toBe(401);
    expect(JSON.parse(noTok.body.toString()).error).toBe("no-device-token");
    const evil = await request(net, { host: SIM_RELAY_HOST, path: "/evil.example.org/x", headers: { "x-device-token": SIM_DEVICE_TOKEN }, ca: caPem });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body.toString()).error).toBe("host-not-allowed");
    const big = await request(net, { host: SIM_RELAY_HOST, path: "/api.example.com/v1/chat", method: "POST", headers: { "x-device-token": SIM_DEVICE_TOKEN, "content-length": String(2 * 1024 * 1024) }, body: "x".repeat(2 * 1024 * 1024), ca: caPem });
    expect(big.status).toBe(413);
    expect(JSON.stringify(net.log.since())).not.toContain(KEY);
  });

  it("forwards to the real host in internet mode with the key added at the edge, and WebSockets too", async () => {
    hits = [];
    const net = new DeviceNet({ config: parseNetworkConfig({ mode: "internet", secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } }] }), ca, secrets: new Map([["API_KEY", KEY]]), upstream: () => ({ host: "127.0.0.1", port: upPort }) });
    // upstream here is plain HTTP: point the target's port at 80 so the gateway speaks HTTP to it
    const cfg = parseNetworkConfig({ mode: "internet", secrets: ["API_KEY"], allow: [{ host: "api.example.com", ports: [80], secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } }] });
    net.setConfig(cfg);
    const res = await request(net, { host: SIM_RELAY_HOST, path: "/api.example.com:80/v1/x", headers: { "x-device-token": SIM_DEVICE_TOKEN }, ca: caPem });
    expect(res.status).toBe(200);
    expect(hits[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(hits[0]!.headers["x-device-token"]).toBeUndefined();
    expect(res.body.toString()).not.toContain(KEY);
    // WebSocket through the sandbox relay, from a mock
    const net2 = new DeviceNet({ config: parseNetworkConfig({ mode: "mock", allow: [{ host: "api.example.com" }] }), mocks, ca });
    const ws = wsTo(net2, SIM_RELAY_HOST, "/api.example.com/v1/live", caPem, { "x-device-token": SIM_DEVICE_TOKEN });
    const n = await new Promise<number>((ok, bad) => {
      let k = 0;
      ws.on("open", () => ws.send("go"));
      ws.on("message", () => {
        if (++k === 3) ok(k);
      });
      ws.on("error", bad);
    });
    ws.close();
    expect(n).toBe(3);
    expect(net2.log.since().some((x) => x.kind === "ws" && x.via === "relay" && x.host === "api.example.com")).toBe(true);
  });
});

describe("relay rate limit", () => {
  it("a clock that goes back (the simulator's next test starts at 0 ms) starts full, not drained", () => {
    let now = 0;
    const l = new RateLimiter(3, () => now);
    now = 138_000;
    for (let i = 0; i < 3; i++) expect(l.take("dev").ok).toBe(true);
    expect(l.take("dev").ok).toBe(false);
    now = 500; // a new test run: virtual time restarts
    for (let i = 0; i < 3; i++) expect(l.take("dev").ok, `request ${i + 1} after the clock went back`).toBe(true);
    expect(l.take("dev")).toEqual({ ok: false, retry_after_s: 20 });
    now = 20_500; // refills at 3 a minute as before
    expect(l.take("dev").ok).toBe(true);
  });
});
