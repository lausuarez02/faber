import { describe, expect, it } from "vitest";
import { createSandboxNetwork, formatReply, mockReply, parseHttpRequest, parsePetQuery, PetAi, sanitizeReply, type LiveProvider } from "../src/index.ts";
import { chooseProvider, startGatewayServer } from "../src/node/index.ts";

const GET = (q: string) => `GET /v1/pet?${q} HTTP/1.0\r\nHost: ai.fabwright\r\n\r\n`;

describe("pet protocol", () => {
  it("parses the query with defaults and clamps stats", () => {
    expect(parsePetQuery("a=feed&f=140&j=-3&e=55&n=Pip!")).toEqual({ action: "feed", food: 100, joy: 0, energy: 55, name: "Pip", seed: 0 });
    expect(parsePetQuery("").action).toBe("talk");
    expect(() => parsePetQuery("a=dance")).toThrow(/unknown action/);
  });

  it("sanitizes any model output to mood|<=60 printable ASCII", () => {
    const req = { food: 80, joy: 80, energy: 80 };
    expect(formatReply(sanitizeReply("Excited|Wheee! “Best” day — ever \u{1F389}", req))).toBe("excited|Wheee! Best day - ever");
    const long = sanitizeReply("happy|" + "word ".repeat(30), req);
    expect(long.text.length).toBeLessThanOrEqual(60);
    expect(long.text.endsWith(" ")).toBe(false);
    expect(sanitizeReply("no tag at all", { food: 10, joy: 80, energy: 80 })).toEqual({ mood: "hungry", text: "no tag at all" });
    expect(sanitizeReply("\n\n  sad | a|b  \nsecond line", req)).toEqual({ mood: "sad", text: "a/b" });
    // Agent eval (claude-ai-pet, 2026-11-09): the live gateway answered "happy|..." once.
    expect(sanitizeReply("happy|\nHi! I missed you so much.", req)).toEqual({ mood: "happy", text: "Hi! I missed you so much." });
  });

  it("mock replies are deterministic and fit the protocol", () => {
    const r = parsePetQuery("a=talk&f=50&j=50&e=50");
    expect(mockReply(r, 3)).toEqual(mockReply(r, 3));
    for (let i = 0; i < 20; i++) {
      for (const a of ["talk", "feed", "play", "sleep", "lonely", "hello"]) {
        const m = mockReply(parsePetQuery(`a=${a}&f=${i * 5}&j=${100 - i * 5}&e=${i * 3}`), i);
        expect(m.text.length).toBeLessThanOrEqual(60);
        expect(m.text).toMatch(/^[ -~]+$/);
      }
    }
  });

  it("parses HTTP requests incrementally", () => {
    expect(parseHttpRequest("GET /v1/pet?a=talk HTTP/1.0\r\nHost: a")).toEqual({ done: false });
    const p = parseHttpRequest(GET("a=talk&f=1"));
    expect(p.done && "request" in p && p.request.query).toBe("a=talk&f=1");
    const post = parseHttpRequest("POST /v1/pet HTTP/1.1\r\nContent-Length: 6\r\n\r\na=play");
    expect(post.done && "request" in post && post.request.body).toBe("a=play");
  });
});

