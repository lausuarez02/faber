// Round 14: what a request carried (body / content type checks), real services on this computer
// reached safely (the "local" opt-in and "to"), OpenAPI mocks with request validation, and the NTP
// clock a test sets. All through the same entry points a QEMU board uses (net.udp, net.connect).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyMismatch, describeBody, flattenJson } from "../src/body.ts";
import { SandboxCA } from "../src/ca.ts";
import { ConfigError, parseMocks, parseNetworkConfig, type Mock } from "../src/config.ts";
import { parseNtpTransmitMs } from "../src/dns.ts";
import { DeviceNet } from "../src/gateway.ts";
import { isLocalAddress, isLocalName, parseLocalTarget } from "../src/local.ts";
import { answerFor, exampleOf, matchOperation, resolveMocks, resolveOpenApiMock, storedOpenApiMock, validateRequest, type OpenApiMock } from "../src/openapi.ts";
import { addMockApi, checkRequest, readNetwork } from "../src/tools.ts";
import { lookup, request } from "./harness.ts";

let dir: string;
let ca: SandboxCA;
let local: http.Server;
let localPort: number;
const localHits: Array<{ method: string; path: string; host?: string; body: string }> = [];

const SOCIAL = {
  openapi: "3.0.3",
  info: { title: "Star social", version: "1" },
  servers: [{ url: "https://api.social.test/v1" }],
  paths: {
    "/posts": {
      post: {
        operationId: "createPost",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: { type: "object", required: ["photo", "caption"], properties: { photo: { type: "string", format: "binary" }, caption: { type: "string", maxLength: 280 }, taken_at: { type: "string", format: "date-time" } } },
              encoding: { photo: { contentType: "image/jpeg" } },
            },
          },
        },
        responses: { "201": { description: "created", content: { "application/json": { schema: { $ref: "#/components/schemas/Post" } } } }, "400": { description: "bad" } },
      },
      get: { operationId: "listPosts", parameters: [{ name: "limit", in: "query", schema: { type: "integer", maximum: 50 } }], responses: { "200": { description: "ok", content: { "application/json": { example: { posts: [] } } } } } },
    },
    "/posts/{id}": {
      get: { operationId: "getPost", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Post" } } } } } },
    },
    "/devices/{device}/heartbeat": {
      post: {
        operationId: "heartbeat",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["battery"], additionalProperties: false, properties: { battery: { type: "integer", minimum: 0, maximum: 100 }, queued: { type: "integer" } } } } } },
        responses: { "204": { description: "ok" } },
      },
    },
  },
  components: { schemas: { Post: { type: "object", properties: { id: { type: "string", example: "p_1" }, author: { type: "string", example: "Twinkle" }, caption: { type: "string" }, status: { type: "string", enum: ["pending_review", "published"] }, created_at: { type: "string", format: "date-time" } } } } },
};

function multipartBody(boundary: string, parts: Array<{ name: string; filename?: string; type?: string; data: string | Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "faber-r14-net-"));
  ca = await SandboxCA.open(join(dir, "ca"));
  writeFileSync(join(dir, "social.yaml"), `openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths:\n  /ping:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              example: {pong: true}\n`);
  // "A service the person runs on this computer" (a dev server for the social network).
  local = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      localHits.push({ method: req.method!, path: req.url!, ...(req.headers.host ? { host: req.headers.host } : {}), body: Buffer.concat(parts).toString() });
      const body = JSON.stringify({ ok: true, from: "local service" });
      res.writeHead(201, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
  });
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
  localPort = (local.address() as net.AddressInfo).port;
});

