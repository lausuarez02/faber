import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ProjectSession, type ActionEntry } from "./session.ts";
import { stepSummary } from "./history.ts";

/**
 * Live hub: lets the web canvas follow a project that any process edits (MCP server, CLI, another
 * agent). It tails <project>/.jumper/actions.jsonl and broadcasts each new entry over a websocket;
 * the browser sends accept/reject/undo/redo back, which the hub runs on its own session of the
 * same folder (all sessions re-read the folder before every op, so they stay consistent).
 *
 *   ws://127.0.0.1:7782          live events: {type:"hello"|"action"|"result"|"presence"}
 *   GET /log                     the whole action log (JSON lines), for replay; ?actor=mcp&client=claude filters
 *   GET /replay?path=<file>      an action log anywhere under the allowed roots (jumper replay)
 *   GET /health
 */

export interface LiveHubOptions {
  dir: string;
  port?: number;
  host?: string;
  /** Extra action-log files the hub may serve (jumper replay <file>). */
  replayFiles?: string[];
  /** Share an existing session (jumper serve: the MCP endpoint and the canvas drive one session). */
  session?: ProjectSession;
  /** Run a web-view command (default: session.call with actor "web"). jumper serve passes its queue. */
  call?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** One connected agent, as the canvas shows it ("Connected: Claude Code · building · place_part led1"). */
export interface AgentPresence {
  id: string;
  /** Display name: "Claude Code", "Codex", "Cursor"… */
  name: string;
  /** Raw MCP clientInfo name and version. */
  client: string;
  version?: string;
  transport: "http" | "stdio-attach";
  connectedAt: string;
  lastSeen: string;
  calls: number;
  /** The tool call running now. */
  busy?: { op: string; why?: string; target?: string; since: string };
  last?: { op: string; ok: boolean; target?: string; summary?: string; at: string };
}

export interface LiveHub {
  port: number;
  url: string;
  wsUrl: string;
  session: ProjectSession;
  close(): Promise<void>;
}

/** The hub without its own HTTP server: jumper serve mounts it next to the web app and /mcp. */
export interface LiveHubCore {
  session: ProjectSession;
  /** Answers /health, /log, /replay; returns false for any other path. */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean;
  /** Takes a websocket upgrade (live events). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Send to every follower now. */
  broadcast(msg: unknown): void;
  /** Read new action-log lines and broadcast them (called after in-process calls for zero latency). */
  pump(): void;
  /** Replace the connected-agents list and broadcast it ({type: "presence", agents}). */
  setPresence(agents: AgentPresence[]): void;
  followers(): number;
  close(): Promise<void>;
}

const HELLO_TAIL = 400;
const WEB_OPS = new Set(["accept_step", "reject_step", "undo", "redo", "list_steps", "get_project", "run", "interact", "set_sensor_value", "move_part"]);

/** Keep only the lines of an action log written by these actors / clients / sessions (comma lists). */
export function filterActionLog(text: string, f: { actor?: string; client?: string; sid?: string }): string {
  const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
  const actors = list(f.actor);
  const clients = list(f.client).map((c) => c.toLowerCase());
  const sids = list(f.sid);
  if (!actors.length && !clients.length && !sids.length) return text;
  return text
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        const e = JSON.parse(line) as ActionEntry;
        if (actors.length && !actors.includes(e.actor)) return false;
        if (clients.length && !clients.some((c) => (e.client ?? "").toLowerCase().includes(c))) return false;
        if (sids.length && !sids.includes(e.sid ?? "")) return false;
        return true;
      } catch {
        return false;
      }
    })
    .map((l) => l + "\n")
    .join("");
}

/** How many lines each actor wrote ({mcp: 80, cli: 12}), to suggest a filter when a log is mixed. */
export function actorCounts(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = (JSON.parse(line) as ActionEntry).actor ?? "?";
      out[a] = (out[a] ?? 0) + 1;
    } catch {
      // skip
    }
  }
  return out;
}

