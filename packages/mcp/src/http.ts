import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AgentPresence, CallMeta, ProjectSession } from "@jumper/session";
import { createJumperMcpServer, prettyClientName } from "./server.ts";

/**
 * Jumper's MCP server over Streamable HTTP (POST/GET/DELETE /mcp), bound to one shared session.
 * `jumper serve` mounts it next to the web app and the live websocket, so whatever an agent does
 * through it appears on the canvas the person is watching. One MCP session (and one SDK Server) per
 * connected client; all of them call the same ProjectSession through `call` (a queue in serve).
 */

export interface McpHttpOptions {
  dir: string;
  session: ProjectSession;
  call?: (op: string, args: Record<string, unknown>, meta: CallMeta) => Promise<unknown>;
  /** Told whenever the connected-agents list changes (connect, tool start / end, disconnect). */
  onPresence?: (agents: AgentPresence[]) => void;
  /** Appended to the server instructions, e.g. where the person watches. */
  instructionsExtra?: string;
  images?: boolean;
}

export interface McpHttpEndpoint {
  /** Handle a request to the MCP path. Always answers. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  agents(): AgentPresence[];
  close(): Promise<void>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Host header (and Origin, when sent) must be this machine: blocks DNS rebinding and other sites. */
export function localRequestProblem(req: IncomingMessage): string | undefined {
  const host = String(req.headers.host ?? "");
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  if (!LOCAL_HOSTS.has(hostname)) return `Host '${host}' is not this machine. Jumper only answers requests for localhost / 127.0.0.1. Fix: use http://localhost:<port>/mcp.`;
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      const o = new URL(origin);
      if (!LOCAL_HOSTS.has(o.hostname) && !LOCAL_HOSTS.has(`[${o.hostname}]`)) return `Origin '${origin}' is another website. Jumper only accepts requests from pages on localhost. Fix: open the Jumper app from the jumper serve URL.`;
    } catch {
      return `Origin '${origin}' is not a valid URL.`;
    }
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_000_000) throw new Error("request body over 8 MB");
  }
  return raw ? JSON.parse(raw) : undefined;
}

function rpcError(res: ServerResponse, status: number, message: string, id: unknown = null): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 404 ? -32001 : -32000, message }, id }));
}

function targetOf(args: Record<string, unknown>): string | undefined {
  for (const k of ["id", "part", "type", "path", "from", "name"]) if (typeof args[k] === "string") return k === "from" && typeof args.to === "string" ? `${args.from} → ${args.to}` : (args[k] as string);
  return undefined;
}