afterAll(() => {
  local?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("request bodies in the log", () => {
  it("describes JSON, form and multipart bodies, and matches expectations on them", () => {
    const j = describeBody("application/json", Buffer.from(JSON.stringify({ model: "tts-1", input: "Taking a picture in 10 seconds", messages: [{ role: "user" }] })));
    expect(j?.fields).toMatchObject({ model: "tts-1", input: "Taking a picture in 10 seconds", "messages.0.role": "user" });
    const f = describeBody("application/x-www-form-urlencoded", Buffer.from("caption=hi+there&n=2"));
    expect(f?.fields).toEqual({ caption: "hi there", n: "2" });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 7)]);
    const mp = describeBody("multipart/form-data; boundary=XyZ", multipartBody("XyZ", [{ name: "caption", data: "a cat" }, { name: "photo", filename: "p1.jpg", type: "image/jpeg", data: jpeg }]));
    expect(mp?.parts).toEqual([{ name: "caption", bytes: 5 }, { name: "photo", filename: "p1.jpg", content_type: "image/jpeg", bytes: 503 }]);
    expect(mp?.fields).toMatchObject({ caption: "a cat", "photo.filename": "p1.jpg", "photo.content_type": "image/jpeg", "photo.bytes": 503 });
    // binary bodies: size only
    expect(describeBody("image/jpeg", jpeg)).toEqual({ bytes: 503 });
    const entry = { content_type: "multipart/form-data; boundary=XyZ", body: mp! };
    expect(bodyMismatch(entry, { content_type: "multipart/form-data", body_json: { photo: { content_type: "image/jpeg" }, caption: "a*" }, min_bytes: 400 })).toBeUndefined();
    expect(bodyMismatch(entry, { body_json: { caption: "?" } })).toBeUndefined();
    expect(bodyMismatch(entry, { content_type: "application/json" })).toContain('not "application/json"');
    expect(bodyMismatch(entry, { body_json: { location: "?" } })).toContain('no field "location"');
    expect(bodyMismatch(entry, { body_contains: "p1.jpg" })).toBeUndefined();
    expect(flattenJson({ a: { b: [1, { c: "x" }] } })).toEqual({ "a.b.0": 1, "a.b.1.c": "x" });
  });

  it("the request step checks method, path, content type and body through the sandbox", async () => {
    const n = new DeviceNet({ config: parseNetworkConfig({ mode: "mock" }), mocks: parseMocks({ mocks: [{ host: "api.photos.test", method: "POST", path: "/upload", response: { status: 201, body: { id: 1 } } }] }), ca });
    const body = multipartBody("b0undary", [{ name: "caption", data: "sunset" }, { name: "photo", filename: "1.jpg", type: "image/jpeg", data: Buffer.alloc(2000, 1) }]);
    const r = await request(n, { host: "api.photos.test", path: "/upload", method: "POST", headers: { "content-type": "multipart/form-data; boundary=b0undary" }, body: body.toString("latin1"), ca: ca.certPem });
    expect(r.status).toBe(201);
    expect(checkRequest(n, { host: "api.photos.test", path: "/upload", method: "POST", content_type: "multipart/form-data", body_json: { "photo.content_type": "image/jpeg", caption: "sunset" }, min_bytes: 1000 }).ok).toBe(true);
    const bad = checkRequest(n, { host: "api.photos.test", path: "/upload", body_json: { caption: "night" } });
    expect(bad.ok).toBe(false);
    expect(bad.why).toContain('its field "caption" is "sunset", not "night"');
    expect(bad.fix).toContain("read_network");
    const e = (readNetwork(n, { kind: "http" }).entries as Array<Record<string, any>>)[0]!;
    expect(e.content_type).toContain("multipart/form-data");
    expect(e.body.parts[1]).toMatchObject({ name: "photo", content_type: "image/jpeg" });
    n.close();
  });
});