export function createLiveHub(opts: LiveHubOptions): LiveHubCore {
  const dir = resolve(opts.dir);
  const ownSession = !opts.session;
  const session = opts.session ?? new ProjectSession({ dir, actor: "web" });
  const call = opts.call ?? ((op: string, args: Record<string, unknown>) => session.call(op, args, { actor: "web" }));
  const logFile = session.actionLogFile;
  const allowed = new Set((opts.replayFiles ?? []).map((f) => resolve(f)));
  const clients = new Set<WebSocket>();
  /** Connect menus listening for the agents list only. */
  const watchers = new Set<WebSocket>();
  let presence: AgentPresence[] = [];

  const readLog = (): string => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
  const send = (msg: unknown) => {
    const text = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(text);
  };

  const handleRequest = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    if (url.pathname === "/health") {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, dir, followers: clients.size, agents: presence.length }));
      return true;
    }
    const filter = { actor: url.searchParams.get("actor") ?? undefined, client: url.searchParams.get("client") ?? undefined, sid: url.searchParams.get("sid") ?? undefined };
    if (url.pathname === "/log") {
      res.writeHead(200, { ...headers, "content-type": "application/x-ndjson" });
      res.end(filterActionLog(readLog(), filter));
      return true;
    }
    if (url.pathname === "/replay") {
      const p = resolve(url.searchParams.get("path") ?? "");
      if (!allowed.has(p) && !p.startsWith(dir)) {
        res.writeHead(403, { ...headers, "content-type": "text/plain" });
        res.end(`Not allowed: ${p}. The hub serves the project's own log or files passed to 'jumper replay'.`);
        return true;
      }
      if (!existsSync(p)) {
        res.writeHead(404, { ...headers, "content-type": "text/plain" });
        res.end(`No action log at ${p}.`);
        return true;
      }
      res.writeHead(200, { ...headers, "content-type": "application/x-ndjson" });
      res.end(filterActionLog(readFileSync(p, "utf8"), filter));
      return true;
    }
    return false;
  };

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws, req?: IncomingMessage) => {
    // ?presence: only the connected-agents list (the connect menus), no project, history or actions.
    if (req && new URL(req.url ?? "/", "http://localhost").searchParams.has("presence")) {
      watchers.add(ws);
      ws.on("close", () => watchers.delete(ws));
      ws.send(JSON.stringify({ type: "presence", agents: presence }));
      return;
    }
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    try {
      session.sync();
    } catch {
      // invalid project on disk: still connect, the browser shows the error from the log
    }
    const lines = readLog().trimEnd().split("\n").filter(Boolean);
    const tail = lines.slice(-HELLO_TAIL).flatMap((l) => {
      try {
        return [JSON.parse(l) as ActionEntry];
      } catch {
        return [];
      }
    });
    ws.send(JSON.stringify({ type: "hello", dir, project: session.project, steps: session.history.steps.slice(-30).map(stepSummary), entries: tail.map(stripFrames) }));
    ws.send(JSON.stringify({ type: "presence", agents: presence }));
    ws.on("message", async (raw) => {
      let msg: { type?: string; id?: unknown; op?: string; args?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type !== "command" || !msg.op) return;
      if (!WEB_OPS.has(msg.op)) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: `The web view may not run '${msg.op}'. Allowed: ${[...WEB_OPS].join(", ")}.` }));
        return;
      }
      try {
        const result = await call(msg.op, msg.args ?? {});
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: (err as Error).message }));
      }
    });
  });

  // Tail the action log (other processes write it too: CLI, stdio MCP servers, other agents).
  let offset = existsSync(logFile) ? statSync(logFile).size : 0;
  let partial = "";
  const pump = () => {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size < offset) offset = 0; // truncated / replaced
    if (size === offset) return;
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      partial += buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      send(`{"type":"action","entry":${line}}`);
    }
  };
  const unsubscribe = session.onEvent(() => pump());
  let watcher: FSWatcher | undefined;
  const tryWatch = () => {
    try {
      watcher ??= watch(resolve(dir, ".jumper"), () => pump());
    } catch {
      // folder not there yet; the poll below catches up
    }
  };
  tryWatch();
  const poll = setInterval(() => {
    tryWatch();
    pump();
  }, 250);

  return {
    session,
    handleRequest,
    handleUpgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)),
    broadcast: send,
    pump,
    setPresence(agents) {
      presence = agents;
      const text = JSON.stringify({ type: "presence", agents });
      send(text);
      for (const w of watchers) if (w.readyState === w.OPEN) w.send(text);
    },
    followers: () => clients.size,
    close: () =>
      new Promise<void>((r) => {
        clearInterval(poll);
        watcher?.close();
        unsubscribe();
        for (const c of [...clients, ...watchers]) c.close();
        wss.close(() => r());
        if (ownSession) session.dispose();
      }),
  };
}

/** The hub on its own port (jumper replay, and serve --no-web in older setups). Websocket on any path. */
export function startLiveHub(opts: LiveHubOptions): Promise<LiveHub> {
  const core = createLiveHub(opts);
  const server: Server = createServer((req, res) => {
    if (core.handleRequest(req, res)) return;
    res.writeHead(404, { "access-control-allow-origin": "*", "content-type": "text/plain" });
    res.end("Jumper live hub: connect a websocket here, or GET /log, /replay?path=…, /health.");
  });
  server.on("upgrade", (req, socket, head) => core.handleUpgrade(req, socket, head));

  return new Promise((resolveP, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      void core.close();
      reject(err.code === "EADDRINUSE" ? new Error(`Live hub: port ${opts.port ?? 7782} is in use (another 'jumper serve'?). Fix: stop it or pass --live-port <n>.`) : err);
    });
    server.listen(opts.port ?? 7782, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 7782);
      resolveP({
        port,
        url: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}`,
        session: core.session,
        close: async () => {
          await core.close();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

/** The hello message carries recent history without bulky sim frames (the canvas only needs the last state). */
function stripFrames(e: ActionEntry): ActionEntry {
  if (!e.frames?.length) return e;
  const last = e.frames.at(-1)!;
  const merged: Record<string, unknown> = {};
  for (const f of e.frames) Object.assign(merged, f.states ?? {});
  return { ...e, frames: [{ ...last, states: merged as Record<string, Record<string, string | number | boolean>> }] };
}