export function createMcpHttpEndpoint(opts: McpHttpOptions): McpHttpEndpoint {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** streams: open GET event streams; hadStream: the client opened one at some point (so its closing means it left). */
  const agents = new Map<string, AgentPresence & { streams: number; hadStream?: boolean }>();
  const changed = () => opts.onPresence?.(list());
  const list = (): AgentPresence[] => [...agents.values()].map(({ streams: _s, hadStream: _h, ...a }) => a);

  // Drop clients that left without DELETE: their event stream closed (15 s grace for reconnects), or,
  // for clients that never opened one, nothing for 10 min.
  const sweep = setInterval(() => {
    const now = Date.now();
    let drop = false;
    for (const [id, a] of agents) {
      const idle = now - Date.parse(a.lastSeen);
      if (a.streams === 0 && !a.busy && idle > (a.hadStream ? 15_000 : 10 * 60_000)) {
        agents.delete(id);
        drop = true;
      }
    }
    if (drop) changed();
  }, 5_000);
  sweep.unref();

  const newSession = async (req: IncomingMessage) => {
    const via = String(req.headers["x-jumper-transport"] ?? "") === "stdio-attach" ? "stdio-attach" : "http";
    // The presence entry is filled in when the client finishes initialize (clientInfo known).
    const me: { id?: string } = {};
    const touch = (patch: Partial<AgentPresence>) => {
      const a = me.id ? agents.get(me.id) : undefined;
      if (!a) return;
      Object.assign(a, patch, { lastSeen: new Date().toISOString() });
      changed();
    };
    const { server } = createJumperMcpServer({
      dir: opts.dir,
      session: opts.session,
      ...(opts.call ? { call: opts.call } : {}),
      ...(opts.images !== undefined ? { images: opts.images } : {}),
      ...(opts.instructionsExtra ? { instructionsExtra: opts.instructionsExtra } : {}),
      onToolStart: (op, args) => {
        const a = me.id ? agents.get(me.id) : undefined;
        const target = targetOf(args);
        touch({ calls: (a?.calls ?? 0) + 1, busy: { op, ...(typeof args.why === "string" ? { why: args.why } : {}), ...(target ? { target } : {}), since: new Date().toISOString() } });
      },
      onToolEnd: (op, ok, result) => {
        const summary = ok ? undefined : String(result).slice(0, 200);
        const a = me.id ? agents.get(me.id) : undefined;
        const target = a?.busy?.target;
        if (a) delete a.busy;
        touch({ last: { op, ok, ...(target ? { target } : {}), ...(summary ? { summary } : {}), at: new Date().toISOString() } });
      },
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
        me.id = sid;
      },
    });
    server.oninitialized = () => {
      if (!me.id) return;
      const info = server.getClientVersion();
      const now = new Date().toISOString();
      agents.set(me.id, { id: me.id, name: prettyClientName(info?.name), client: info?.name ?? "unknown", ...(info?.version ? { version: info.version } : {}), transport: via, connectedAt: now, lastSeen: now, calls: 0, streams: 0 });
      changed();
    };
    transport.onclose = () => {
      if (!me.id) return;
      transports.delete(me.id);
      if (agents.delete(me.id)) changed();
    };
    await server.connect(transport);
    return transport;
  };

  return {
    async handle(req, res) {
      const problem = localRequestProblem(req);
      if (problem) return rpcError(res, 403, problem);
      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      try {
        if (req.method === "POST") {
          let body: unknown;
          try {
            body = await readJson(req);
          } catch (err) {
            return rpcError(res, 400, `The request body is not valid JSON (${(err as Error).message}). Fix: send one JSON-RPC message or a batch.`);
          }
          if (sessionId) {
            const t = transports.get(sessionId);
            if (!t) return rpcError(res, 404, `MCP session '${sessionId}' is not known to this Jumper server (it restarted, or the session was closed). Fix: reconnect the client (in Claude Code: /mcp, then reconnect 'jumper').`);
            const a = agents.get(sessionId);
            if (a) a.lastSeen = new Date().toISOString();
            return await t.handleRequest(req, res, body);
          }
          const msgs = Array.isArray(body) ? body : [body];
          if (!msgs.some((m) => isInitializeRequest(m))) {
            return rpcError(res, 400, "No mcp-session-id header and the message is not initialize. Fix: start with an initialize request; send the mcp-session-id the server returns on every later request.");
          }
          const t = await newSession(req);
          return await t.handleRequest(req, res, body);
        }
        if (req.method === "GET" || req.method === "DELETE") {
          const t = sessionId ? transports.get(sessionId) : undefined;
          if (!t) return rpcError(res, sessionId ? 404 : 400, sessionId ? `MCP session '${sessionId}' is not known to this Jumper server. Fix: reconnect the client.` : `${req.method} /mcp needs the mcp-session-id header from initialize.`);
          const a = agents.get(sessionId!);
          if (req.method === "GET" && a) {
            a.streams++;
            a.hadStream = true;
            res.on("close", () => {
              a.streams = Math.max(0, a.streams - 1);
              a.lastSeen = new Date().toISOString();
            });
          }
          return await t.handleRequest(req, res);
        }
        res.writeHead(405, { allow: "GET, POST, DELETE", "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `${req.method} is not supported on /mcp. Use POST (messages), GET (event stream) or DELETE (end session).` }, id: null }));
      } catch (err) {
        rpcError(res, 500, `Jumper MCP endpoint failed: ${(err as Error).message}. Fix: retry; if it keeps failing, restart jumper serve and reconnect.`);
      }
    },
    agents: list,
    async close() {
      clearInterval(sweep);
      for (const t of transports.values()) await t.close().catch(() => {});
      transports.clear();
      agents.clear();
    },
  };
}