describe("real services on this computer: explicit opt-in per host", () => {
  it("classifies local addresses and names", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.20", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) expect(isLocalAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) expect(isLocalAddress(ip), ip).toBe(false);
    expect(isLocalName("mystar.local")).toBe(true);
    expect(isLocalName("localhost")).toBe(true);
    expect(isLocalName("api.example.com")).toBe(false);
    expect(parseLocalTarget("http://127.0.0.1:7821")).toEqual({ protocol: "http:", host: "127.0.0.1", port: 7821 });
    expect(() => parseLocalTarget("127.0.0.1:7821")).toThrow(/Fix:/);
    expect(() => parseLocalTarget("http://127.0.0.1:7821/api")).toThrow(/path/);
  });

  it("validates allow entries: \"to\" needs \"local\": true, never on a wildcard", () => {
    const err = (raw: unknown) => {
      try {
        parseNetworkConfig(raw);
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("no error");
    };
    const a = err({ mode: "mock", allow: [{ host: "api.social.test", to: "http://127.0.0.1:7821" }] });
    expect(a.message).toContain('does not say "local": true');
    expect(a.fix).toContain('"local": true');
    expect(err({ mode: "mock", allow: [{ host: "*.social.test", local: true }] }).message).toContain("wildcard");
    expect(err({ mode: "mock", allow: [{ host: "api.social.test", local: true, to: "ftp://x" }] }).field).toBe("network.allow[0].to");
    expect(parseNetworkConfig({ mode: "mock", allow: [{ host: "api.social.test", local: true, to: "http://127.0.0.1:7821" }] }).allow[0]).toMatchObject({ local: true, to: "http://127.0.0.1:7821" });
  });

  it("\"to\" sends a host's requests to a service here, in mock mode too; mocks still win", async () => {
    localHits.length = 0;
    const n = new DeviceNet({
      config: parseNetworkConfig({ mode: "mock", allow: [{ host: "api.social.test", local: true, to: `http://127.0.0.1:${localPort}` }] }),
      mocks: parseMocks({ mocks: [{ host: "api.social.test", path: "/mocked", response: { body: { mocked: true } } }] }),
      ca,
    });
    // the device calls https://api.social.test (TLS ends at the sandbox), the service gets plain HTTP
    const r = await request(n, { host: "api.social.test", path: "/v1/posts", method: "POST", headers: { "content-type": "application/json" }, body: '{"caption":"hi"}', ca: ca.certPem });
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true, from: "local service" });
    expect(localHits[0]).toMatchObject({ method: "POST", path: "/v1/posts", host: "api.social.test", body: '{"caption":"hi"}' });
    const m = await request(n, { host: "api.social.test", path: "/mocked", ca: ca.certPem });
    expect(JSON.parse(m.body.toString())).toEqual({ mocked: true });
    expect(localHits).toHaveLength(1);
    n.close();
  });

  it("refuses a host that resolves to this computer without the opt-in, and says how to opt in", async () => {
    localHits.length = 0;
    const n = new DeviceNet({ config: parseNetworkConfig({ mode: "internet", allow: [{ host: "localhost", ports: [localPort] }] }), mocks: [], ca });
    const r = await request(n, { host: "localhost", path: "/secret", port: localPort });
    expect(r.status).toBe(502);
    const body = JSON.parse(r.body.toString());
    expect(body.why).toContain("this computer or its local network");
    expect(body.fix).toContain('"local": true');
    expect(localHits).toHaveLength(0);
    n.close();
    // opted in: it gets through
    const ok = new DeviceNet({ config: parseNetworkConfig({ mode: "internet", allow: [{ host: "localhost", ports: [localPort], local: true }] }), mocks: [], ca });
    const r2 = await request(ok, { host: "localhost", path: "/hello", port: localPort });
    expect(r2.status).toBe(201);
    expect(localHits[0]!.path).toBe("/hello");
    ok.close();
  });

  it("a local service that is not running fails with where and how to fix", async () => {
    const free = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    const n = new DeviceNet({ config: parseNetworkConfig({ mode: "mock", allow: [{ host: "api.social.test", local: true, to: `http://127.0.0.1:${free}` }] }), mocks: [], ca });
    const r = await request(n, { host: "api.social.test", path: "/v1/posts", ca: ca.certPem });
    expect(r.status).toBe(502);
    const b = JSON.parse(r.body.toString());
    expect(b.why).toContain(`127.0.0.1:${free}`);
    expect(b.fix).toContain("start the service");
    n.close();
  });
});

