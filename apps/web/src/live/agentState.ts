import { useEffect } from "react";
import { create } from "zustand";
import { serverCandidates, type AgentInfo } from "../connect/client.ts";

/**
 * The one agent state on the page (decision 0003, C6). The server derives it (`faber serve`:
 * none until an MCP client calls a tool, building while calls arrive, idle after 10 s, done when
 * the calling sessions ended) and pushes it on ws://…/live; the bottom pill, the presence avatar,
 * the Install MCP popover, the Agent steps panel and the Live bar all read it from here and from
 * nowhere else. Without a server it stays "none".
 */

export interface AgentState {
  status: "none" | "building" | "idle" | "done";
  agent?: string;
  actions: number;
  failed: number;
  firstCallAt?: string;
  lastCallAt?: string;
  current?: { op: string; why?: string; target?: string };
}

export const NO_AGENT: AgentState = { status: "none", actions: 0, failed: 0 };

interface AgentFeed {
  state: AgentState;
  /** Connected MCP sessions (raw presence; a connected client is not "an agent working"). */
  agents: AgentInfo[];
  /** A Faber server answers. */
  online: boolean;
}

export const useAgentFeed = create<AgentFeed>()(() => ({ state: NO_AGENT, agents: [], online: false }));

/** The follow socket also carries agent-state; it feeds the same store. */
export function feedAgentState(state: AgentState): void {
  useAgentFeed.setState({ state, online: true });
}

let started = false;
let users = 0;
let stop: (() => void) | undefined;

/** One presence socket for the whole page (reconnects, tries each server candidate). */
function start(): () => void {
  let closed = false;
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let i = 0;
  const bases = serverCandidates();
  const open = () => {
    const base = bases[i % bases.length]!;
    try {
      ws = new WebSocket(`${base.replace(/^http/, "ws")}/live?presence`);
    } catch {
      i++;
      retry = setTimeout(open, 3000);
      return;
    }
    let got = false;
    ws.onmessage = (ev) => {
      let m: { type?: string; agents?: AgentInfo[]; state?: AgentState };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "presence" && Array.isArray(m.agents)) {
        got = true;
        useAgentFeed.setState({ agents: m.agents, online: true });
      } else if (m.type === "agent-state" && m.state) {
        got = true;
        useAgentFeed.setState({ state: m.state, online: true });
      }
    };
    ws.onclose = () => {
      if (closed) return;
      if (!got) i++;
      useAgentFeed.setState({ agents: [], online: false });
      retry = setTimeout(open, got ? 1500 : 3000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}

/** Subscribe a component to the shared feed (opens the socket on first use, closes after the last). */
function useFeedConnection(): void {
  useEffect(() => {
    users++;
    if (!started) {
      started = true;
      stop = start();
    }
    return () => {
      users--;
      if (users === 0) {
        // Keep it a moment: panels mount and unmount as people click around.
        setTimeout(() => {
          if (users === 0 && started) {
            started = false;
            stop?.();
            stop = undefined;
          }
        }, 2000);
      }
    };
  }, []);
}

export function useAgentState(): AgentState {
  useFeedConnection();
  return useAgentFeed((s) => s.state);
}

export function useAgentList(): AgentInfo[] {
  useFeedConnection();
  return useAgentFeed((s) => s.agents);
}

/** "place part led1" for the call running now. */
export function currentText(s: AgentState): string | undefined {
  if (!s.current) return undefined;
  return [s.current.op.replace(/_/g, " "), s.current.target].filter(Boolean).join(" ");
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The short status every surface prints: "No agent", "Claude Code building · place part led1"… */
export function agentLabel(s: AgentState): string {
  const who = s.agent ?? "Agent";
  switch (s.status) {
    case "none":
      return "No agent";
    case "building":
      return `${who} building${currentText(s) ? ` · ${currentText(s)}` : ` · ${plural(s.actions, "action")}`}`;
    case "idle":
      return `${who} idle · ${plural(s.actions, "action")}`;
    case "done":
      return `${who} done · ${plural(s.actions, "action")}`;
  }
}
