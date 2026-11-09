import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallMeta, LiveHubCore, ProjectSession } from "@jumper/session";

/**
 * Round 5 (decision 0003, C3): HTTP endpoints added by a track live in apps/cli/src/routes/<track>.ts
 * instead of the if-chain in serve.ts, so parallel branches do not edit the same lines. serve.ts
 * tries these routes before its own /api 404. Every route is local-only (Host/Origin checked by
 * serve.ts before it gets here).
 */
export interface RouteContext {
  /** The active project folder (projects track may switch it, so read it per request). */
  dir(): string;
  session(): ProjectSession;
  hub: LiveHubCore;
  /** http://localhost:<port> */
  base(): string;
  /** Run a session op through the server's single queue (same path as MCP and the canvas). */
  call(op: string, args: Record<string, unknown>, meta: CallMeta): Promise<unknown>;
  /** JSON response with no-store. */
  json(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
  /** The request body parsed as JSON ({} when empty); throws a readable Error on bad JSON. */
  body<T = Record<string, unknown>>(req: IncomingMessage): Promise<T>;
  /** The CSRF token pages get from GET /api/connect; POST routes that change things check x-jumper-token. */
  token: string;
  /** Round 5, projects track: where projects live and how to switch the active one (serve sets it). */
  projects?: ProjectsHost;
}

/** What jumper serve gives the projects routes (decision 0003, C3). */
export interface ProjectsHost {
  /** Where new projects are created (projects/ for `pnpm start`, else the parent of --project). */
  root: string;
  /** The repo's examples/ folder (read-only cards; opening one copies it). */
  examplesRoot: string;
  /** Make `dir` the active project: new session behind the same MCP endpoint and hub. */
  open(dir: string): Promise<void>;
  /** Called with the new session whenever the active project changes. Returns an unsubscribe. */
  onSessionChange(fn: (session: ProjectSession) => void): () => void;
}

export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Exact path ("/api/projects") or a pattern with named groups (/^\/api\/projects\/(?<id>[^/]+)$/). */
  path: string | RegExp;
  /** Shown in the /api 404 listing, e.g. "GET /api/projects". */
  label: string;
  handle(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, params: Record<string, string>): void | Promise<void>;
}

/**
 * Something a track starts with the server (decision 0003, C3): the agent track starts the AI
 * gateway, the live track derives agent-state from MCP presence and the action log. Called once
 * after the server listens; the returned function runs on close.
 */
export type ServerHook = (ctx: RouteContext) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