describe("OpenAPI mocks", () => {
  const mock = (): OpenApiMock => resolveOpenApiMock({ kind: "openapi", host: "api.social.test", spec: SOCIAL as never }, dir);

  it("matches operations by template under the server's base path and makes deterministic examples", () => {
    const m = mock();
    expect(matchOperation(m, "POST", "/v1/posts")?.key).toBe("createPost");
    expect(matchOperation(m, "GET", "/v1/posts/p_9?x=1")).toMatchObject({ key: "getPost", params: { id: "p_9" } });
    expect(matchOperation(m, "GET", "/posts")).toBeUndefined();
    expect(matchOperation(m, "DELETE", "/v1/posts")).toBeUndefined();
    const a = answerFor(m, matchOperation(m, "GET", "/v1/posts/p_9")!);
    expect(a.response).toMatchObject({ status: 200, body: { id: "p_9", author: "Twinkle", caption: "caption-1", status: "pending_review", created_at: "2026-01-01T12:00:00Z" } });
    expect(answerFor(m, matchOperation(m, "POST", "/v1/posts")!).response.status).toBe(201);
    expect(exampleOf(SOCIAL as never, { type: "array", items: { type: "integer", minimum: 3 } })).toEqual([3]);
    expect(storedOpenApiMock(m)).not.toHaveProperty("spec_doc");
  });

  it("validates requests against the operation (body schema, multipart parts, parameters, content type)", () => {
    const m = mock();
    const post = matchOperation(m, "POST", "/v1/posts")!;
    const good = multipartBody("B", [{ name: "caption", data: "hello" }, { name: "photo", filename: "a.jpg", type: "image/jpeg", data: Buffer.alloc(100, 1) }]);
    const ct = "multipart/form-data; boundary=B";
    expect(validateRequest(m, post, "/v1/posts", ct, good, describeBody(ct, good))).toEqual([]);
    const noCaption = multipartBody("B", [{ name: "photo", filename: "a.png", type: "image/png", data: Buffer.alloc(10, 1) }]);
    const p1 = validateRequest(m, post, "/v1/posts", ct, noCaption, describeBody(ct, noCaption));
    expect(p1).toContain('body.caption: is required but the form has no "caption" part');
    expect(p1.join(" ")).toContain("image/png, the API takes image/jpeg");
    expect(validateRequest(m, post, "/v1/posts", "application/json", Buffer.from("{}"), undefined)[0]).toContain("the API takes multipart/form-data");
    expect(validateRequest(m, post, "/v1/posts", ct, Buffer.alloc(0), undefined)[0]).toContain("is required");
    const hb = matchOperation(m, "POST", "/v1/devices/star1/heartbeat")!;
    const j = (o: unknown) => Buffer.from(JSON.stringify(o));
    expect(validateRequest(m, hb, "/x", "application/json", j({ battery: 80 }), undefined)).toEqual([]);
    expect(validateRequest(m, hb, "/x", "application/json", j({ battery: 120, extra: 1 }), undefined)).toEqual(["body.battery: 120 is over the maximum 100", "body.extra: is not a field of this API (allowed: battery, queued)"]);
    expect(validateRequest(m, hb, "/x", "application/json", j({ battery: "full" }), undefined)[0]).toContain("the API wants integer");
    const list = matchOperation(m, "GET", "/v1/posts?limit=500")!;
    expect(validateRequest(m, list, "/v1/posts?limit=500", undefined, Buffer.alloc(0), undefined)[0]).toContain("over the maximum 50");
  });

  it("answers through the sandbox: examples, 400 with the problems, 404 naming the operations", async () => {
    const n = new DeviceNet({ config: parseNetworkConfig({ mode: "mock" }), mocks: [mock() as Mock], ca });
    const ok = await request(n, { host: "api.social.test", path: "/v1/posts/abc", ca: ca.certPem });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.toString()).id).toBe("abc");
    const bad = await request(n, { host: "api.social.test", path: "/v1/devices/s/heartbeat", method: "POST", headers: { "content-type": "application/json" }, body: '{"battery": -1}', ca: ca.certPem });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body.toString())).toMatchObject({ operation: "heartbeat", problems: ["body.battery: -1 is under the minimum 0"] });
    const none = await request(n, { host: "api.social.test", path: "/v1/likes", ca: ca.certPem });
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body.toString()).why).toContain("POST /posts (createPost)");
    const log = readNetwork(n, { kind: "http" }).entries as Array<Record<string, string>>;
    expect(log.find((e) => e.status === (400 as never))!.why).toContain("does not match the API's heartbeat operation");
    expect(checkRequest(n, { host: "api.social.test", path: "/v1/devices/s/heartbeat", status: 400 }).ok).toBe(true);
    n.close();
  });

  it("loads YAML spec files from the project and keeps only the path in mocks.json", () => {
    const [m] = resolveMocks([{ kind: "openapi", host: "api.y.test", spec: "social.yaml" } as Mock], dir);
    expect(matchOperation(m as OpenApiMock, "GET", "/ping")?.key).toBe("GET /ping");
    expect(() => resolveMocks([{ kind: "openapi", host: "api.y.test", spec: "missing.yaml" } as Mock], dir)).toThrow(/could not be read/);
    expect(() => resolveOpenApiMock({ kind: "openapi", host: "x.test", spec: { swagger: "2.0", paths: {} } as never }, dir)).toThrow(/not an OpenAPI 3 document/);
    expect(() => resolveOpenApiMock({ kind: "openapi", host: "x.test", spec: SOCIAL as never, responses: { nope: { status: 500 } } }, dir)).toThrow(/no operation 'nope'/);
    const n = new DeviceNet({ config: parseNetworkConfig({ mode: "mock" }), mocks: [], ca });
    const file = join(dir, "mocks.json");
    const r = addMockApi(n, m as Mock, file);
    expect(r.ok).toBe(true);
    expect(r.mock).toMatchObject({ kind: "openapi", spec: "social.yaml", operations: ["GET /ping"] });
    expect(JSON.parse(readFileSync(file, "utf8")).mocks[0]).toEqual({ kind: "openapi", host: "api.y.test", spec: "social.yaml" });
    n.close();
  });
});

describe("the clock a test sets", () => {
  it("NTP answers the set time, advancing with the network clock; undefined goes back to wall time", () => {
    let now = 1000;
    const n = new DeviceNet({ config: parseNetworkConfig({ mode: "mock" }), mocks: [], ca, clock: { now: () => now, wallMs: () => Date.now(), sleep: async () => {} } });
    const q = Buffer.alloc(48);
    q[0] = 0x23;
    n.setClock(Date.parse("2026-12-24T09:00:00Z"));
    now += 90_000;
    expect(new Date(parseNtpTransmitMs(n.udp("10.0.2.2", 123, q)!)).toISOString()).toBe("2026-12-24T09:01:30.000Z");
    // configTime("pool.ntp.org") resolves in mock mode: the sandbox is the time server
    expect(lookup(n, "pool.ntp.org").ip).toMatch(/^198\.1[89]\./);
    expect(lookup(n, "api.not-mocked.test").ip).toBeUndefined();
    n.setClock(undefined);
    expect(Math.abs(parseNtpTransmitMs(n.udp("10.0.2.2", 123, q)!) - Date.now())).toBeLessThan(5000);
    n.close();
  });
});
