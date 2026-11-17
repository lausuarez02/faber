import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { TOOLS } from "@faber/session";
import { installSnippets, startFaberServer, type FaberServer } from "../src/serve.ts";

// `faber serve`: one server with the live websocket and MCP over Streamable HTTP on the same session.
const GOLDEN = readFileSync(fileURLToPath(new URL("../../../examples/blink/firmware/blink.hex", import.meta.url)), "utf8");
const BIN = fileURLToPath(new URL("../bin/faber.mjs", import.meta.url));
const fakeBuilder = async (_req: BuildRequest): Promise<BuildResult> => ({ ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" });
const BLINK = 'void setup(){Serial.begin(115200);pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);Serial.println("LED on");delay(1000);digitalWrite(13,LOW);Serial.println("LED off");delay(1000);}\n';

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
const json = (r: ToolResult) => JSON.parse(r.content[0]!.text!) as Record<string, unknown>;

interface Follower {
  msgs: Record<string, unknown>[];
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  close(): void;
}

function follow(url: string): Promise<Follower> {
  const ws = new WebSocket(url);
  const msgs: Record<string, unknown>[] = [];
  const waiters: { pred: (m: Record<string, unknown>) => boolean; ok: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
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
            const t = setTimeout(() => rej(new Error(`no matching websocket message in ${ms} ms; got types ${msgs.map((m) => m.type).join(",")}`)), ms);
            waiters.push({ pred, ok: (m) => (clearTimeout(t), res(m)) });
          }),
        close: () => ws.close(),
      }),
    );
  });
}

