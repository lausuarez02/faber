import type { Project } from "@jumper/project-format";
import type { ActionEntry } from "./session.ts";
import type { AgentPresence } from "./live.ts";

/**
 * Round 5 (decision 0003, C6): every message the server sends on ws://…/live, as one union, so the
 * hub (session/live.ts), jumper serve and the web app (apps/web/src/live) agree. New kinds are added
 * here first. Clients ignore kinds they do not know.
 */

/** How long after the last tool call an agent counts as "building" (then "idle"). */
export const AGENT_IDLE_AFTER_MS = 10_000;

/**
 * The one source of truth for "is an agent working" (bottom pill, Install MCP popover, Agent steps).
 *   none      no MCP client has called a tool on this server yet (connecting alone does not count)
 *   building  a tool call arrived less than AGENT_IDLE_AFTER_MS ago, or one is running now
 *   idle      calls happened, none for AGENT_IDLE_AFTER_MS, an MCP session is still open
 *   done      every MCP session that called a tool has ended
 */
export interface AgentState {
  status: "none" | "building" | "idle" | "done";
  /** Display name of the agent that called last ("Claude Code"), when known. */
  agent?: string;
  /** Tool calls made by agents (actor "mcp") on this server since it started: real calls, ok or failed. */
  actions: number;
  /** Failed ones among them. */
  failed: number;
  /** ISO time of the first / last agent tool call. */
  firstCallAt?: string;
  lastCallAt?: string;
  /** The call running now (status building). */
  current?: { op: string; why?: string; target?: string };
}

export type AgentStateEvent = { type: "agent-state"; state: AgentState };

export type LiveServerEvent =
  /** On connect: the project, recent steps and the action-log tail. */
  | { type: "hello"; dir: string; project: Project; steps: unknown[]; entries: ActionEntry[] }
  /** One new action-log line. */
  | { type: "action"; entry: ActionEntry }
  /** Connected MCP clients (raw; the pill uses agent-state). */
  | { type: "presence"; agents: AgentPresence[] }
  /** Answer to a web command {id, op, args}. */
  | { type: "result"; id: string | number; ok: boolean; result?: unknown; error?: string }
  /** Round 5, live track: the agent-state above, sent on connect and on every change. */
  | AgentStateEvent
  /**
   * Round 5, live track: a build produced new firmware. The page fetches GET /api/firmware and,
   * if it was running, restarts with it. `hash` is the content hash of the hex.
   */
  | { type: "firmware"; artifact: string; hash: string; board: string; backend: string; at: string }
  /**
   * Round 5, live track: an agent build / run / run_tests just finished OK; a page with auto-run on
   * (default) starts the in-browser simulation so the person sees the device alive.
   */
  | { type: "auto-run"; after: "build" | "run" | "run_tests"; hash?: string }
  /** Round 5, projects track: the server's active project changed; reload everything (a hello follows). */
  | { type: "project"; dir: string; id: string }
  /** Round 5, projects track: a new version exists in the active project's history (C3). */
  | { type: "version"; version: number; at: string; actor: string; why?: string };
