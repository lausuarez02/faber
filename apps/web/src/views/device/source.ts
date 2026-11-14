// What the Device view reads and drives. The view never owns the simulation: the canvas engine
// (or a scrubbed replay, or the standalone harness) steps it, and the view samples it on every
// animation frame. Keeping this tiny interface means one 3D view serves all three.
import type { Project } from "@jumper/project-format";
import type { ColorFrame, Simulation, VisualState } from "@jumper/sim-core";
import type { PhysicsBinding } from "@jumper/physics";

export type RunState = "idle" | "running" | "paused";

export interface DeviceSource {
  /** The project being shown (parts, world). */
  project(): Project;
  /** A part's current visual state, or undefined before the simulation exists. */
  partState(partId: string): VisualState | undefined;
  /** A colour display's frame (TFT), when the part has one. */
  framebuffer?(partId: string): ColorFrame | undefined;
  /** Robot / arm physics, when the project has a world and the simulation is built. */
  world(): PhysicsBinding | undefined;
  /** Virtual time in ms. */
  timeMs(): number;
  runState(): RunState;
  speed(): number;
  /** Measured virtual ms per wall ms (0 when stopped). */
  factor(): number;
  /** Everything printed on serial so far (only the tail is read). */
  serialText(): string;
  run(): void;
  pause(): void;
  setSpeed?(speed: number): void;
  /** Push / let go of a button (or any part with a press interaction). */
  press(partId: string): void;
  release(partId: string): void;
  /** The project's built case (Device view shows it). Default: GET /api/device/case on jumper serve. */
  loadCase?(): Promise<import("./classify.ts").CaseModel | null>;
  /** Subscribe to changes that need a React render (project, run state); returns unsubscribe. */
  subscribe(fn: () => void): () => void;
}

/** The parts of the app Engine the Device view needs (kept structural so the view does not import app singletons). */
export interface EngineLike {
  readonly simulation: Simulation | undefined;
  readonly world: PhysicsBinding | undefined;
  readonly serialText: string;
  /** Round 17: the state the canvas shows (local run, or the followed agent's / replay's pushed state). */
  shownPartState?(partId: string): VisualState | undefined;
  /** Round 17: the frame the canvas shows for a display part. */
  shownFramebuffer?(partId: string): ColorFrame | undefined;
  run(): void;
  pause(): void;
  interact(partId: string, kind: "press" | "release"): void;
  subscribeWorld(fn: () => void): () => void;
}

export interface StoreLike {
  getState(): { project: Project; run: RunState; speed: number; timeMs: number; factor: number; setSpeed(s: number): void };
  subscribe(fn: (s: unknown, prev: unknown) => void): () => void;
}

/**
 * Adapter for the web app: `<DeviceView source={engineSource(engine, useJumper)} />`.
 * The engine keeps stepping the simulation on its own animation frame; this only reads.
 */
export function engineSource(engine: EngineLike, store: StoreLike): DeviceSource {
  return {
    project: () => store.getState().project,
    partState: (id) => {
      if (engine.shownPartState) return engine.shownPartState(id);
      try {
        return engine.simulation?.partState(id);
      } catch {
        return undefined;
      }
    },
    framebuffer: (id) => {
      if (engine.shownFramebuffer) return engine.shownFramebuffer(id);
      try {
        return engine.simulation?.framebuffer?.(id);
      } catch {
        return undefined;
      }
    },
    world: () => engine.world,
    timeMs: () => engine.simulation?.timeMs ?? store.getState().timeMs,
    runState: () => store.getState().run,
    speed: () => store.getState().speed,
    factor: () => store.getState().factor,
    serialText: () => engine.serialText,
    run: () => engine.run(),
    pause: () => engine.pause(),
    setSpeed: (s) => store.getState().setSpeed(s),
    press: (id) => engine.interact(id, "press"),
    release: (id) => engine.interact(id, "release"),
    subscribe: (fn) => {
      let last = store.getState();
      const a = store.subscribe(() => {
        const s = store.getState();
        if (s.project !== last.project || s.run !== last.run || s.speed !== last.speed) fn();
        last = s;
      });
      const b = engine.subscribeWorld(fn);
      return () => {
        a();
        b();
      };
    },
  };
}

/** Options for a source that owns its own Simulation (harness, scrubbed test frames). */
export interface OwnedSimOptions {
  project: Project;
  sim: Simulation;
  physics?: PhysicsBinding | undefined;
  /** Start running immediately (default false). */
  autoRun?: boolean;
  /** Real-time multiplier (default 1). */
  speed?: number;
}

export interface OwnedSimSource extends DeviceSource {
  /** Advance virtual time by `ms` now (deterministic frame capture). */
  step(ms: number): void;
  dispose(): void;
}

/**
 * A source that steps its own Simulation on requestAnimationFrame (same budgeted loop as the app
 * engine). Used by the standalone harness (`dev/index.html`) and by scrubbed test frames.
 */
export function ownedSimSource(opts: OwnedSimOptions): OwnedSimSource {
  const { project, sim, physics } = opts;
  const listeners = new Set<() => void>();
  let state: RunState = "paused";
  let speed = opts.speed ?? 1;
  let factor = 0;
  let raf = 0;
  let last = 0;
  let win = { wall: 0, virt: 0, at: 0 };
  const notify = () => {
    for (const fn of listeners) fn();
  };
  const frame = (now: number) => {
    if (state !== "running") return;
    const wall = Math.min(100, Math.max(0, now - last));
    last = now;
    let todo = wall * speed;
    const t0 = performance.now();
    const v0 = sim.timeMs;
    while (todo > 1e-9) {
      const s = Math.min(2, todo);
      sim.runFor(s);
      todo -= s;
      if (performance.now() - t0 > 12) break;
    }
    win.wall += wall;
    win.virt += sim.timeMs - v0;
    if (now - win.at > 250) {
      factor = win.wall > 0 ? win.virt / win.wall : factor;
      win = { wall: 0, virt: 0, at: now };
    }
    raf = requestAnimationFrame(frame);
  };
  const src: OwnedSimSource = {
    project: () => project,
    partState: (id) => {
      try {
        return sim.partState(id);
      } catch {
        return undefined;
      }
    },
    framebuffer: (id) => {
      try {
        return sim.framebuffer?.(id);
      } catch {
        return undefined;
      }
    },
    world: () => physics,
    timeMs: () => sim.timeMs,
    runState: () => state,
    speed: () => speed,
    factor: () => (state === "running" ? factor : 0),
    serialText: () => sim.serialText(),
    run() {
      if (state === "running") return;
      sim.resume();
      state = "running";
      last = performance.now();
      win = { wall: 0, virt: 0, at: last };
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
      notify();
    },
    pause() {
      cancelAnimationFrame(raf);
      state = "paused";
      notify();
    },
    setSpeed(s) {
      speed = s;
      notify();
    },
    press: (id) => sim.interact(id, { kind: "press" }),
    release: (id) => sim.interact(id, { kind: "release" }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    step(ms) {
      let todo = ms;
      while (todo > 1e-9) {
        const s = Math.min(2, todo);
        sim.runFor(s);
        todo -= s;
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      state = "idle";
      physics?.dispose();
      sim.dispose();
    },
  };
  if (opts.autoRun) src.run();
  return src;
}
