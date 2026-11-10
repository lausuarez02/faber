import { useMemo } from "react";
import { create } from "zustand";

/** UI state of follow / replay mode (the project itself lives in the main store). */

export type LiveMode = "off" | "follow" | "replay";

export interface LiveStep {
  id: number;
  why: string;
  status: "pending" | "accepted" | "rejected" | "undone";
  ops: string[];
  /** Who made it ("mcp", "cli", "web"); the server accepts the person's own ("web") when made. */
  actor?: string;
}

export interface LiveCursor {
  part: string;
  pin?: string;
  label: string;
  /** Bumps on every move so the overlay re-measures. */
  n: number;
}

export interface TestResultView {
  id: string;
  passed: boolean;
  reason?: string;
}

export interface FidelityView {
  summary: string;
  /** Area → level (ok / approx / missing / n/a). */
  areas: { name: string; level: string }[];
  /** Things to check on the real device. */
  realDevice: string[];
}

export interface LiveState {
  mode: LiveMode;
  connected: boolean;
  source: string;
  dir: string;
  steps: LiveStep[];
  cursor: LiveCursor | undefined;
  /** Current step's "why" / op summary, shown as a caption. */
  caption: { title: string; detail?: string; ok: boolean } | undefined;
  code: { path: string; content: string } | undefined;
  tests: { passed: number; failed: number; results: TestResultView[] } | undefined;
  /** Last fidelity_report: what the simulation does not prove. */
  fidelity: FidelityView | undefined;
  error: string | undefined;
  replay: { playing: boolean; speed: number; index: number; total: number; done: boolean };
  /** Op counter, to show activity. */
  ops: number;
  /** The project has a physical world to show (robot arena or arm). */
  world: "robot" | "arm" | undefined;
  /** Round 5: auto-run after agent builds (followed page). */
  autoRun: boolean;
  /** Hash of the firmware the page has from the server (followed page). */
  firmwareHash: string | undefined;
  /** The agent changed the sketch after that build. */
  firmwareStale: boolean;
  /** Round 6 (switch): who made each step (step id → actors of its ops), from the action log. */
  stepActors: Record<number, string[]>;
  set(p: Partial<LiveState>): void;
}

let cursorSeq = 0;
export const nextCursorN = () => ++cursorSeq;

export const useLive = create<LiveState>()((set) => ({
  mode: "off",
  connected: false,
  source: "",
  dir: "",
  steps: [],
  cursor: undefined,
  caption: undefined,
  code: undefined,
  tests: undefined,
  fidelity: undefined,
  error: undefined,
  replay: { playing: false, speed: 1, index: 0, total: 0, done: false },
  ops: 0,
  world: undefined,
  autoRun: true,
  firmwareHash: undefined,
  firmwareStale: false,
  stepActors: {},
  set: (p) => set(p),
}));

/** ?follow=ws://… → follow; ?replay=<url> → replay. */
export function liveParams(search = typeof location !== "undefined" ? location.search : ""): { mode: LiveMode; url: string; speed: number; autoplay: boolean } {
  const q = new URLSearchParams(search);
  const follow = q.get("follow");
  const replay = q.get("replay");
  const speed = Number(q.get("speed") ?? "1") || 1;
  if (follow) return { mode: "follow", url: follow, speed, autoplay: true };
  if (replay) return { mode: "replay", url: replay, speed, autoplay: q.get("autoplay") !== "0" };
  return { mode: "off", url: "", speed, autoplay: false };
}

/** Round 6 (switch): remember which actor made a step's ops (entries carry step id and actor). */
export function noteStepActors(entries: readonly { step?: { id: number }; actor?: string }[], base: Record<number, string[]> = useLive.getState().stepActors): Record<number, string[]> {
  let out = base;
  for (const e of entries) {
    if (!e.step || !e.actor) continue;
    const have = out[e.step.id] ?? [];
    if (have.includes(e.actor)) continue;
    if (out === base) out = { ...base };
    out[e.step.id] = [...have, e.actor];
  }
  return out;
}

/**
 * Steps the Agent steps panel lists: on a followed page, never the person's own edits (actor "web":
 * the code editor, History restore); agents' steps (MCP, or an agent driving the CLI) and steps of
 * unknown origin stay. A replay shows every step of the recording.
 */
export function agentSteps(steps: readonly LiveStep[], actors: Record<number, string[]>, mode: LiveMode): LiveStep[] {
  if (mode !== "follow") return [...steps];
  return steps.filter((s) => {
    if (s.actor) return s.actor !== "web";
    const a = actors[s.id];
    return !a || a.some((x) => x !== "web");
  });
}

/** The steps the Agent steps panel and the agent pill count (agentSteps of the store). */
export function useAgentSteps(): LiveStep[] {
  const steps = useLive((s) => s.steps);
  const actors = useLive((s) => s.stepActors);
  const mode = useLive((s) => s.mode);
  return useMemo(() => agentSteps(steps, actors, mode), [steps, actors, mode]);
}
