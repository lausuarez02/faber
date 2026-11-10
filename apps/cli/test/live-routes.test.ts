import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { startJumperServer, type JumperServer } from "../src/serve.ts";

// Round 5, live track (decision 0003, C3/C6): the followed page runs the device itself. The server
// tells it the agent's state, hands it the built hex, and says when to reload / auto-run.
const GOLDEN = readFileSync(fileURLToPath(new URL("../../../examples/blink/firmware/blink.hex", import.meta.url)), "utf8");
const fakeBuilder = async (_req: BuildRequest): Promise<BuildResult> => ({ ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" });
const BLINK = "void setup(){pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}\n";

type Msg = Record<string, unknown>;
function follow(url: string): Promise<{ msgs: Msg[]; waitFor(pred: (m: Msg) => boolean, ms?: number): Promise<Msg>; close(): void }> {
  const ws = new WebSocket(url);
  const msgs: Msg[] = [];
  const waiters: { pred: (m: Msg) => boolean; ok: (m: Msg) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Msg;
    msgs.push(m);
    for (const w of [...waiters])
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.ok(m);
      }
  });
  return new Promise((ok, bad) => {
    ws.once("error", bad);
    ws.once("open", () =>
      ok({
        msgs,
        waitFor: (pred, ms = 5000) =>
          new Promise((res, rej) => {
            const hit = msgs.find(pred);
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error(`no matching message in ${ms} ms; got ${msgs.map((m) => m.type).join(",")}`)), ms);
            waiters.push({ pred, ok: (m) => (clearTimeout(t), res(m)) });
          }),
        close: () => ws.close(),
      }),
    );
  });
}

describe("jumper serve: live track endpoints and events", () => {
  let dir: string;
  let home: string;
  let srv: JumperServer;
  const prevHome = process.env.JUMPER_HOME;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "jumper-live-"));
    home = mkdtempSync(join(tmpdir(), "jumper-home-"));
    process.env.JUMPER_HOME = home;
    srv = await startJumperServer({ dir, port: 0, web: "none", builder: fakeBuilder, launcher: async () => {} });
  }, 30_000);

  afterAll(async () => {
    await srv?.close();
    if (prevHome === undefined) delete process.env.JUMPER_HOME;
    else process.env.JUMPER_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${srv.url}${path}`, { headers });
    return { status: r.status, headers: r.headers, body: (await r.json()) as Msg };
  };

  it("no agent until a tool is called: connecting an MCP client is not activity", async () => {
    expect((await get("/api/agent-state")).body).toMatchObject({ status: "none", actions: 0 });
    const client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.mcpUrl)));
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect((await get("/api/agent-state")).body.status).toBe("none");
      const f = await follow(srv.wsUrl);
      try {
        const first = await f.waitFor((m) => m.type === "agent-state");
        expect(first.state).toMatchObject({ status: "none" });
        await client.callTool({ name: "get_project", arguments: {} });
        const building = await f.waitFor((m) => m.type === "agent-state" && (m.state as { status: string }).status === "building");
        expect(building.state).toMatchObject({ agent: "Claude Code" });
        await f.waitFor((m) => m.type === "agent-state" && (m.state as { actions: number }).actions === 1);
      } finally {
        f.close();
      }
      // The presence-only socket (Install MCP popover) gets the same state.
      const w = await follow(`${srv.wsUrl}?presence`);
      try {
        const s = await w.waitFor((m) => m.type === "agent-state");
        expect(s.state).toMatchObject({ status: "building", actions: 1 });
      } finally {
        w.close();
      }
    } finally {
      await client.close();
    }
    // The session ended (DELETE): done once the quiet period is over, never "building" forever.
    const s = (await get("/api/agent-state")).body;
    expect(["building", "done"]).toContain(s.status);
    expect(s.actions).toBe(1);
  });

  it("GET /api/firmware says why there is nothing to run, with a fix", async () => {
    const r = await get("/api/firmware", { origin: "http://localhost:5200" });
    expect(r.status).toBe(404);
    expect(String(r.body.error)).toMatch(/no board\. Why: .*Fix: ask your agent .*or open an example/);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5200");
  });

  it("an agent build sends firmware + auto-run; GET /api/firmware returns that hex", async () => {
    const client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.mcpUrl)));
    const f = await follow(srv.wsUrl);
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
        if (r.isError) throw new Error(`${name}: ${r.content[0]!.text}`);
      };
      await call("new_project", { template: "uno", name: "live" });
      const noSketch = await get("/api/firmware");
      expect(noSketch.status).toBe(404);
      expect(String(noSketch.body.error)).toMatch(/no sketch yet|not built yet/);
      await call("write_file", { path: "firmware/main.ino", content: BLINK });
      const notBuilt = await get("/api/firmware");
      expect(String(notBuilt.body.error)).toMatch(/not built yet.*Fix:/);
      await call("build", {});
      const hash = createHash("sha256").update(GOLDEN).digest("hex");
      const fw = await f.waitFor((m) => m.type === "firmware");
      expect(fw).toMatchObject({ hash, artifact: "firmware/main.hex", board: "arduino-uno", backend: "avr8js" });
      expect(await f.waitFor((m) => m.type === "auto-run")).toMatchObject({ after: "build", hash });
      const r = await get("/api/firmware");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ hash, hex: GOLDEN, board: "arduino-uno", backend: "avr8js", stale: false });
      // A run that rebuilds nothing auto-runs again but sends no second firmware event.
      await call("run", { ms: 100 });
      await f.waitFor((m) => m.type === "auto-run" && m.after === "run");
      expect(f.msgs.filter((m) => m.type === "firmware")).toHaveLength(1);
      // The person's own run (actor web) never triggers auto-run.
      const before = f.msgs.filter((m) => m.type === "auto-run").length;
      await srv.session.call("run", { ms: 50 }, { actor: "web" });
      srv.hub.pump();
      await new Promise((r) => setTimeout(r, 200));
      expect(f.msgs.filter((m) => m.type === "auto-run")).toHaveLength(before);
      expect(srv.hub.agentState().actions).toBeGreaterThanOrEqual(5);
    } finally {
      f.close();
      await client.close();
    }
  });

  it("after new_project {folder} switches to an RP2040 project, its build reaches the page as rp2040js firmware", async () => {
    const client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.mcpUrl)));
    const f = await follow(srv.wsUrl);
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
        if (r.isError) throw new Error(`${name}: ${r.content[0]!.text}`);
        return JSON.parse(r.content[0]!.text ?? "{}") as Msg;
      };
      const created = await call("new_project", { folder: true, name: "Pocket Pico", template: "pico" });
      expect(created.opened).toBe(true);
      await f.waitFor((m) => m.type === "project" && m.id === created.id);
      await f.waitFor((m) => m.type === "hello" && m.dir === created.dir);
      expect(srv.session.dir).toBe(created.dir);
      await call("build", {});
      const fw = await f.waitFor((m) => m.type === "firmware" && m.board === "raspberry-pi-pico");
      expect(fw).toMatchObject({ backend: "rp2040js" });
      await f.waitFor((m) => m.type === "auto-run" && m.after === "build" && m.hash === fw.hash);
      const r = await get("/api/firmware");
      expect(r.body).toMatchObject({ board: "raspberry-pi-pico", backend: "rp2040js", hash: fw.hash });
    } finally {
      f.close();
      await client.close();
    }
  });
});
