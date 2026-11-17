import type { Project } from "@faber/project-format";
import type { VisualState } from "@faber/sim-core";
import { nextCursorN, noteStepActors, useLive, type FidelityView, type LiveStep, type TestResultView } from "./liveStore.ts";
import { setColorFrames, type ColorFrameImage } from "../lib/colorFrames.ts"; // round 6 frames
import { playRunAudio, type RunAudioRef } from "./runAudio.ts"; // round 13 audio

/**
 * Applies action-log entries (from the live hub or a replay file) to the canvas, and paces a replay.
 * The log format is ActionEntry from @faber/session (one JSON object per line of
 * <project>/.faber/actions.jsonl).
 */

export interface LogFrame {
  vt: number;
  states?: Record<string, VisualState>;
  serial?: string;
  live?: string[];
  /** Round 6 frames: colour screens that changed, as PNGs (decision 0004, R7). */
  color?: Record<string, ColorFrameImage>;
}

export interface LogEntry {
  seq: number;
  t: string;
  vt?: number;
  actor?: string;
  op: string;
  args?: Record<string, unknown>;
  ok: boolean;
  error?: string;
  summary?: string;
  step?: { id: number; why: string };
  target?: { part: string; pin?: string };
  project?: Project;
  file?: { path: string; content: string | null };
  frames?: LogFrame[];
  /** Round 13 audio: what the board played over I2S during a run (served at /api/audio/<file>). */
  audio?: RunAudioRef;
  steps?: LiveStep[];
  result?: unknown;
}

/** What the player needs from the app (kept abstract so it is testable without React). */
export interface CanvasPort {
  getProject(): Project;
  loadProject(p: Project): void;
  showStates(states: Record<string, VisualState> | undefined, live: readonly string[] | undefined, vt: number): void;
  resetStates(): void;
  appendSerial(text: string): void;
  clearSerial(): void;
  /** New parts / wires since the last project, for the pop-in animation. */
  highlightNew(parts: string[], wires: string[]): void;
  fit(): void;
}

/** How long an entry takes on screen at speed 1 (ms of wall time). Fixed per op so videos are paced well. */
export function entryDuration(e: LogEntry, runSpeed = 1): number {
  if (!e.ok) return 1400;
  const span = framesSpan(e.frames);
  switch (e.op) {
    case "new_project":
      return 900;
    case "place_part":
      return 1000;
    case "connect":
      return 650;
    case "disconnect":
    case "remove":
    case "move_part":
      return 600;
    case "write_file":
      return 3200;
    case "set_part_property":
    case "set_libraries":
    case "write_scenario":
      return 900;
    case "build":
      return 1300;
    case "run":
      return Math.min(9000, Math.max(900, span / runSpeed));
    case "run_tests":
      return Math.min(7000, Math.max(1800, span / runSpeed));
    case "interact":
    case "set_sensor_value":
    case "inject_fault":
      return 700;
    case "check_design":
    case "fidelity_report":
      return 1600;
    case "read_display":
    case "screenshot":
    case "export":
      return 900;
    case "undo":
    case "redo":
    case "accept_step":
    case "reject_step":
      return 900;
    default:
      return 350;
  }
}

function framesSpan(frames: LogFrame[] | undefined): number {
  if (!frames?.length) return 0;
  return frames[frames.length - 1]!.vt - frames[0]!.vt;
}

export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEntry);
    } catch {
      // skip a torn line (log being written)
    }
  }
  return out;
}

function caption(e: LogEntry): { title: string; detail?: string; ok: boolean } {
  if (!e.ok) return { title: `${e.op} failed`, detail: e.error?.split(". Fix:")[0], ok: false };
  if (e.op === "fidelity_report") {
    const f = fidelityView(e.result);
    return { title: "Fidelity report: what still needs real hardware", ...(f ? { detail: f.summary } : {}), ok: true };
  }
  // The person's own change (the page: Design case, a restore…): its step's "why" may be the raw op
  // label ("design_case rounded-box"), so say what happened instead (round 6b).
  const own = e.actor === "web";
  const why = own ? (typeof e.args?.why === "string" && e.args.why.trim() ? e.args.why : undefined) : e.step?.why;
  const title = why && e.op !== "run" && e.op !== "run_tests" ? why : (e.summary ?? e.op.replace(/_/g, " "));
  return { title, ...(e.summary && e.summary !== title ? { detail: e.summary } : {}), ok: true };
}

/** Apply the non-timed part of an entry right away; returns the frames to play over time. */
export function applyEntry(e: LogEntry, port: CanvasPort): LogFrame[] {
  const live = useLive.getState();
  const patch: Partial<typeof live> = { ops: live.ops + 1, caption: caption(e) };
  if (e.project) {
    const prev = port.getProject();
    const oldParts = new Set(prev.parts.map((p) => p.id));
    const oldWires = new Set(prev.wires.map((w) => w.id));
    const topoChanged = JSON.stringify([prev.parts.map((p) => [p.id, p.type]), prev.wires.map((w) => [w.from, w.to])]) !== JSON.stringify([e.project.parts.map((p) => [p.id, p.type]), e.project.wires.map((w) => [w.from, w.to])]);
    port.loadProject(e.project);
    port.highlightNew(
      e.project.parts.filter((p) => !oldParts.has(p.id)).map((p) => p.id),
      e.project.wires.filter((w) => !oldWires.has(w.id)).map((w) => w.id),
    );
    if (topoChanged) port.resetStates();
    port.fit();
  }
  if (e.steps) patch.steps = e.steps;
  if (e.step && e.actor) patch.stepActors = noteStepActors([e], live.stepActors);
  if (e.target) patch.cursor = { part: e.target.part, ...(e.target.pin ? { pin: e.target.pin } : {}), label: e.summary ?? e.op, n: nextCursorN() };
  if (e.file?.content) patch.code = { path: e.file.path, content: e.file.content };
  if (e.op === "run_tests" && e.result && typeof e.result === "object") {
    const r = e.result as { passed?: number; failed?: number; results?: TestResultView[] };
    patch.tests = { passed: r.passed ?? 0, failed: r.failed ?? 0, results: (r.results ?? []).map((x) => ({ id: x.id, passed: x.passed, ...(x.reason ? { reason: x.reason } : {}) })) };
  }
  if (e.op === "fidelity_report" && e.ok) {
    const f = fidelityView(e.result);
    if (f) patch.fidelity = f;
  }
  if (!e.ok) patch.error = e.error;
  useLive.getState().set(patch);
  if (e.frames?.length && (e.op === "run_tests" || e.frames[0]!.vt === 0)) {
    // A fresh simulation (restart or a test from 0 ms): clear the console and states.
    port.clearSerial();
    port.resetStates();
  }
  return e.frames ?? [];
}

