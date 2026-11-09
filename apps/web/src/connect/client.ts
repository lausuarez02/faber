import { useEffect, useState } from "react";

// Connected agents and the agent state live in ../live/agentState.ts (one shared socket, C6).

/**
 * Talks to the local `jumper serve` (default http://localhost:7780): its URLs, install snippets,
 * starter prompt, the agents connected over MCP (live, over a presence-only websocket), and the
 * "Launch Claude Code here" endpoint. Works when the app is served by jumper serve (same origin,
 * launch allowed) and from `pnpm dev` (reads the public /api/info; launch shows the command instead).
 */

export const DEFAULT_SERVER = "http://localhost:7780";

export interface InstallSnippet {
  id: string;
  label: string;
  where: string;
  kind: "command" | "json" | "toml";
  text: string;
  note?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  client: string;
  version?: string;
  transport: "http" | "stdio-attach";
  connectedAt: string;
  lastSeen: string;
  calls: number;
  busy?: { op: string; why?: string; target?: string; since: string };
  last?: { op: string; ok: boolean; target?: string; summary?: string; at: string };
}

export interface ServerInfo {
  name: "jumper";
  url: string;
  mcpUrl: string;
  wsUrl: string;
  project: { dir: string; name: string; parts: number; wires: number; exists: boolean };
  agents: AgentInfo[];
  followers: number;
  install: InstallSnippet[];
  starterPrompt: string;
  launch: { available: boolean; why?: string; command: string; mcpConfigFile: string };
  /** Only when this page is served by the same jumper server. */
  token?: string;
}

export type ConnectState = { status: "loading" } | { status: "offline"; base: string; error: string } | { status: "ok"; base: string; info: ServerInfo };

/** Candidate server addresses: the followed hub (?follow=ws://host/live), this origin, then the default. */
export function serverCandidates(loc: { search: string; origin: string } = location): string[] {
  const out: string[] = [];
  const follow = new URLSearchParams(loc.search).get("follow");
  if (follow) {
    try {
      const u = new URL(follow);
      out.push(`${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`);
    } catch {
      // ignore a bad follow URL; the live layer reports it
    }
  }
  if (/^https?:/.test(loc.origin)) out.push(loc.origin);
  out.push(DEFAULT_SERVER);
  return [...new Set(out)];
}

async function fetchInfo(base: string, signal: AbortSignal): Promise<ServerInfo> {
  const same = typeof location !== "undefined" && base === location.origin;
  // The token endpoint answers only same-origin pages; elsewhere read the public info.
  const r = await fetch(`${base}${same ? "/api/connect" : "/api/info"}`, { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const info = (await r.json()) as ServerInfo;
  if (info?.name !== "jumper") throw new Error("not a Jumper server");
  return info;
}

/** Find the server and keep its info fresh while mounted (every `pollMs`). */
export function useConnectInfo(pollMs = 4000): [ConnectState, () => void] {
  const [state, setState] = useState<ConnectState>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      let lastErr = "";
      for (const base of serverCandidates()) {
        try {
          const info = await fetchInfo(base, AbortSignal.any([ctrl.signal, AbortSignal.timeout(2500)]));
          if (alive) setState({ status: "ok", base, info });
          return;
        } catch (err) {
          lastErr = (err as Error).message;
        }
      }
      if (alive) setState({ status: "offline", base: DEFAULT_SERVER, error: lastErr });
    };
    void load();
    const t = setInterval(load, pollMs);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(t);
    };
  }, [pollMs, tick]);
  return [state, () => setTick((n) => n + 1)];
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export interface LaunchResult {
  ok: boolean;
  command?: string;
  error?: string;
}

/** POST /api/launch/claude-code (needs the same-origin token). */
export async function launchClaudeCode(base: string, token: string, withPrompt: boolean): Promise<LaunchResult> {
  try {
    const r = await fetch(`${base}/api/launch/claude-code`, { method: "POST", headers: { "content-type": "application/json", "x-jumper-token": token }, body: JSON.stringify({ withPrompt }) });
    const body = (await r.json()) as LaunchResult;
    return r.ok ? body : { ok: false, error: body.error ?? `${r.status} ${r.statusText}`, ...(body.command ? { command: body.command } : {}) };
  } catch (err) {
    return { ok: false, error: `Could not reach the Jumper server at ${base} (${(err as Error).message}). Fix: start it with pnpm start.` };
  }
}

/** "place_part led1" / "connect uno.D13 → r1.1": what an agent is doing now, in a few words. */
export function busyText(a: AgentInfo): string | undefined {
  if (!a.busy) return undefined;
  return [a.busy.op.replace(/_/g, " "), a.busy.target].filter(Boolean).join(" ");
}
