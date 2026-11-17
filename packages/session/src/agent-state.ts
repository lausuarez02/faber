import { AGENT_IDLE_AFTER_MS, type AgentState } from "./live-events.ts";
import type { ActionEntry } from "./session.ts";
import type { AgentPresence } from "./live.ts";

/**
 * Derives the one AgentState (decision 0003, C6) the bottom pill, the Install MCP popover and the
 * Agent steps panel all show. Inputs: the MCP presence list (HTTP clients: connected, busy, calls)
 * and the action-log lines written by agents (actor "mcp", from any process). Connecting alone is
 * not activity: the state stays "none" until an agent actually calls a tool.
 */

export interface AgentStateTrackerOptions {
  /** Called whenever the derived state changes (deduplicated). */
  onChange(state: AgentState): void;
  /** The serving session's sid: log lines with another sid come from a separate MCP process (stdio). */
  ownSid?: string;
  idleAfterMs?: number;
  now?: () => number;
}

export interface AgentStateTracker {
  presence(agents: AgentPresence[]): void;
  action(entry: ActionEntry): void;
  state(): AgentState;
  /** fabwright serve switched the active project: lines from the new session are no longer foreign. */
  setOwnSid(sid: string | undefined): void;
  dispose(): void;
}

/** "claude-code 2.1.319" → "Claude Code" (the same names the MCP endpoint shows). */
export function agentDisplayName(client: string | undefined): string | undefined {
  const raw = (client ?? "").trim().split(/\s+/)[0] ?? "";
  const n = raw.toLowerCase();
  if (!n) return undefined;
  if (n.includes("claude-code")) return "Claude Code";
  if (n.includes("claude-ai")) return "Claude Desktop";
  if (n.includes("codex")) return "Codex";
  if (n.includes("cursor")) return "Cursor";
  if (n.includes("gemini")) return "Gemini CLI";
  return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function createAgentStateTracker(opts: AgentStateTrackerOptions): AgentStateTracker {
  const idleMs = opts.idleAfterMs ?? AGENT_IDLE_AFTER_MS;
  const now = opts.now ?? (() => Date.now());
  let agents: AgentPresence[] = [];
  /** HTTP MCP sessions that have called at least one tool. */
  const callers = new Set<string>();
  /** A separate MCP process (stdio) wrote agent lines: we cannot see when it ends. */
  let foreign = false;
  let actions = 0;
  let failed = 0;
  let firstCall: number | undefined;
  let lastCall: number | undefined;
  let lastName: string | undefined;
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ownSid = opts.ownSid;

  const touch = (t: number) => {
    firstCall ??= t;
    lastCall = Math.max(lastCall ?? 0, t);
  };

  const compute = (): AgentState => {
    const busy = agents.find((a) => a.busy);
    const t = now();
    const recent = lastCall !== undefined && t - lastCall < idleMs;
    const open = agents.some((a) => callers.has(a.id));
    const called = actions > 0 || callers.size > 0 || !!busy;
    const status: AgentState["status"] = !called ? "none" : busy || recent ? "building" : open || foreign ? "idle" : "done";
    const name = busy?.name ?? lastName;
    return {
      status,
      ...(name ? { agent: name } : {}),
      actions,
      failed,
      ...(firstCall !== undefined ? { firstCallAt: new Date(firstCall).toISOString() } : {}),
      ...(lastCall !== undefined ? { lastCallAt: new Date(lastCall).toISOString() } : {}),
      ...(busy?.busy ? { current: { op: busy.busy.op, ...(busy.busy.why ? { why: busy.busy.why } : {}), ...(busy.busy.target ? { target: busy.busy.target } : {}) } } : {}),
    };
  };

  const update = () => {
    const s = compute();
    const text = JSON.stringify(s);
    if (text !== last) {
      last = text;
      opts.onChange(s);
    }
    // Flip "building" to "idle" / "done" when the quiet period ends, without waiting for a call.
    clearTimeout(timer);
    timer = undefined;
    if (s.status === "building" && lastCall !== undefined && !agents.some((a) => a.busy)) {
      timer = setTimeout(update, Math.max(10, lastCall + idleMs - now() + 5));
      (timer as { unref?: () => void }).unref?.();
    }
  };

  return {
    presence(list) {
      agents = list;
      for (const a of list) {
        if (a.calls > 0 || a.busy) {
          callers.add(a.id);
          lastName = a.name;
        }
        if (a.busy) touch(now());
        else if (a.last) touch(Math.min(now(), Date.parse(a.last.at) || now()));
      }
      update();
    },
    action(entry) {
      if (entry.actor !== "mcp") return;
      actions++;
      if (!entry.ok) failed++;
      if (ownSid && entry.sid && entry.sid !== ownSid) foreign = true;
      const name = agentDisplayName(entry.client);
      if (name) lastName = name;
      touch(now());
      update();
    },
    state: compute,
    setOwnSid(sid) {
      ownSid = sid;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
