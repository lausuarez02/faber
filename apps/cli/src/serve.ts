import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLiveHub, ProjectSession, projectId, TOOLS, type AgentPresence, type CallMeta, type LiveHubCore } from "@jumper/session";
import { installProjectFiles } from "@jumper/agent-skill";
import { createMcpHttpEndpoint, localRequestProblem, type McpHttpEndpoint } from "@jumper/mcp";
import { HOOKS, matchRoute, ROUTES, type RouteContext } from "./routes/index.ts";

/**
 * `jumper serve` (and `pnpm start`): one local server for everything.
 *
 *   http://localhost:7780/            the web app, following this project live
 *   ws://localhost:7780/live          live events (hello / action / presence / result)
 *   http://localhost:7780/mcp         MCP over Streamable HTTP, bound to the same session
 *   GET  /api/info                    server URLs, install commands, agents (any local page may read it)
 *   GET  /api/connect                 the same plus a CSRF token (same-origin pages only)
 *   GET  /api/visual-report           the latest run_tests as filmstrips (the web Tests panel)
 *   POST /api/launch/claude-code      open Terminal running `claude` here with Jumper connected (token)
 *   GET  /health, /log, /replay       the live hub's endpoints
 *
 * Every agent call and every canvas command goes through one queue on one ProjectSession, so the
 * canvas shows exactly what the agent is doing, and nothing interleaves.
 */

export const DEFAULT_PORT = 7780;
const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const REPO_EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const CLI_BIN = fileURLToPath(new URL("../bin/jumper.mjs", import.meta.url));

export type WebMode = "dev" | "built" | "none";

export interface JumperServerOptions {
  dir: string;
  /** Preferred port; the next free one is used when it is taken (default 7780). */
  port?: number;
  /** Fail instead of moving to the next port. */
  strictPort?: boolean;
  /** dev: Vite middleware (default when Vite is installed); built: apps/web/dist; none: no web app. */
  web?: WebMode;
  /** Firmware builder override (tests). */
  builder?: ConstructorParameters<typeof ProjectSession>[0]["builder"];
  /** Launch override (tests): receives the osascript arguments instead of running them. */
  launcher?: (cmd: string, args: string[]) => Promise<void>;
  /** Where new projects are created and listed (default: the parent of `dir`; projects/ for pnpm start). */
  projectsRoot?: string;
  /** The examples folder shown in the Projects gallery (default: the repo's examples/). */
  examplesRoot?: string;
}

export interface JumperServer {
  port: number;
  /** http://localhost:<port> */
  url: string;
  mcpUrl: string;
  wsUrl: string;
  /** The active project folder (changes when the Projects gallery or an agent opens another one). */
  readonly dir: string;
  web: WebMode;
  /** The active project's session. */
  readonly session: ProjectSession;
  hub: LiveHubCore;
  /** Switch the active project (same MCP endpoint and websocket, new session). */
  openProject(dir: string): Promise<void>;
  mcp: McpHttpEndpoint;
  /** Install snippets / commands for each agent, with this server's URL in them. */
  info(): ServerInfo;
  close(): Promise<void>;
}

export interface InstallSnippet {
  id: string;
  label: string;
  /** Where it goes ("terminal", "~/.cursor/mcp.json", …). */
  where: string;
  kind: "command" | "json" | "toml";
  text: string;
  note?: string;
}

export interface ServerInfo {
  name: "jumper";
  url: string;
  mcpUrl: string;
  wsUrl: string;
  project: { dir: string; name: string; parts: number; wires: number; exists: boolean };
  agents: AgentPresence[];
  followers: number;
  install: InstallSnippet[];
  starterPrompt: string;
  launch: { available: boolean; why?: string; command: string; mcpConfigFile: string };
}