describe("sandbox network", () => {
  it("joins, resolves, answers /v1/pet with the mock after a virtual latency, and logs it", () => {
    const net = createSandboxNetwork();
    expect(net.join("FabwrightNet", "", 100, "esp")).toBe(0);
    expect(net.join("HomeWifi", "x", 100, "esp")).toBe(3);
    expect(net.resolve("ai.fabwright")).toBe("10.0.0.2");
    expect(net.resolve("example.com")).toBeUndefined();
    const s = net.open({ host: "ai.fabwright", ip: "10.0.0.2", port: 80, tls: false, tMs: 200, partId: "esp" });
    if ("error" in s) throw new Error("refused");
    s.write(GET("a=talk&f=50&j=50&e=50").slice(0, 20), 300);
    s.write(GET("a=talk&f=50&j=50&e=50").slice(20), 301);
    expect(s.read(301)).toEqual({ data: "", closed: false });
    const http = net.log.find((e) => e.kind === "http")!;
    if (http.kind !== "http") throw new Error();
    expect(http.latencyMs).toBeGreaterThanOrEqual(400);
    expect(http.latencyMs).toBeLessThan(800);
    const got = s.read(301 + http.latencyMs!);
    expect(got.data).toMatch(/^HTTP\/1\.0 200 OK\r\nContent-Length: \d+\r\nConnection: close\r\n\r\n(happy|hungry|sleepy|sad|excited)\|/);
    expect(s.read(301 + http.latencyMs! + 10).closed).toBe(true);
    expect(http.provider).toBe("mock");
    expect(http.providerLabel).toBe("Mock");
  });

  it("refuses wrong ports and reports wifi_drop", () => {
    const net = createSandboxNetwork();
    expect(net.open({ host: "ai.fabwright", ip: "10.0.0.2", port: 8080, tls: false, tMs: 0, partId: "esp" })).toEqual({ error: "refused" });
    net.setWifiDrop(true, 50);
    expect(net.linkUp()).toBe(false);
    expect(net.accessPoints()).toEqual([]);
    expect(net.join("FabwrightNet", "", 60, "esp")).toBe(3);
    net.setWifiDrop(false, 70);
    expect(net.join("FabwrightNet", "", 80, "esp")).toBe(0);
  });

  it("live mode: the answer arrives when the provider resolves; mock while live is not allowed", async () => {
    let calls = 0;
    const live: LiveProvider = { id: "claude-cli", label: "Claude CLI (test)", ask: async () => (calls++, { mood: "excited", text: "Live hello!" }) };
    let allowed = false;
    const net = createSandboxNetwork({ ai: new PetAi({ mode: "live", live, minIntervalMs: 0 }), liveAllowed: () => allowed });
    const open = () => {
      const s = net.open({ host: "ai.fabwright", ip: "10.0.0.2", port: 80, tls: false, tMs: 0, partId: "esp" });
      if ("error" in s) throw new Error("refused");
      return s;
    };
    const a = open();
    a.write(GET("a=talk"), 10);
    expect(calls).toBe(0); // not allowed: mock answered
    expect(net.status().provider).toBe("mock");
    allowed = true;
    const b = open();
    b.write(GET("a=play&f=10"), 1000);
    expect(b.pending).toBe(true);
    expect(b.read(1010).data).toBe("");
    await net.settle();
    const r = b.read(3400);
    expect(r.data).toContain("excited|Live hello!");
    const e = net.log.filter((x) => x.kind === "http").at(-1)!;
    expect(e.kind === "http" && e.latencyMs).toBe(2400);
    expect(e.kind === "http" && e.providerLabel).toBe("Claude CLI (test)");
  });

  it("live failures are reported, not replaced by a mock answer; calls are rate limited", async () => {
    const fail: LiveProvider = { id: "anthropic-api", label: "Anthropic API (test)", ask: async () => { throw new Error("Anthropic API 401: invalid x-api-key"); } };
    const ai = new PetAi({ mode: "live", live: fail, minIntervalMs: 1000, wallNow: () => 5000 });
    const r = ai.answer(parsePetQuery("a=talk"));
    expect(r.kind).toBe("later");
    if (r.kind !== "later") return;
    const ans = await r.promise;
    expect(ans.status).toBe(502);
    expect(ans.note).toContain("invalid x-api-key");
    const again = ai.answer(parsePetQuery("a=feed"));
    expect(again.kind === "now" && again.answer.status).toBe(429);
  });
});

describe("provider chain", () => {
  it("API key first, mock under tests, explicit choices honoured", () => {
    expect(chooseProvider({ env: { ANTHROPIC_API_KEY: "sk-test" } }).provider?.id).toBe("anthropic-api");
    expect(chooseProvider({ env: { VITEST: "1" } }).provider).toBeUndefined();
    expect(chooseProvider({ env: {}, prefer: "mock" }).provider).toBeUndefined();
    expect(chooseProvider({ env: {}, claudeBin: "/nonexistent/claude-bin" }).reason).toMatch(/no ANTHROPIC_API_KEY and no claude CLI/);
    expect(chooseProvider({ env: {}, claudeBin: process.execPath }).provider?.id).toBe("claude-cli");
    // the key never appears in labels or reasons
    const c = chooseProvider({ env: { ANTHROPIC_API_KEY: "sk-secret-123" } });
    expect(JSON.stringify({ label: c.provider?.label, reason: c.reason })).not.toContain("sk-secret");
  });
});

describe("gateway HTTP server (for real boards)", () => {
  it("answers GET /v1/pet with the mock and explains bad requests", async () => {
    const { server, url } = await startGatewayServer({ port: 0, host: "127.0.0.1" });
    try {
      const ok = await fetch(`${url}/v1/pet?a=talk&f=40&j=70&e=80`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-fabwright-provider")).toBe("mock");
      expect(await ok.text()).toMatch(/^(happy|hungry|sleepy|sad|excited)\|[ -~]{1,60}$/);
      const bad = await fetch(`${url}/v1/pet?a=dance`);
      expect(bad.status).toBe(400);
      expect(await bad.text()).toContain("use one of talk");
    } finally {
      server.close();
    }
  });
});

describe.runIf(process.env.FABWRIGHT_LIVE_AI === "1")("live provider (FABWRIGHT_LIVE_AI=1)", () => {
  it("the chosen provider answers in the pet format", async () => {
    const c = chooseProvider({ env: { ...process.env, VITEST: "" } });
    expect(c.provider, c.reason).toBeDefined();
    const r = await c.provider!.ask(parsePetQuery("a=talk&f=40&j=70&e=80"));
    expect(r.text.length).toBeLessThanOrEqual(60);
    console.log(`${c.provider!.label}: ${formatReply(r)}`);
  }, 60_000);
});