/** The parts of a fidelity_report result the replay shows (summary, area levels, real-device checks). */
export function fidelityView(result: unknown): FidelityView | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { summary?: unknown; areas?: Record<string, { level?: unknown }>; testOnRealDevice?: unknown };
  if (typeof r.summary !== "string") return undefined;
  const areas = Object.entries(r.areas ?? {})
    .map(([name, a]) => ({ name, level: typeof a?.level === "string" ? a.level : "?" }))
    .filter((a) => a.level !== "n/a");
  const realDevice = Array.isArray(r.testOnRealDevice) ? r.testOnRealDevice.filter((x): x is string => typeof x === "string") : [];
  return { summary: r.summary, areas, realDevice };
}

/** Plays frames over `durationMs` of wall time; returns a cancel function. */
export function playFrames(frames: LogFrame[], durationMs: number, port: CanvasPort, timers: Timers = defaultTimers): () => void {
  if (!frames.length) return () => {};
  const t0 = frames[0]!.vt;
  const span = Math.max(1, frames[frames.length - 1]!.vt - t0);
  const ids: unknown[] = [];
  for (const f of frames) {
    const at = ((f.vt - t0) / span) * durationMs;
    ids.push(
      timers.set(() => {
        setColorFrames(f.color); // round 6 frames: before the states, so the screen repaints with them
        port.showStates(f.states, f.live, f.vt);
        if (f.serial) port.appendSerial(f.serial);
      }, at),
    );
  }
  return () => ids.forEach((id) => timers.clear(id));
}

export interface Timers {
  set(cb: () => void, ms: number): unknown;
  clear(id: unknown): void;
}
const defaultTimers: Timers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Replay controller: entries one after another, each for entryDuration / speed. */
export class ReplayPlayer {
  private i = 0;
  private timer: unknown;
  private cancelFrames: () => void = () => {};
  private speed: number;

  constructor(
    private readonly entries: LogEntry[],
    private readonly port: CanvasPort,
    speed = 1,
    private readonly timers: Timers = defaultTimers,
  ) {
    this.speed = speed;
    useLive.getState().set({ replay: { playing: false, speed, index: 0, total: entries.length, done: false } });
  }

  play(): void {
    if (this.i >= this.entries.length) this.restart();
    this.setReplay({ playing: true });
    this.next();
  }

  pause(): void {
    this.timers.clear(this.timer);
    this.setReplay({ playing: false });
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.setReplay({ speed });
  }

  restart(): void {
    this.pause();
    this.cancelFrames();
    this.i = 0;
    this.port.clearSerial();
    this.port.resetStates();
    useLive.getState().set({ steps: [], cursor: undefined, caption: undefined, code: undefined, tests: undefined, fidelity: undefined, error: undefined, ops: 0 });
    this.setReplay({ index: 0, done: false });
  }

  private next = (): void => {
    const e = this.entries[this.i];
    if (!e) {
      this.setReplay({ playing: false, done: true });
      (globalThis as { __faberReplay?: unknown }).__faberReplay = { done: true, entries: this.entries.length };
      return;
    }
    this.i++;
    // Pure reads add nothing visible: skip them quickly.
    const visible = !!(e.project || e.frames?.length || e.file || e.target || !e.ok || ["build", "run_tests", "check_design", "fidelity_report", "screenshot", "export", "read_display"].includes(e.op));
    const frames = applyEntry(e, this.port);
    const dur = visible ? entryDuration(e) / this.speed : 30;
    this.cancelFrames();
    this.cancelFrames = playFrames(frames, Math.max(0, dur - 60), this.port, this.timers);
    this.setReplay({ index: this.i });
    this.timer = this.timers.set(this.next, dur);
  };

  private setReplay(p: Partial<ReturnType<typeof useLive.getState>["replay"]>): void {
    const cur = useLive.getState().replay;
    useLive.getState().set({ replay: { ...cur, ...p } });
  }
}

/** Live follow: entries arrive in real time; frames of runs play at real speed (faster when long). */
export class FollowPlayer {
  private cancelFrames: () => void = () => {};
  constructor(private readonly port: CanvasPort) {}

  apply(e: LogEntry): void {
    const frames = applyEntry(e, this.port);
    if (frames.length) {
      this.cancelFrames();
      const span = framesSpan(frames);
      this.cancelFrames = playFrames(frames, Math.min(span, 10_000), this.port);
      // Round 13 audio: the run's sound, in step with its frames (only when they play at real speed).
      if (e.audio && span <= 10_000) void playRunAudio(e.audio, frames[0]!.vt);
    }
  }
}