/** Run calls one at a time (agents and the canvas share one simulation). */
function makeQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function installSnippets(port: number, nodePath = process.execPath, cliBin = CLI_BIN): InstallSnippet[] {
  const http = `http://localhost:${port}/mcp`;
  const attachArgs = [cliBin, "mcp", "--attach", `http://localhost:${port}`];
  return [
    { id: "claude-code", label: "Claude Code", where: "terminal", kind: "command", text: `claude mcp add --transport http jumper ${http}`, note: "Then run `claude` in any folder; /mcp shows jumper connected." },
    { id: "codex", label: "Codex", where: "~/.codex/config.toml", kind: "toml", text: `[mcp_servers.jumper]\nurl = "${http}"`, note: `Or from a terminal: codex mcp add jumper --url ${http}` },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      where: "~/Library/Application Support/Claude/claude_desktop_config.json",
      kind: "json",
      text: JSON.stringify({ mcpServers: { jumper: { command: nodePath, args: attachArgs } } }, null, 2),
      note: "Claude Desktop starts stdio servers; this one forwards to the running Jumper, so the canvas still shows every step. Restart Claude Desktop after editing.",
    },
    { id: "cursor", label: "Cursor", where: "~/.cursor/mcp.json", kind: "json", text: JSON.stringify({ mcpServers: { jumper: { url: http } } }, null, 2) },
    { id: "stdio", label: "Any stdio client", where: "terminal", kind: "command", text: `${nodePath} ${attachArgs.map((a) => (/\s/.test(a) ? sq(a) : a)).join(" ")}`, note: "For clients without HTTP support: a stdio server attached to this canvas." },
  ];
}

export function starterPrompt(url: string, dir: string, session: ProjectSession): string {
  const p = session.project;
  const parts = p.parts.map((x) => `${x.id} (${x.type})`).join(", ");
  return [
    `You are connected to Jumper, a hardware sandbox with a real simulator, through the "jumper" MCP server.`,
    `The person is watching the live canvas at ${url}; every part you place, wire you connect, sketch you write and test you run appears there as you do it, with your "why" as the caption, so always pass a short "why".`,
    `Project folder: ${dir}. ${p.parts.length ? `It has ${p.parts.length} parts (${parts}) and ${p.wires.length} wires; call get_project first.` : "It is empty: start with search_parts."}`,
    `Loop: plan_device → search_parts → get_part → place_part → connect → check_design → write_file → run → write_scenario → run_tests → fix → fidelity_report. Every error says what failed, why, and the fix: do what it says.`,
    `A device to hold: think how the parts go inside (mounting, insertion order, wire room, USB and button access, battery safety): check_fit → propose_layout before design_case, and when asked what is needed, say what to buy, print, assemble and flash, with totals. The full guide is the jumper-hardware skill in this folder (.claude/skills/jumper-hardware/SKILL.md) and the MCP resource jumper://docs/hardware.`,
    `Goal: <describe the device, e.g. "a tamagotchi on an OLED with feed / play buttons" or "a rover that avoids obstacles">.`,
  ].join("\n");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".hex": "text/plain", ".wasm": "application/wasm", ".mp4": "video/mp4", ".gif": "image/gif", ".webp": "image/webp" };

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = resolve(root, `.${path}`);
  if (!file.startsWith(root + sep) && file !== root) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

type ViteDev = { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; close(): Promise<void> };

async function mountVite(http: Server): Promise<ViteDev> {
  const req = createRequire(join(WEB_DIR, "package.json"));
  let vitePath: string;
  try {
    vitePath = req.resolve("vite");
  } catch {
    throw new Error("Cannot find Vite in apps/web. Fix: run `pnpm install` at the repo root, or pass --built to serve apps/web/dist.");
  }
  const vite = (await import(pathToFileURL(vitePath).href)) as { createServer(c: object): Promise<ViteDev> };
  return vite.createServer({
    root: WEB_DIR,
    configFile: join(WEB_DIR, "vite.config.ts"),
    logLevel: "warn",
    appType: "spa",
    server: { middlewareMode: true, ws: { server: http } },
  });
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((ok, bad) => {
    const onErr = (err: NodeJS.ErrnoException) => {
      server.off("listening", onOk);
      bad(err);
    };
    const onOk = () => {
      server.off("error", onErr);
      const a = server.address();
      ok(typeof a === "object" && a ? a.port : port);
    };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(port, host);
  });
}

