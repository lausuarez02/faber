import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { composeSvg, listRegisteredProjects, ProjectSession, projectId, registryForProjectDir } from "@jumper/session";
import { parseDiag } from "../src/routes/projects.ts";
import { startJumperServer, type JumperServer } from "../src/serve.ts";

// Round 5, projects track (decision 0003, C3): the Projects gallery, versions, the code editor's
// file and build endpoints, and switching the active project behind one MCP endpoint and hub.
const REPO_EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const SOIL = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/session/test/fixtures/agentparts/parts.json", import.meta.url)), "utf8")) as Record<string, Record<string, unknown>>).soil!;
const GOLDEN = readFileSync(join(REPO_EXAMPLES, "blink/firmware/blink.hex"), "utf8");
const BLINK = 'void setup(){pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}\n';

let failNext = false;
const builder = async (_req: BuildRequest): Promise<BuildResult> =>
  failNext
    ? { ok: false, cached: false, durationMs: 1, hash: "x", diagnostics: [{ severity: "error", file: "firmware/main.ino", line: 2, column: 7, message: "expected ';' before '}' token", hint: "add the missing ';' at the end of the line" }], errors: 1, warnings: 0, libraries: [], logTail: "" }
    : { ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("jumper serve: projects, history, files, build", () => {
  let tmp: string;
  let srv: JumperServer;
  let token: string;
  const oldHome = process.env.JUMPER_HOME;

  const get = async (path: string): Promise<{ status: number; body: Json }> => {
    const r = await fetch(`${srv.url}${path}`);
    return { status: r.status, body: (await r.json()) as Json };
  };
  const send = async (method: string, path: string, body: unknown = {}, withToken = true): Promise<{ status: number; body: Json }> => {
    const r = await fetch(`${srv.url}${path}`, { method, headers: { "content-type": "application/json", ...(withToken ? { "x-jumper-token": token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Json };
  };
  const call = (op: string, args: Record<string, unknown>) => srv.session.call(op, args, { actor: "mcp", client: "claude-code 9.9.9" });

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "jumper-projects-"));
    process.env.JUMPER_HOME = join(tmp, "home");
    const examples = join(tmp, "examples");
    cpSync(join(REPO_EXAMPLES, "blink"), join(examples, "blink"), { recursive: true });
    mkdirSync(join(examples, "agent-built"), { recursive: true });
    cpSync(join(REPO_EXAMPLES, "agent-built/codex-rover"), join(examples, "agent-built/codex-rover"), { recursive: true });
    srv = await startJumperServer({ dir: join(tmp, "projects/playground"), port: 0, web: "none", builder, examplesRoot: examples, launcher: async () => {} });
    token = ((await (await fetch(`${srv.url}/api/connect`)).json()) as { token: string }).token;
  }, 30_000);

  afterAll(async () => {
    await srv?.close();
    if (oldHome === undefined) delete process.env.JUMPER_HOME;
    else process.env.JUMPER_HOME = oldHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("gives the session the hooks new_project {folder} uses (C3)", () => {
    expect(srv.session.projectsRoot).toBe(join(tmp, "projects"));
    expect(srv.session.openProject).toBeTypeOf("function");
  });

  it("records every change as a version with who, why and what changed", async () => {
    await call("new_project", { template: "uno", name: "Night light", why: "start" });
    await call("place_part", { type: "led", id: "led1", why: "a status light" });
    await call("place_part", { type: "resistor", id: "r1", props: { resistance: 220 }, why: "limit the LED current" });
    await call("connect", { from: "uno.D13", to: "r1.1", why: "wire it" });
    await call("connect", { from: "r1.2", to: "led1.A", why: "wire it" });
    await call("connect", { from: "led1.C", to: "uno.GND", why: "wire it" });
    await call("write_file", { path: "firmware/main.ino", content: BLINK, why: "blink the LED" });
    await call("run", { ms: 1200 });

    const { status, body } = await get("/api/history");
    expect(status).toBe(200);
    const versions = body.versions as Json[];
    expect(versions.length).toBe(7);
    expect(versions[0]).toMatchObject({ version: 1, op: "new_project", actor: "mcp", client: "claude-code 9.9.9", why: "start" });
    expect(versions[1]!.changes.added).toEqual(["part:led1"]);
    expect(versions[3]!.changes.added).toEqual([expect.stringMatching(/^wire:/)]);
    expect(versions[6]).toMatchObject({ op: "write_file", why: "blink the LED", hasFrame: true });
    expect(versions[6]!.changes.changed).toContain("file:firmware/main.ino");
    expect(versions[6]!.firmwareHash).toMatch(/^[0-9a-f]{64}$/);

    const v2 = (await get("/api/history/2")).body;
    expect(v2.project.parts.map((p: Json) => p.id)).toEqual(["uno", "led1"]);
    // new_project's template sketch is not in the log; it comes from the undo history.
    expect(v2.files["firmware/main.ino"]).toMatch(/setup/);
    expect(v2.files["firmware/main.ino"]).not.toBe(BLINK);
    expect(v2.frame).toBeUndefined();
    const v7 = (await get("/api/history/7")).body;
    expect(v7.files["firmware/main.ino"]).toBe(BLINK);
    expect(v7.firmware.hex).toBe(GOLDEN);
    expect(Object.keys(v7.frame.parts)).toContain("led1");

    const svg = await fetch(`${srv.url}/api/history/7/preview.svg`);
    expect(svg.headers.get("content-type")).toMatch(/svg/);
    expect(await svg.text()).toMatch(/^<svg/);

    const missing = await get("/api/history/99");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/No version 99\. Why: .*versions 1 to 7.*Fix:/);
  });

  it("restores a version as a new undoable step, files included", async () => {
    const noToken = await send("POST", "/api/history/2/restore", {}, false);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error).toMatch(/Why: .*Fix: /);

    const r = await send("POST", "/api/history/2/restore", { why: "back to the bare LED" });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(r.body.changes.removed).toEqual(expect.arrayContaining(["part:r1", "wire:w1"]));
    expect(r.body.changes.changed).toContain("file:firmware/main.ino");
    expect(srv.session.project.parts.map((p) => p.id)).toEqual(["uno", "led1"]);
    expect(readFileSync(join(srv.dir, "firmware/main.ino"), "utf8")).not.toBe(BLINK);
    const versions = (await get("/api/history")).body.versions as Json[];
    expect(versions.at(-1)).toMatchObject({ version: 8, op: "restore_version", actor: "web", why: "back to the bare LED" });

    await call("undo", {});
    expect(srv.session.project.parts.map((p) => p.id)).toEqual(["uno", "led1", "r1"]);
    expect(readFileSync(join(srv.dir, "firmware/main.ino"), "utf8")).toBe(BLINK);
    // The undo is version 9 and its file content comes back from the undo history.
    const v9 = (await get("/api/history/9")).body;
    expect(v9.files["firmware/main.ino"]).toBe(BLINK);

    const bad = await send("POST", "/api/history/42/restore", {});
    expect(bad.status).toBe(404);
  });

  it("reads, writes and builds firmware files for the code editor", async () => {
    const files = (await get("/api/files")).body;
    expect(files.files).toEqual([{ path: "firmware/main.ino", size: BLINK.length }]);
    expect(files.main).toBe("firmware/main.ino");
    expect((await get("/api/file?path=firmware/main.ino")).body.content).toBe(BLINK);
    expect((await get("/api/file?path=../jumper.json")).status).toBe(400);
    const nope = await get("/api/file?path=firmware/nope.ino");
    expect(nope.status).toBe(404);
    expect(nope.body.error).toMatch(/firmware\/main\.ino/);

    const saved = await send("PUT", "/api/file", { path: "firmware/main.ino", content: BLINK.replace("500", "250") });
    expect(saved.status).toBe(200);
    const last = ((await get("/api/history")).body.versions as Json[]).at(-1)!;
    expect(last).toMatchObject({ op: "write_file", actor: "web", why: "edited in the code editor" });

    const ok = await send("POST", "/api/build", { run: true, ms: 500 });
    expect(ok.body).toMatchObject({ ok: true, diagnostics: [] });
    expect(ok.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.body.run.t_ms).toBeGreaterThan(0);

    failNext = true;
    try {
      await send("PUT", "/api/file", { path: "firmware/main.ino", content: "void setup(){}\nvoid loop(){ int x = 1 }\n" });
      const bad = await send("POST", "/api/build", { run: true });
      expect(bad.body.ok).toBe(false);
      expect(bad.body.diagnostics).toEqual([{ severity: "error", file: "firmware/main.ino", line: 2, column: 7, message: "expected ';' before '}' token", hint: "add the missing ';' at the end of the line" }]);
      expect(bad.body.run).toBeUndefined();
    } finally {
      failNext = false;
    }
    expect(parseDiag("firmware/a/a.ino:5:3: expected ';' (fix: add it)", "error")).toEqual({ severity: "error", file: "firmware/a/a.ino", line: 5, column: 3, message: "expected ';'", hint: "add it" });
  });

  it("lists projects and examples with board, tests and thumbnails", async () => {
    await call("run_tests", {});
    const { body } = await get("/api/projects");
    expect(body.active).toBe(projectId(srv.dir));
    const active = (body.projects as Json[])[0]!;
    expect(active).toMatchObject({ id: projectId(srv.dir), name: "Night light", kind: "project", board: "arduino-uno", boardName: "Arduino Uno R3", parts: 3, readOnly: false });
    expect(active.versions).toBeGreaterThan(8);
    expect(active.thumbnail).toMatch(new RegExp(`^/api/projects/${active.id}/thumbnail\\.png\\?v=[0-9a-f]{12}$`));
    const examples = body.examples as Json[];
    expect(examples.map((e) => e.kind)).toEqual(["example", "agent-built"]);
    expect(examples[0]).toMatchObject({ name: "Blink", readOnly: true, parts: 3, description: expect.stringMatching(/Blink sketch/) });
    // The agent-built rover's tests come from its committed agent log; its blurb from the README.
    expect(examples[1]!.tests).toMatchObject({ passed: 2, total: 2 });
    expect(examples[1]!.description).toBeTruthy();

    const detail = await get(`/api/projects/${examples[0]!.id}`);
    expect(detail.body.files).toContain("firmware/blink/blink.ino");

    const thumb = await fetch(`${srv.url}${examples[0]!.thumbnail}`);
    expect(thumb.status).toBe(200);
    const type = thumb.headers.get("content-type") ?? "";
    expect(type).toMatch(/image\/(png|svg\+xml)/);
    if (type === "image/png") {
      expect(existsSync(join(process.env.JUMPER_HOME!, "thumbs"))).toBe(true);
      // Second request comes from the cache.
      expect((await fetch(`${srv.url}${examples[0]!.thumbnail}`)).status).toBe(200);
    }
  }, 60_000);

  it("a pocket RP2040 project with an agent-made part shows up with its board, its parts and their drawing", async () => {
    // Made by another process (an agent on stdio), not the active project.
    const dir = join(tmp, "projects", "pocket-sensor");
    mkdirSync(dir, { recursive: true });
    const other = new ProjectSession({ dir, builder, actor: "mcp" });
    try {
      await other.call("new_project", { template: "xiao-rp2040", name: "Pocket sensor" });
      await other.call("create_part", { part: SOIL, why: "the agent's own soil probe" });
      await other.call("place_part", { type: SOIL.id as string, id: "soil" });
    } finally {
      other.dispose();
    }
    const { body } = await get("/api/projects");
    const card = (body.projects as Json[]).find((c) => c.dir === dir)!;
    expect(card).toMatchObject({ name: "Pocket sensor", board: "seeed-xiao-rp2040", boardName: "Seeed XIAO RP2040", agentMade: 1, readOnly: false });
    // The thumbnail draws with that folder's own parts, not the active project's registry.
    const project = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8"));
    const svg = composeSvg(project, registryForProjectDir(dir), {});
    expect(svg).toMatch(/AGENT-MADE/);
    expect(composeSvg(project, srv.session.registry, {})).not.toMatch(/AGENT-MADE/);
    const thumb = await fetch(`${srv.url}${card.thumbnail}`);
    expect(thumb.status).toBe(200);
  }, 60_000);

  it("opens an example as its own copy and switches the live canvas and MCP to it", async () => {
    const before = srv.dir;
    const ws = new WebSocket(`${srv.wsUrl}`);
    const msgs: Json[] = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(String(raw)) as Json));
    await new Promise((r) => ws.once("open", r));
    const waitFor = async (pred: (m: Json) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const hit = msgs.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`no matching message; got ${msgs.map((m) => m.type).join(",")}`);
    };
    await waitFor((m) => m.type === "hello");

    const examples = (await get("/api/projects")).body.examples as Json[];
    const blink = examples.find((e) => e.name === "Blink")!;
    expect((await send("POST", `/api/projects/${blink.id}/open`)).status).toBe(409);

    const made = await send("POST", "/api/projects", { from: blink.id, name: "My blink" });
    expect(made.status).toBe(200);
    expect(made.body.dir).toBe(join(tmp, "projects", "my-blink"));
    expect(srv.dir).toBe(made.body.dir);
    expect(JSON.parse(readFileSync(join(made.body.dir, "jumper.json"), "utf8")).name).toBe("My blink");
    expect(existsSync(join(made.body.dir, "firmware/blink/blink.ino"))).toBe(true);
    // The repo example is untouched, and the old project still has its circuit.
    expect(JSON.parse(readFileSync(join(blink.dir, "jumper.json"), "utf8")).name).toBe("Blink");
    expect(JSON.parse(readFileSync(join(before, "jumper.json"), "utf8")).parts).toHaveLength(3);

    const switched = await waitFor((m) => m.type === "project");
    expect(switched).toMatchObject({ dir: made.body.dir, id: made.body.id });
    const hello = await waitFor((m) => m.type === "hello" && m.dir === made.body.dir);
    expect(hello.project.name).toBe("My blink");
    expect(listRegisteredProjects().map((p) => p.dir)).toContain(made.body.dir);

    // Changes now go to the new project, and its history starts there.
    await call("set_part_property", { id: "led1", prop: "color", value: "green", why: "green is calmer" });
    expect(JSON.parse(readFileSync(join(made.body.dir, "jumper.json"), "utf8")).parts.find((p: Json) => p.id === "led1").props.color).toBe("green");
    const ver = await waitFor((m) => m.type === "version");
    expect(ver).toMatchObject({ version: 1, actor: "mcp", why: "green is calmer" });

    // Back to the first one through its card.
    const list = (await get("/api/projects")).body;
    expect(list.active).toBe(made.body.id);
    const first = (list.projects as Json[]).find((p) => p.dir === before)!;
    expect((await send("POST", `/api/projects/${first.id}/open`)).status).toBe(200);
    expect(srv.dir).toBe(before);
    expect(srv.session.project.name).toBe("Night light");

    // One MCP endpoint: an agent connected before the switch now works on the active project.
    const client = new Client({ name: "claude-code", version: "9.9.9" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.mcpUrl)));
    try {
      const r = (await client.callTool({ name: "get_project", arguments: {} })) as { content: { text: string }[] };
      expect(JSON.parse(r.content[0]!.text).dir).toBe(before);
      await srv.openProject(made.body.dir);
      const r2 = (await client.callTool({ name: "get_project", arguments: {} })) as { content: { text: string }[] };
      expect(JSON.parse(r2.content[0]!.text)).toMatchObject({ dir: made.body.dir, name: "My blink" });
      // Resources read the active project too.
      const res = await client.readResource({ uri: "jumper://project" });
      expect(JSON.stringify(res)).toContain("My blink");
      await srv.openProject(before);
    } finally {
      await client.close();
    }

    const blank = await send("POST", "/api/projects", { name: "Fresh idea" });
    expect(blank.body.dir).toBe(join(tmp, "projects", "fresh-idea"));
    expect(srv.session.project).toMatchObject({ name: "Fresh idea", parts: [] });
    expect((await get("/api/history")).body.versions).toHaveLength(1);
    const badTemplate = await send("POST", "/api/projects", { name: "x", template: "nope" });
    expect(badTemplate.status).toBe(400);
    expect(badTemplate.body.error).toMatch(/No template 'nope'\. Why: .*Fix:/);
    ws.close();
  });
});