describe("faber serve: canvas + MCP over HTTP on one session", () => {
  let dir: string;
  let srv: FaberServer;
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "faber-serve-"));
    srv = await startFaberServer({ dir, port: 0, web: "none", builder: fakeBuilder, launcher: async () => {} });
    client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.mcpUrl)));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await srv?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every tool over Streamable HTTP, with instructions that mention the live canvas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(client.getInstructions()).toMatch(/watching this project live/);
  });

  it("an HTTP tool call shows up on a websocket follower at once, tagged with the client", async () => {
    const f = await follow(srv.wsUrl);
    try {
      await f.waitFor((m) => m.type === "hello");
      const presence = await f.waitFor((m) => m.type === "presence" && Array.isArray(m.agents) && (m.agents as unknown[]).length > 0);
      expect((presence.agents as { name: string; version: string }[])[0]).toMatchObject({ name: "Claude Code", version: "9.9.9", transport: "http" });
      const t0 = Date.now();
      const r = (await client.callTool({ name: "new_project", arguments: { template: "uno", name: "live" } })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const placed = (await client.callTool({ name: "place_part", arguments: { type: "led", why: "status light" } })) as ToolResult;
      expect(json(placed).id).toBe("led1");
      const action = await f.waitFor((m) => m.type === "action" && (m.entry as { op: string }).op === "place_part");
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(action.entry).toMatchObject({ actor: "mcp", client: "claude-code 9.9.9", ok: true, step: { why: "status light" } });
      // Busy state while a tool runs, then the last call.
      await f.waitFor((m) => m.type === "presence" && (m.agents as { busy?: { op: string } }[])[0]?.busy?.op === "place_part");
      await f.waitFor((m) => m.type === "presence" && (m.agents as { last?: { op: string }; busy?: unknown }[])[0]?.last?.op === "place_part" && !(m.agents as { busy?: unknown }[])[0]?.busy);
    } finally {
      f.close();
    }
  });

  it("places, wires, writes, runs Blink over HTTP; the canvas's run command uses the same simulation", async () => {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as ToolResult;
      if (r.isError) throw new Error(`${name}: ${r.content[0]!.text}`);
      return json(r);
    };
    await call("new_project", { template: "uno", name: "blink", overwrite: true });
    await call("place_part", { type: "resistor", props: { resistance: 220 } });
    await call("place_part", { type: "led" });
    await call("connect", { from: "uno.D13", to: "r1.1" });
    await call("connect", { from: "r1.2", to: "led1.A" });
    await call("connect", { from: "led1.C", to: "uno.GND" });
    await call("write_file", { path: "firmware/main.ino", content: BLINK });
    const run = await call("run", { ms: 1500 });
    expect(run.serial).toMatch(/LED on\r\nLED off/);
    // The web view's run continues the same simulation (one session), and is logged as "web".
    const f = await follow(srv.wsUrl);
    try {
      await f.waitFor((m) => m.type === "hello");
      const ws = (f as unknown as { msgs: unknown[] }).msgs;
      expect(ws.length).toBeGreaterThan(0);
    } finally {
      f.close();
    }
    const web = await new Promise<Record<string, unknown>>((ok, bad) => {
      const ws = new WebSocket(srv.wsUrl);
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as Record<string, unknown>;
        if (m.type === "result") {
          ws.close();
          ok(m);
        }
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "command", id: 1, op: "run", args: { ms: 500 } })));
      ws.on("error", bad);
    });
    expect(web).toMatchObject({ ok: true, result: { t_ms: 2000 } });
    const log = readFileSync(join(dir, ".faber/actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { actor: string; op: string });
    expect(log.at(-1)).toMatchObject({ actor: "web", op: "run" });
  });

  it("serves the latest run_tests as a visual report for the Tests panel", async () => {
    const none = await fetch(`${srv.url}/api/visual-report`);
    expect([200, 404]).toContain(none.status);
    if (none.status === 404) expect(await none.text()).toMatch(/Fix: ask your agent to call run_tests/);
    const w = (await client.callTool({ name: "write_scenario", arguments: { id: "blinks", steps: [{ expect_serial: "LED on", within_ms: 1100 }, { expect_pin: "uno.D13", level: "high" }] } })) as ToolResult;
    expect(w.isError).toBeFalsy();
    const r = json((await client.callTool({ name: "run_tests", arguments: { name: "blinks" } })) as ToolResult);
    expect(r.passed).toBe(1);
    expect((r.results as { visual: string[] }[])[0]!.visual[0]).toMatch(/^ok +\d+ms +serial "LED on"/);
    const report = (await (await fetch(`${srv.url}/api/visual-report`)).json()) as { format: string; passed: number; scenarios: { id: string; frames: unknown[] }[] };
    expect(report).toMatchObject({ format: "faber-visual-report/1", passed: 1 });
    expect(report.scenarios[0]!.frames.length).toBeGreaterThan(0);
  });

  // Agent eval (claude-ai-pet, 2026-11-09): following the agent, Run and the Device view could not
  // run the built pet; /?local loads this project and its hex from here so it runs in the browser.
  it("serves the project with its built firmware for /?local", async () => {
    const r = await fetch(`${srv.url}/api/project`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { project: { name: string; parts: unknown[]; firmware?: { artifact?: string } }; hex?: string; dir: string };
    expect(body.project.name).toBe("blink");
    expect(body.project.parts.length).toBeGreaterThan(2);
    expect(body.hex).toBe(readFileSync(join(dir, body.project.firmware!.artifact!), "utf8"));
    expect(body.hex).toMatch(/^:/);
    const evil = await fetch(`${srv.url}/api/project`, { headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
  });

  it("refuses other hosts and origins (DNS rebinding, other websites)", async () => {
    const bad = await fetch(srv.mcpUrl, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toMatch(/another website/);
    const noInit = await fetch(srv.mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(noInit.status).toBe(400);
    expect(await noInit.text()).toMatch(/Fix: start with an initialize request/);
  });

  it("serves install commands and a starter prompt; the launch needs the token", async () => {
    const info = (await (await fetch(`${srv.url}/api/info`)).json()) as { mcpUrl: string; install: { id: string; text: string }[]; starterPrompt: string; token?: string };
    expect(info.token).toBeUndefined();
    expect(info.install.find((i) => i.id === "claude-code")!.text).toBe(`claude mcp add --transport http faber ${srv.mcpUrl}`);
    expect(info.starterPrompt).toMatch(/watching the live canvas/);
    const noToken = await fetch(`${srv.url}/api/launch/claude-code`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(403);
    expect(await noToken.text()).toMatch(/x-faber-token/);
    const cross = await fetch(`${srv.url}/api/connect`, { headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(403);
    const { token } = (await (await fetch(`${srv.url}/api/connect`)).json()) as { token: string };
    const dry = (await (await fetch(`${srv.url}/api/launch/claude-code`, { method: "POST", headers: { "x-faber-token": token }, body: JSON.stringify({ dryRun: true, withPrompt: true }) })).json()) as { ok: boolean; command: string; osascript: string[]; mcpConfigFile: string };
    expect(dry.ok).toBe(true);
    expect(dry.command).toMatch(/^cd '.+' && claude --mcp-config '.+faber-mcp-\d+\.json' '/);
    expect(dry.osascript.at(-1)).toMatch(/^tell application "Terminal" to do script "cd /);
    expect(JSON.parse(readFileSync(dry.mcpConfigFile, "utf8"))).toEqual({ mcpServers: { faber: { type: "http", url: srv.mcpUrl } } });
    // round 12 skill: Claude Code starts in the project folder, where the project skill now is
    expect(info.starterPrompt).toMatch(/faber-hardware skill in this folder/);
    expect(readFileSync(join(srv.dir, ".claude/skills/faber-hardware/SKILL.md"), "utf8")).toMatch(/^---\nname: faber-hardware\n/);
    expect(readFileSync(join(srv.dir, "AGENTS.md"), "utf8")).toMatch(/Written by Faber/);
  });

  it("faber mcp --attach: a stdio client drives the same live session", async () => {
    const f = await follow(srv.wsUrl);
    const stdio = new Client({ name: "codex-mcp-client", version: "0.163.0" });
    try {
      await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp", "--attach", srv.url], stderr: "ignore" }));
      const { tools } = await stdio.listTools();
      expect(tools.length).toBe(TOOLS.length);
      const r = (await stdio.callTool({ name: "place_part", arguments: { type: "pushbutton", why: "feed button" } })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const action = await f.waitFor((m) => m.type === "action" && (m.entry as { op: string }).op === "place_part" && !!(m.entry as { client?: string }).client?.startsWith("codex"));
      expect(action.entry).toMatchObject({ actor: "mcp", client: "codex-mcp-client 0.163.0" });
      const p = await f.waitFor((m) => m.type === "presence" && (m.agents as { name: string }[]).some((a) => a.name === "Codex"));
      expect((p.agents as { name: string; transport: string }[]).find((a) => a.name === "Codex")!.transport).toBe("stdio-attach");
    } finally {
      await stdio.close();
      f.close();
    }
  }, 30_000);

  it("--attach to nothing says how to fix it", async () => {
    const child = spawn(process.execPath, [BIN, "mcp", "--attach", "http://127.0.0.1:9"], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).not.toBe(0);
    expect(err).toMatch(/No Faber server at http:\/\/127\.0\.0\.1:9.*Fix: start it with `pnpm start`/);
  }, 20_000);
});

describe("install snippets", () => {
  it("name the server URL for every agent", () => {
    const s = installSnippets(7780, "/usr/local/bin/node", "/repo/apps/cli/bin/faber.mjs");
    expect(s.map((x) => x.id)).toEqual(["claude-code", "codex", "claude-desktop", "cursor", "stdio"]);
    expect(s[1]!.text).toBe('[mcp_servers.faber]\nurl = "http://localhost:7780/mcp"');
    expect(JSON.parse(s[2]!.text)).toEqual({ mcpServers: { faber: { command: "/usr/local/bin/node", args: ["/repo/apps/cli/bin/faber.mjs", "mcp", "--attach", "http://localhost:7780"] } } });
    expect(JSON.parse(s[3]!.text)).toEqual({ mcpServers: { faber: { url: "http://localhost:7780/mcp" } } });
  });
});