export async function startJumperServer(opts: JumperServerOptions): Promise<JumperServer> {
  // Round 5 (decision 0003, C3): the active project can change (Projects gallery, new_project
  // {folder}). One MCP endpoint and one hub stay; the session behind them is swapped.
  let dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  const projectsRoot = resolve(opts.projectsRoot ?? dirname(dir));
  const examplesRoot = resolve(opts.examplesRoot ?? REPO_EXAMPLES);
  const sessionListeners = new Set<(s: ProjectSession) => void>();
  const makeSession = (d: string): ProjectSession =>
    new ProjectSession({ dir: d, actor: "mcp", projectsRoot, openProject: (next) => switchProject(next), ...(opts.builder ? { builder: opts.builder } : {}) });
  let session = makeSession(dir);
  const queue = makeQueue();
  const call = (op: string, args: Record<string, unknown>, meta: CallMeta) => queue(() => session.call(op, args, meta));
  const hub = createLiveHub({ dir, session, call: (op, args) => call(op, args, { actor: "web" }) });
  /** Swap the active project. Runs inside a queued call (new_project) or from the queue (open route). */
  const switchProject = async (next: string): Promise<void> => {
    const abs = resolve(next);
    if (abs === dir) return;
    mkdirSync(abs, { recursive: true });
    const old = session;
    session = makeSession(abs);
    dir = abs;
    hub.broadcast({ type: "project", dir: abs, id: projectId(abs) });
    hub.retarget(session);
    for (const fn of sessionListeners) fn(session);
    // The old session may still be finishing the call that asked for the switch: dispose after it.
    setTimeout(() => old.dispose(), 0);
  };
  // MCP resources and instructions read the active session through this view.
  const sessionView = new Proxy({} as ProjectSession, {
    get: (_t, k) => {
      const v = Reflect.get(session, k, session) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(session) : v;
    },
  });
  const token = randomBytes(24).toString("hex");
  let port = 0;
  const base = () => `http://localhost:${port}`;
  const mcp = createMcpHttpEndpoint({
    dir,
    session: sessionView,
    call,
    onPresence: (agents) => hub.setPresence(agents),
    instructionsExtra: "A person is watching this project live on the Jumper canvas: every call you make appears there as you make it, with your \"why\" as the caption. Pass a short \"why\" on every change.",
  });

  const mcpConfigFile = join(tmpdir(), `jumper-mcp-${process.pid}.json`);
  const launchCommand = () => `cd ${sq(dir)} && claude --mcp-config ${sq(mcpConfigFile)}`;
  const info = (): ServerInfo => {
    try {
      session.sync();
    } catch {
      // invalid project on disk: info still answers
    }
    return {
      name: "jumper",
      url: base(),
      mcpUrl: `${base()}/mcp`,
      wsUrl: `ws://localhost:${port}/live`,
      project: { dir, name: session.project.name, parts: session.project.parts.length, wires: session.project.wires.length, exists: session.exists },
      agents: mcp.agents(),
      followers: hub.followers(),
      install: installSnippets(port),
      starterPrompt: starterPrompt(base(), dir, session),
      launch: {
        available: process.platform === "darwin",
        ...(process.platform === "darwin" ? {} : { why: "Launching a terminal is macOS-only for now. Copy the command and run it in a terminal." }),
        command: launchCommand(),
        mcpConfigFile,
      },
    };
  };

  const run = opts.launcher ?? ((cmd: string, args: string[]) => new Promise<void>((ok, bad) => execFile(cmd, args, { timeout: 15_000 }, (err, _o, stderr) => (err ? bad(new Error(stderr.trim() || err.message)) : ok()))));

  const launch = async (req: IncomingMessage, res: ServerResponse) => {
    const problem = localRequestProblem(req);
    if (problem) return json(res, 403, { ok: false, error: problem });
    const remote = req.socket.remoteAddress ?? "";
    if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) return json(res, 403, { ok: false, error: `Launch is only allowed from this machine (request came from ${remote}).` });
    if (req.headers["x-jumper-token"] !== token) return json(res, 403, { ok: false, error: "Missing or wrong x-jumper-token. Why: launching a terminal needs the token from GET /api/connect, which only pages served by this Jumper server can read. Fix: click Launch in the Jumper app opened from the jumper serve URL, or run the command yourself." });
    let body: { dryRun?: boolean; withPrompt?: boolean } = {};
    try {
      let raw = "";
      for await (const c of req) raw += c;
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: "The body must be JSON like {\"withPrompt\": true}." });
    }
    writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { jumper: { type: "http", url: `${base()}/mcp` } } }, null, 2));
    // Round 12 skill: Claude Code starts in the project folder, so the project's skill (and AGENTS.md) load there.
    let agentFiles: string[] = [];
    try {
      agentFiles = installProjectFiles(dir, { tools: TOOLS.map((t) => t.name), projectName: session.project.name }).files.filter((f) => f.action === "written" || f.action === "updated").map((f) => f.path);
    } catch {
      agentFiles = []; // the launch still works without the skill; jumper skill install --project <dir> retries it
    }
    const command = body.withPrompt ? `${launchCommand()} ${sq(starterPrompt(base(), dir, session))}` : launchCommand();
    const script = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const args = ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script "${script}"`];
    if (body.dryRun) return json(res, 200, { ok: true, dryRun: true, command, osascript: args, mcpConfigFile, agentFiles });
    if (process.platform !== "darwin") return json(res, 501, { ok: false, error: "Launching a terminal is macOS-only for now.", fix: `Run this in a terminal: ${command}`, command });
    try {
      await run("osascript", args);
      return json(res, 200, { ok: true, command, mcpConfigFile, agentFiles });
    } catch (err) {
      return json(res, 500, { ok: false, error: `Could not open Terminal: ${(err as Error).message}. Why: macOS may be asking for permission to control Terminal (System Settings → Privacy & Security → Automation). Fix: allow it, or run the command yourself.`, command });
    }
  };

  // Round 5 routes (apps/cli/src/routes/<track>.ts, decision 0003 C3).
  const routeCtx: RouteContext = {
    dir: () => dir,
    session: () => session,
    hub,
    base,
    call,
    json,
    token,
    projects: {
      root: projectsRoot,
      examplesRoot,
      open: (next) => queue(() => switchProject(next)),
      onSessionChange(fn) {
        sessionListeners.add(fn);
        return () => sessionListeners.delete(fn);
      },
    },
    async body<T>(req: IncomingMessage): Promise<T> {
      let raw = "";
      for await (const c of req) raw += c;
      if (!raw) return {} as T;
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new Error("The request body is not JSON. Fix: send a JSON object with content-type application/json.");
      }
    },
  };

  let vite: ViteDev | undefined;
  let web: WebMode = opts.web ?? "dev";
  const distDir = join(WEB_DIR, "dist");

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (p === "/mcp" || p === "/mcp/") return mcp.handle(req, res);
    if (p === "/api/info") {
      const problem = localRequestProblem({ headers: { host: req.headers.host } } as IncomingMessage);
      if (problem) return json(res, 403, { error: problem });
      return json(res, 200, info(), { "access-control-allow-origin": "*" });
    }
    if (p === "/api/connect") {
      const problem = localRequestProblem(req);
      const site = req.headers["sec-fetch-site"];
      if (problem || (site && site !== "same-origin" && site !== "none")) return json(res, 403, { error: problem ?? "Only pages served by this Jumper server may read /api/connect. Fix: use /api/info (no token) from other pages." });
      return json(res, 200, { ...info(), token });
    }
    if (p === "/api/launch/claude-code" && req.method === "POST") return launch(req, res);
    if (p === "/api/visual-report") {
      const problem = localRequestProblem(req);
      if (problem) return json(res, 403, { error: problem });
      const saved = join(dir, ".jumper", "visual-report.json");
      const report = session.lastVisualReport ?? (existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")) as unknown) : undefined);
      if (!report) return json(res, 404, { error: "No test report yet. Why: run_tests has not run on this server's project. Fix: ask your agent to call run_tests (or run `jumper test --visual -p <project>`), then reopen the Tests panel." });
      return json(res, 200, report);
    }
    if (p === "/api/project") {
      // The followed project with its built firmware, so the browser can run a copy (`/?local`).
      const problem = localRequestProblem(req);
      if (problem) return json(res, 403, { error: problem });
      const file = join(dir, "jumper.json");
      if (!existsSync(file)) return json(res, 404, { error: `No jumper.json in ${dir}. Why: the agent has not created the project yet. Fix: wait for its first step (new_project / place_part), then reload.` });
      let project: { firmware?: { artifact?: string; sketch?: string } };
      try {
        project = JSON.parse(readFileSync(file, "utf8")) as typeof project;
      } catch (err) {
        return json(res, 500, { error: `Could not read ${file}: ${(err as Error).message}. Fix: run \`jumper check -p ${dir}\` to see what is wrong with it.` });
      }
      const artifact = project.firmware?.artifact ? join(dir, project.firmware.artifact) : undefined;
      const hex = artifact && existsSync(artifact) ? readFileSync(artifact, "utf8") : undefined;
      return json(res, 200, {
        project,
        hex,
        dir,
        ...(hex ? {} : { warning: `No built firmware${artifact ? ` at ${artifact}` : ""}. Why: the sketch has not been built yet. Fix: ask the agent to call run (it builds first), or run \`jumper build -p ${dir}\`.` }),
      });
    }
    const hit = matchRoute(req.method ?? "GET", p);
    if (hit) {
      const problem = localRequestProblem(req);
      if (problem) return json(res, 403, { error: problem });
      try {
        return await hit.route.handle(req, res, routeCtx, hit.params);
      } catch (err) {
        if (!res.headersSent) json(res, 500, { error: `${hit.route.label} failed: ${(err as Error).message}` });
        return;
      }
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: `No endpoint ${req.method ?? "GET"} ${p}. Endpoints: GET /api/info, GET /api/connect, GET /api/project, GET /api/visual-report, POST /api/launch/claude-code${ROUTES.map((r) => `, ${r.label}`).join("")}.` });
    if (hub.handleRequest(req, res)) return;
    if (web === "none") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`Jumper server for ${dir}\n  MCP: ${base()}/mcp\n  live: ws://localhost:${port}/live\n(started without the web app)\n`);
      return;
    }
    // Opening the server's root follows this project live; ?local, ?example, ?replay open the app as usual.
    if ((p === "/" || p === "/index.html") && ![...url.searchParams.keys()].some((k) => ["follow", "replay", "example", "local"].includes(k))) {
      const host = req.headers.host ?? `localhost:${port}`;
      res.writeHead(302, { location: `/?follow=${encodeURIComponent(`ws://${host}/live`)}` });
      res.end();
      return;
    }
    if (web === "built") return serveStatic(distDir, req, res);
    if (!vite) {
      // The API answers while the dev server still starts; a page request then must not crash the server.
      res.writeHead(503, { "content-type": "text/plain", "retry-after": "1" });
      res.end("Jumper's web app is still starting. Why: the dev server (Vite) is not ready yet. Fix: reload in a second.\n");
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`Not found: ${p}`);
    });
  };

  const primary = createServer((req, res) => void handler(req, res));
  const upgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    const isVite = String(req.headers["sec-websocket-protocol"] ?? "").includes("vite");
    if (isVite) return; // Vite's HMR listener takes it
    if (localRequestProblem(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (p === "/live" || p === "/") hub.handleUpgrade(req, socket, head);
  };
  primary.on("upgrade", upgrade);

  const want = opts.port ?? DEFAULT_PORT;
  for (let tryPort = want; ; tryPort++) {
    try {
      port = await listen(primary, tryPort, "127.0.0.1");
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EADDRINUSE" || opts.strictPort || want === 0 || tryPort - want >= 20) {
        await hub.close();
        await mcp.close();
        session.dispose();
        throw e.code === "EADDRINUSE" ? new Error(`Port ${tryPort} is in use${opts.strictPort ? "" : ` (tried ${want}..${tryPort})`}. Why: another program (maybe another jumper serve) has it. Fix: stop it, or pass --port <n>.`) : e;
      }
    }
  }
  // "localhost" can resolve to ::1 first (Claude Code, browsers): answer there too, same handlers.
  const v6 = createServer((req, res) => void handler(req, res));
  v6.on("upgrade", (req, socket, head) => primary.emit("upgrade", req, socket, head));
  const v6ok = await listen(v6, port, "::1").then(
    () => true,
    () => false,
  );

  if (web === "dev") {
    try {
      vite = await mountVite(primary);
    } catch (err) {
      if (existsSync(join(distDir, "index.html"))) {
        process.stderr.write(`jumper serve: ${(err as Error).message} Serving the last build (apps/web/dist) instead.\n`);
        web = "built";
      } else throw err;
    }
  } else if (web === "built" && !existsSync(join(distDir, "index.html"))) {
    throw new Error("apps/web/dist has no build. Fix: run `pnpm build`, or start without --built (dev mode).");
  }

  // Round 5 server hooks (apps/cli/src/routes/<track>.ts, decision 0003 C3).
  const stops: (() => void | Promise<void>)[] = [];
  for (const hook of HOOKS) {
    const stop = await hook(routeCtx);
    if (typeof stop === "function") stops.push(stop);
  }

  return {
    port,
    url: base(),
    mcpUrl: `${base()}/mcp`,
    wsUrl: `ws://localhost:${port}/live`,
    get dir() {
      return dir;
    },
    web,
    get session() {
      return session;
    },
    hub,
    mcp,
    info,
    openProject: (next) => queue(() => switchProject(next)),
    async close() {
      for (const stop of stops.reverse()) await stop();
      await mcp.close();
      await hub.close();
      await vite?.close();
      primary.closeAllConnections?.();
      if (v6ok) v6.closeAllConnections?.();
      await new Promise<void>((r) => primary.close(() => r()));
      if (v6ok) await new Promise<void>((r) => v6.close(() => r()));
      session.dispose();
    },
  };
}

export { CLI_BIN };
