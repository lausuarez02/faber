import { create } from "zustand";

/** UI state of follow / replay mode (the project itself lives in the main store). */

export type LiveMode = "off" | "follow" | "replay";

export interface LiveStep {
  id: number;
  why: string;
  status: "pending" | "accepted" | "rejected" | "undone";
  ops: string[];
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
