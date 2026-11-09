import { createServer, type Server } from "node:http";
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
 *   ws://127.0.0.1:7782          live events: {type:"hello"|"action"|"result"}
 *   GET /log                     the whole action log (JSON lines), for replay
 *   GET /replay?path=<file>      an action log anywhere under the allowed roots (jumper replay)
 *   GET /health
 */

export interface LiveHubOptions {
  dir: string;
  port?: number;
  host?: string;
  /** Extra action-log files the hub may serve (jumper replay <file>). */
  replayFiles?: string[];
}

export interface LiveHub {
  port: number;
  url: string;
  wsUrl: string;
  session: ProjectSession;
  close(): Promise<void>;
}

const HELLO_TAIL = 400;

export function startLiveHub(opts: LiveHubOptions): Promise<LiveHub> {
  const dir = resolve(opts.dir);
  const session = new ProjectSession({ dir, actor: "web" });
  const logFile = session.actionLogFile;
  const allowed = new Set((opts.replayFiles ?? []).map((f) => resolve(f)));
  const clients = new Set<WebSocket>();

  const readLog = (): string => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    if (url.pathname === "/health") {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, dir }));
      return;
    }
    if (url.pathname === "/log") {
      res.writeHead(200, { ...headers, "content-type": "application/x-ndjson" });
      res.end(readLog());
      return;
    }
    if (url.pathname === "/replay") {
      const p = resolve(url.searchParams.get("path") ?? "");
      if (!allowed.has(p) && !p.startsWith(dir)) {
        res.writeHead(403, { ...headers, "content-type": "text/plain" });
        res.end(`Not allowed: ${p}. The hub serves the project's own log or files passed to 'jumper replay'.`);
        return;
      }
      if (!existsSync(p)) {
        res.writeHead(404, { ...headers, "content-type": "text/plain" });
        res.end(`No action log at ${p}.`);
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/x-ndjson" });
      res.end(readFileSync(p, "utf8"));
      return;
    }
    res.writeHead(404, { ...headers, "content-type": "text/plain" });
    res.end("Jumper live hub: connect a websocket here, or GET /log, /replay?path=…, /health.");
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
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
    ws.on("message", async (raw) => {
      let msg: { type?: string; id?: unknown; op?: string; args?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type !== "command" || !msg.op) return;
      const ALLOWED = new Set(["accept_step", "reject_step", "undo", "redo", "list_steps", "get_project", "run", "interact", "set_sensor_value", "move_part"]);
      if (!ALLOWED.has(msg.op)) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: `The web view may not run '${msg.op}'. Allowed: ${[...ALLOWED].join(", ")}.` }));
        return;
      }
      try {
        const result = await session.call(msg.op, msg.args ?? {});
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: (err as Error).message }));
      }
    });
  });

  // Tail the action log.
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
      for (const c of clients) if (c.readyState === c.OPEN) c.send(`{"type":"action","entry":${line}}`);
    }
  };
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

  return new Promise((resolveP, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      clearInterval(poll);
      watcher?.close();
      reject(err.code === "EADDRINUSE" ? new Error(`Live hub: port ${opts.port ?? 7782} is in use (another 'jumper serve'?). Fix: stop it or pass --live-port <n>.`) : err);
    });
    server.listen(opts.port ?? 7782, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 7782);
      resolveP({
        port,
        url: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}`,
        session,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(poll);
            watcher?.close();
            for (const c of clients) c.close();
            wss.close();
            server.close(() => r());
            session.dispose();
          }),
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
