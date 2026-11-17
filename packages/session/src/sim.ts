import type { Project, PropValue } from "@faber/project-format";
import {
  Simulation,
  decodeMonoFrame,
  type ColorFrame,
  type MonoFrame,
  monoToAscii,
  type PartDefinition,
  type PartModel,
  type PartRegistry,
  type VisualState,
} from "@faber/sim-core";
import { isProcessBackend, type BackendFactory, type McuBackend } from "@faber/sim-core";
import { createNodeBackendFactory, EmulatorError, type QemuNetwork } from "@faber/sim-backends/node";
import { checkEmulator, emulatorLabels, reapEmulators, trackEmulator, untrackEmulator, type ProcessBackendId } from "@faber/runner";
import { attachPhysics, initPhysics, type PhysicsBinding } from "@faber/physics";
import { fail } from "./errors.ts";
import { createSessionNetwork, setWifiDrop, type SessionNetwork } from "./network.ts";
import { COLOR_EVERY_MS, colorFrameImage, colorSig } from "./color-frames.ts";

/**
 * A headless Simulation plus what agents need around it: fault injection, deterministic sensor
 * noise, serial cursors, compact state summaries and frames for live view / replay.
 */

/** Round 15: run() slice while the board deep-sleeps (virtual ms). */
const SLEEP_SLICE_MS = 1000;

export const FAULT_KINDS = ["disconnect", "noisy", "i2c_nack", "i2c_nack_data", "i2c_garbage", "wifi_drop", "clear"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
/** Documented but not simulated yet; inject_fault explains this instead of pretending. */
export const FAULTS_NOT_YET = ["brownout", "clock_drift", "flash_full", "short", "stuck_pin"] as const;

/** A colour screen's pixels as a PNG (decision 0004, R7): native size, base64 without a data: prefix. */
export interface ColorFrameImage {
  w: number;
  h: number;
  png: string;
}

export interface Frame {
  /** Virtual ms. */
  vt: number;
  /** Changed part states only (full state of each changed part). */
  states?: Record<string, VisualState>;
  /** Serial text printed since the previous frame. */
  serial?: string;
  /** Ids of wires carrying a HIGH level (> 1.5 V), when that set changed. */
  live?: string[];
  /** Round 6 (decision 0004, R7, frames track): colour TFT pixels of parts whose screen changed, keyed by part id. */
  color?: Record<string, ColorFrameImage>;
}

interface NoiseSpec {
  prop: string;
  base: number;
  amplitude: number;
}

const HIGH_VOLTS = 1.5;
/** Default simulation slice in run(); a first collision is placed within one slice. */
const COLLISION_RES_MS = 50;

/** Wrap every model so faults can switch it off electrically without rebuilding the sim. */
function faultRegistry(base: PartRegistry, disconnected: Set<string>): PartRegistry {
  const cache = new Map<string, PartDefinition>();
  const wrap = (def: PartDefinition): PartDefinition => ({
    ...def,
    create: (ctx) => {
      const inner = def.create(ctx);
      return new Proxy(inner, {
        get(target, prop) {
          if (prop === "stamp") {
            return (c: Parameters<PartModel["stamp"]>[0]) => {
              if (disconnected.has(ctx.id)) return;
              target.stamp(c);
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
  });
  const get = (t: string) => {
    const d = base.get(t);
    if (!d) return undefined;
    let w = cache.get(t);
    if (!w) cache.set(t, (w = wrap(d)));
    return w;
  };
  return { get, list: () => base.list().map((d) => get(d.spec.id)!) };
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Every backend the Faber server can run: in-process ones, and local emulators it owns (decision 0006). */
const serverFactory: BackendFactory = createNodeBackendFactory({ labels: emulatorLabels(), onProcess: trackEmulator });

/** Docker / image checks are ~100 ms each: a good answer is trusted for this long. */
const CHECK_TTL_MS = 30_000;
const checkedOk = new Map<string, number>();
let reaped = false;

/** The firmware board of a project, when it has one with an mcu block. */
export function firmwareBoardOf(project: Project, registry: PartRegistry): { partId: string; type: string; mcu: NonNullable<PartDefinition["spec"]["mcu"]>; name: string } | undefined {
  const id = project.firmware?.board;
  const part = id ? project.parts.find((p) => p.id === id) : undefined;
  const spec = part ? registry.get(part.type)?.spec : undefined;
  return part && spec?.mcu ? { partId: part.id, type: part.type, mcu: spec.mcu, name: spec.name } : undefined;
}

/** Progress of a local emulator start, for the canvas ("checking Docker", "starting QEMU"…). */
export type PrepareProgress = (step: { stage: "check" | "image" | "start" | "ready"; text: string; ms?: number }) => void;

/**
 * Makes sure a process backend can start (Docker running, image present) and fails with what /
 * why / fix otherwise. In-process boards return at once.
 */
export async function checkBoardRuntime(project: Project, registry: PartRegistry, progress?: PrepareProgress): Promise<void> {
  const board = firmwareBoardOf(project, registry);
  if (!board || !isProcessBackend(board.mcu.backend)) return;
  const backend = board.mcu.backend as ProcessBackendId;
  if ((checkedOk.get(backend) ?? 0) > Date.now()) return;
  progress?.({ stage: "check", text: "checking the emulator (native install or Docker image)" });
  const c = await checkEmulator(backend, board.name);
  if (!c.ok) {
    const [what, rest] = splitWhy(c.message ?? `${board.name} cannot run`);
    fail(c.code ?? "emulator-unavailable", what, rest.why, rest.fix, { board: board.type, backend, image: c.image });
  }
  checkedOk.set(backend, Date.now() + CHECK_TTL_MS);
  if (!reaped) {
    reaped = true;
    void reapEmulators();
  }
}

/** "Can't run X: Docker is not running. Why: … Fix: …" → what / why / fix. */
function splitWhy(msg: string): [string, { why: string; fix: string }] {
  const fixAt = msg.indexOf(" Fix: ");
  const fix = fixAt >= 0 ? msg.slice(fixAt + 6).replace(/\.$/, "") : "see the message";
  const head = fixAt >= 0 ? msg.slice(0, fixAt) : msg;
  const whyAt = head.indexOf(" Why: ");
  const colon = head.indexOf(": ");
  const what = colon > 0 ? head.slice(0, colon) : head;
  const why = (whyAt >= 0 ? `${head.slice(colon + 2, whyAt).replace(/\.$/, "")}; ${head.slice(whyAt + 6)}` : head.slice(colon + 2)).replace(/\.$/, "");
  return [what, { why, fix }];
}

/** An emulator failure (crash, timeout, bad image) as a FaberError with what / why / fix. */
export function emulatorFailure(err: unknown): never {
  if (err instanceof EmulatorError) {
    const [what, rest] = splitWhy(err.message);
    fail(err.code, what, rest.why, rest.fix);
  }
  throw err;
}

export class SimHost {
  /** Round 10: called with the virtual time after every step of run() (the device network's clock). */
  readonly timeListeners = new Set<(timeMs: number) => void>();
  readonly sim: Simulation;
  /** Updated by adoptProps when saved props change while the simulation runs. */
  project: Project;
  readonly registry: PartRegistry;
  readonly hasFirmware: boolean;
  private disconnected = new Set<string>();
  private noise = new Map<string, NoiseSpec>();
  private busFaults = new Map<string, string>();
  private rand = prng(0x5eed);
  private lastNoiseMs = 0;
  /** Byte offset into serialText() of the last read_serial / run report. */
  serialCursor = 0;
  private lastStates = new Map<string, string>();
  private lastLive = "";
  private lastFrameSerial = 0;
  /** Colour screens (decision 0004, R7): what was last put in a frame, per part, and when (virtual ms). */
  private lastColor = new Map<string, { sig: string; vt: number }>();
  /** Robot / arm physics, when the project has a world block. */
  readonly physics: PhysicsBinding | undefined;
  /** When and where the rover first touched a wall or obstacle since t = 0 (run results, scenarios). */
  private firstCollision: { t_ms: number; x: number; y: number; heading: number; with: string[] } | undefined;
  private seenCollisions = 0;
  /** The sandbox Wi-Fi network and pet AI parts like the ESP-01 talk to (packages/session/src/network.ts). */
  readonly network: SessionNetwork = createSessionNetwork();
  private wifiDropPart: string | undefined;

  /** Load the physics engine once (WASM). Call before creating a SimHost for a project with a world. */
  static async preparePhysics(project: Project): Promise<void> {
    if (project.world) await initPhysics();
  }

  /**
   * The way to make a host on the server: a local emulator (process backend) is checked and booted
   * first without blocking the event loop (1 to 3 s), then handed to the Simulation.
   */
  static async create(project: Project, registry: PartRegistry, firmware: string | Uint8Array | undefined, progress?: PrepareProgress, opts?: { network?: QemuNetwork; seed?: number }): Promise<SimHost> {
    await SimHost.preparePhysics(project);
    const board = firmwareBoardOf(project, registry);
    if (!board || !isProcessBackend(board.mcu.backend) || firmware === undefined) return new SimHost(project, registry, firmware);
    await checkBoardRuntime(project, registry, progress);
    // Round 14: a seed makes the chip's hardware RNG (esp_random, random()) repeat its sequence.
    const qemu = { ...(opts?.network ? { network: opts.network } : {}), ...(opts?.seed !== undefined ? { seed: opts.seed } : {}) };
    const factory = Object.keys(qemu).length ? createNodeBackendFactory({ labels: emulatorLabels(), onProcess: trackEmulator, qemu }) : serverFactory;
    const be = factory({ partId: board.partId, type: board.type, mcu: board.mcu });
    const t0 = Date.now();
    progress?.({ stage: "start", text: `starting ${board.mcu.backend === "qemu-esp" ? "Espressif QEMU" : "Renode"} for ${board.name}` });
    try {
      // QEMU boots here without blocking; Renode has no prepare() and starts on its first step,
      // once the parts are attached (it needs their I2C addresses).
      await be.prepare?.(firmware);
    } catch (err) {
      be.dispose?.();
      untrackEmulator(be);
      emulatorFailure(err);
    }
    progress?.({ stage: "ready", text: `${board.name} booted`, ms: Date.now() - t0 });
    return new SimHost(project, registry, firmware, be);
  }

  /** Optional `prepared`: an already booted backend for the firmware board (SimHost.create). */
  constructor(project: Project, registry: PartRegistry, hex: string | Uint8Array | undefined, prepared?: McuBackend) {
    this.project = project;
    this.registry = registry;
    this.hasFirmware = hex !== undefined;
    try {
      this.sim = new Simulation({
        project,
        registry: faultRegistry(registry, this.disconnected),
        backendFactory: prepared ? () => prepared : serverFactory,
        ...(hex !== undefined ? { firmware: hex } : {}),
        services: { network: this.network },
      });
    } catch (err) {
      prepared?.dispose?.();
      emulatorFailure(err);
    }
    if (project.world) {
      try {
        this.physics = attachPhysics(this.sim, project.world);
      } catch (err) {
        this.sim.dispose();
        const msg = (err as Error).message;
        fail("bad-world", "The project's world (arena / robot) is invalid", msg.replace(/\n\s*-\s*/g, "; "), "fix it with set_world (each issue above names the field)");
      }
    }
  }

  get timeMs(): number {
    return this.sim.timeMs;
  }

  /** The firmware runs in a local emulator process (QEMU / Renode), not in this thread. */
  get isProcess(): boolean {
    return this.sim.mcu?.kind === "process";
  }

  dispose(): void {
    this.physics?.dispose();
    this.sim.dispose();
    const mcu = this.sim.mcu;
    if (mcu?.dispose) {
      mcu.dispose();
      untrackEmulator(mcu);
    }
  }

  /** Saved props changed (set_part_property, undo…): apply them live and keep them for reset(). */
  adoptProps(project: Project): string[] {
    const changed = this.sim.adoptProps(project);
    this.project = project;
    return changed;
  }

  /** Back to t = 0 with the same firmware, keeping injected faults (they model the hardware, not the run). */
  /**
   * Round 13: inputs set while it runs that are not part of the saved project (what a camera sees:
   * set_camera_frame, an image or webcam frame from the page). They survive reset() and stay until
   * replaced; tests set their own with camera_frame steps.
   */
  readonly liveProps = new Map<string, Record<string, PropValue>>();

  setLiveProps(partId: string, props: Record<string, PropValue>): void {
    this.liveProps.set(partId, { ...this.liveProps.get(partId), ...props });
    this.sim.setProps(partId, props);
  }

  reset(): void {
    this.network.resetRun();
    this.sim.reset();
    for (const [id, props] of this.liveProps) if (this.sim.partState(id) !== undefined) this.sim.setProps(id, props);
    this.serialCursor = 0;
    this.lastStates.clear();
    this.lastLive = "";
    this.lastFrameSerial = 0;
    this.lastColor.clear();
    this.lastNoiseMs = 0;
    this.rand = prng(0x5eed);
    this.firstCollision = undefined;
    this.seenCollisions = 0;
    this.captureLog = [];
    this.captureSeen.clear();
  }

  // ---- round 14: pictures the cameras took, with their times (expect_capture, preceded_by)
  private cameraIds: string[] | undefined;
  private captureLog: { partId: string; t_ms: number }[] = [];
  private captureSeen = new Map<string, number>();

  /** Every picture a camera part took since t = 0 (virtual ms; two in one slice share the later time). */
  captures(partId?: string): readonly { partId: string; t_ms: number }[] {
    this.watchCaptures();
    return partId ? this.captureLog.filter((c) => c.partId === partId) : this.captureLog;
  }

  /** Camera parts in this simulation (parts whose state has camera_frames). */
  cameraParts(): string[] {
    this.cameraIds ??= this.sim.partIds().filter((id) => typeof this.sim.partState(id)?.camera_frames === "number");
    return this.cameraIds;
  }

  private watchCaptures(): void {
    for (const id of this.cameraParts()) {
      const st = this.sim.partState(id);
      const n = Number(st?.camera_frames ?? 0);
      const seen = this.captureSeen.get(id) ?? 0;
      if (n <= seen) {
        if (n < seen) this.captureSeen.set(id, n); // the part was reset
        continue;
      }
      const t = Number(st?.camera_last_ms ?? this.sim.timeMs);
      for (let k = seen; k < n; k++) this.captureLog.push({ partId: id, t_ms: round(t >= 0 ? t : this.sim.timeMs) });
      this.captureSeen.set(id, n);
    }
  }

  /**
   * Round 14: reboot the firmware board now (reset button / power cycle) with the virtual clock, the
   * parts and the logs going on. The ESP32 emulator keeps what the firmware wrote to flash.
   */
  resetBoard(): void {
    if (!this.sim.resetBoard()) fail("no-board", "Cannot reset the board", "this project has no firmware board running", "place a board and write firmware first");
  }

  /** "first hit crate at ~5230 ms…" or undefined (scenario failures quote it). */
  get firstCollisionNote(): string | undefined {
    const c = this.firstCollision;
    return c ? `first hit ${c.with.join(", ") || "a wall"} at ~${Math.round(c.t_ms)} ms, robot at x ${c.x}, y ${c.y} cm, heading ${c.heading}°` : undefined;
  }

  /** Note the first collision (time, pose, what it hit). Cheap: reads one counter per step. */
  private watchCollisions(): void {
    const rover = this.physics?.rover;
    if (!rover || this.firstCollision) return;
    const n = rover.collisions;
    if (n <= this.seenCollisions) return;
    this.seenCollisions = n;
    const p = rover.pose();
    this.firstCollision = { t_ms: round(this.sim.timeMs), x: round(p.x), y: round(p.y), heading: round(p.heading), with: rover.touchingIds() };
  }

  /** Compact physics summary for run results. */
  worldSummary(): Record<string, unknown> | undefined {
    if (!this.physics) return undefined;
    const snap = this.physics.snapshot();
    const st = snap.stats;
    const out: Record<string, unknown> = {};
    if (snap.robot) {
      out.robot = { x: round(snap.robot.pose.x), y: round(snap.robot.pose.y), heading: round(snap.robot.pose.heading) };
      out.collisions = st.collisions;
      if (this.firstCollision) out.first_collision = { ...this.firstCollision, note: `${this.firstCollisionNote} (time within ${COLLISION_RES_MS} ms)` };
      if (Number.isFinite(st.minClearanceCm)) out.min_clearance_cm = round(st.minClearanceCm);
      out.travelled_cm = round(st.travelledCm);
      if (snap.robot.touching.length) out.touching = snap.robot.touching;
      if (snap.robot.sonar) out.sonar_cm = round(snap.robot.sonar.distanceCm);
    }
    if (snap.arm) {
      out.arm = { gripper: { x: round(snap.arm.pose.end.x), y: round(snap.arm.pose.end.y) }, reached: snap.arm.pose.reached, targets: snap.arm.spec.targets.map((t) => t.id) };
    }
    out.assert = "scenarios can check these with expect_part \"world.<field>\"; fields: " + Object.keys(this.worldFields() ?? {}).join(", ");
    return out;
  }

  /**
   * Flat world values for scenarios (`expect_part: "world.collisions"`): collisions, min_clearance_cm,
   * travelled_cm, x, y, heading, sonar_cm (robot); gripper_x, gripper_y, reached (arm; comma list).
   */
  worldFields(): Record<string, number | string> | undefined {
    if (!this.physics) return undefined;
    const snap = this.physics.snapshot();
    const out: Record<string, number | string> = {};
    if (snap.robot) {
      out.x = round(snap.robot.pose.x);
      out.y = round(snap.robot.pose.y);
      out.heading = round(snap.robot.pose.heading);
      out.collisions = snap.stats.collisions;
      out.min_clearance_cm = Number.isFinite(snap.stats.minClearanceCm) ? round(snap.stats.minClearanceCm) : 9999;
      out.travelled_cm = round(snap.stats.travelledCm);
      out.speed = round(snap.robot.speed);
      out.touching = snap.robot.touching.join(",");
      if (snap.robot.sonar) out.sonar_cm = round(snap.robot.sonar.distanceCm);
    }
    if (snap.arm) {
      out.gripper_x = round(snap.arm.pose.end.x);
      out.gripper_y = round(snap.arm.pose.end.y);
      out.reached = snap.arm.pose.reached.join(",");
    }
    return out;
  }

  /**
   * run() that gives the event loop a turn every ~25 ms of wall time when the firmware runs in a
   * local emulator (each step waits on the emulator), so the server keeps answering while it runs.
   * Same frames and results as run().
   */
  async runAsync(ms: number, opts: Parameters<SimHost["run"]>[1] = {}): Promise<void> {
    if (!this.isProcess) return this.run(ms, opts);
    const it = this.runSteps(ms, opts);
    let w0 = Date.now();
    while (!it.next().done) {
      if (Date.now() - w0 >= 25) {
        await new Promise((r) => setImmediate(r));
        w0 = Date.now();
      }
    }
  }

  /** Advance `ms` of virtual time. Calls onFrame every frameMs with what changed. */
  run(ms: number, opts: { frameMs?: number; onFrame?: (f: Frame) => void; until?: () => boolean; stepMs?: number } = {}): void {
    const it = this.runSteps(ms, opts);
    while (!it.next().done);
  }

  /** run() as a generator: yields after every slice, so a caller can pause between slices. */
  private *runSteps(ms: number, opts: { frameMs?: number; onFrame?: (f: Frame) => void; until?: () => boolean; stepMs?: number }): Generator<void> {
    const end = this.sim.timeMs + ms;
    const step = opts.stepMs ?? (opts.until ? 1 : this.noise.size ? 10 : 50);
    const frameMs = opts.frameMs ?? 0;
    let nextFrame = frameMs ? this.sim.timeMs + frameMs : Infinity;
    if (opts.onFrame && this.sim.timeMs === 0) {
      const f = this.frame();
      if (f) opts.onFrame(f);
    }
    while (this.sim.timeMs < end - 1e-9) {
      // round 15: a board in deep sleep runs no firmware, so nothing needs a fine slice: up to a
      // second at a time (the wake itself lands on its exact cycle inside runFor)
      const asleep = this.sim.asleep;
      const dt = Math.min(asleep ? Math.max(step, SLEEP_SLICE_MS) : step, end - this.sim.timeMs, frameMs && !asleep ? Math.max(0.001, nextFrame - this.sim.timeMs) : Infinity);
      this.sim.runFor(dt);
      for (const l of this.timeListeners) l(this.sim.timeMs); // round 10: the device network follows virtual time
      this.watchCollisions();
      this.watchCaptures();
      this.applyNoise();
      if (opts.onFrame && this.sim.timeMs >= nextFrame - 1e-9) {
        const f = this.frame(true);
        if (f) opts.onFrame(f);
        nextFrame += frameMs;
        if (nextFrame < this.sim.timeMs) nextFrame = this.sim.timeMs + frameMs; // after a sleep: no burst of frames
      }
      if (opts.until?.()) break;
      yield;
    }
    if (opts.onFrame) {
      const f = this.frame();
      if (f) opts.onFrame(f);
    }
  }

  /**
   * What changed since the last frame. `periodic` (run()'s frames in between): a colour screen is
   * added at most every COLOR_EVERY_MS; otherwise (the end of a run, a single frame after an
   * interaction) every changed screen is added.
   */
  frame(periodic = false): Frame | undefined {
    const f: Frame = { vt: round(this.sim.timeMs) };
    const states: Record<string, VisualState> = {};
    for (const id of this.sim.partIds()) {
      const s = this.sim.partState(id);
      if (!s) continue;
      const sig = JSON.stringify(s);
      if (this.lastStates.get(id) !== sig) {
        this.lastStates.set(id, sig);
        states[id] = s;
      }
    }
    // Round 6 frames: colour TFT pixels of screens that changed since they were last sent.
    const vt = this.sim.timeMs;
    for (const id of this.sim.partIds()) {
      let fb;
      try {
        fb = this.sim.framebuffer(id);
      } catch {
        fb = undefined;
      }
      if (!fb) continue;
      const sig = colorSig(fb);
      const last = this.lastColor.get(id);
      if (last?.sig === sig || (periodic && last && vt - last.vt < COLOR_EVERY_MS)) continue;
      this.lastColor.set(id, { sig, vt });
      (f.color ??= {})[id] = colorFrameImage(fb);
      // The part's state rides along so a viewer repaints that screen even when nothing else changed.
      const st = this.sim.partState(id);
      if (st && !states[id]) states[id] = st;
    }
    if (Object.keys(states).length) f.states = states;
    const text = this.sim.serialText();
    if (text.length > this.lastFrameSerial) {
      f.serial = text.slice(this.lastFrameSerial);
      this.lastFrameSerial = text.length;
    }
    const live = this.liveWires();
    const sig = live.join(",");
    if (sig !== this.lastLive) {
      this.lastLive = sig;
      f.live = live;
    }
    return f.states || f.serial || f.live || f.color ? f : undefined;
  }

  liveWires(): string[] {
    const out: string[] = [];
    for (const w of this.project.wires) {
      try {
        if (this.sim.pinVoltage(w.from.part, w.from.pin) > HIGH_VOLTS) out.push(w.id);
      } catch {
        // part not simulated
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ faults

  injectFault(partId: string, kind: string, opts: { amplitude?: number; field?: string } = {}): string {
    const part = this.project.parts.find((p) => p.id === partId);
    if (!part) fail("unknown-part", `inject_fault: no part '${partId}'`, `parts are ${this.project.parts.map((p) => p.id).join(", ") || "none"}`, "pass an id from get_project");
    const def = this.registry.get(part.type)!;
    const sim = this.sim as Simulation & { setBusFault?: (id: string, f: string | null) => void };
    const isI2c = !!def.spec.bus?.i2c || def.spec.pins.some((p) => p.protocols?.includes("i2c-sda"));
    const busFault = (f: string | null) => {
      if (!sim.setBusFault) fail("not-supported", `inject_fault ${kind} on '${partId}'`, "this build of the simulator has no I2C/SPI bus faults", "update Faber (sim-core with I2cBus) or use kind 'disconnect'");
      sim.setBusFault(partId, f);
      if (f) this.busFaults.set(partId, f);
      else this.busFaults.delete(partId);
    };
    switch (kind) {
      case "wifi_drop":
        this.wifiDropPart = partId;
        return setWifiDrop(this.network, true, this.sim.timeMs);
      case "clear":
        if (this.wifiDropPart === partId) {
          this.wifiDropPart = undefined;
          setWifiDrop(this.network, false, this.sim.timeMs);
        }
        this.disconnected.delete(partId);
        this.noise.delete(partId);
        if (this.busFaults.has(partId)) busFault(null);
        this.sim.solve();
        return `cleared faults on ${partId}`;
      case "disconnect": {
        if (partId === this.sim.boardId) fail("bad-fault", `inject_fault disconnect on '${partId}'`, "it is the board running the firmware", "disconnect a module or sensor instead");
        this.disconnected.add(partId);
        if (isI2c || def.spec.bus?.spi) busFault("disconnect");
        this.sim.solve();
        return `${partId} is electrically disconnected${isI2c ? " and gone from the I2C bus (its address no longer ACKs)" : ""}`;
      }
      case "i2c_nack":
      case "i2c_nack_data":
      case "i2c_garbage": {
        if (!isI2c) fail("bad-fault", `inject_fault ${kind} on '${partId}' (${part.type})`, "that part is not an I2C device", "use it on an I2C part such as an OLED or sensor module, or use 'disconnect' / 'noisy'");
        const map: Record<string, string> = { i2c_nack: "nack", i2c_nack_data: "nack-data", i2c_garbage: "garbage" };
        busFault(map[kind]!);
        return `${partId} now ${kind === "i2c_nack" ? "NACKs its address (Wire.endTransmission() returns 2)" : kind === "i2c_nack_data" ? "NACKs data bytes (endTransmission() returns 3)" : "returns 0xFF on reads"}`;
      }
      case "noisy": {
        const numeric = (def.spec.props ?? []).filter((p) => p.type === "number");
        const prop = opts.field ? numeric.find((p) => p.id === opts.field) : numeric[0];
        if (!prop) {
          fail(
            "bad-fault",
            `inject_fault noisy on '${partId}' (${part.type})`,
            opts.field ? `it has no numeric field '${opts.field}' (numeric fields: ${numeric.map((p) => p.id).join(", ") || "none"})` : "it has no numeric sensor value to add noise to",
            "use it on a sensor with a numeric value (potentiometer position, photoresistor lux, distance…), or pass field",
          );
        }
        const cur = Number((part.props ?? {})[prop.id] ?? prop.default);
        const range = (prop.max ?? cur * 2) - (prop.min ?? 0);
        this.noise.set(partId, { prop: prop.id, base: cur, amplitude: opts.amplitude ?? Math.max(range * 0.05, Math.abs(cur) * 0.1) });
        return `${partId}.${prop.id} now jitters ±${round(this.noise.get(partId)!.amplitude)} around ${cur} every 10 ms (deterministic seed)`;
      }
      default:
        if ((FAULTS_NOT_YET as readonly string[]).includes(kind)) {
          fail("not-yet", `inject_fault '${kind}'`, "this fault is planned but not simulated yet", `use one of: ${FAULT_KINDS.join(", ")}; test '${kind}' on the real device`);
        }
        fail("bad-fault", `inject_fault '${kind}'`, "unknown fault kind", `use one of: ${FAULT_KINDS.join(", ")}`);
    }
  }

  /** Base value for a noisy prop changes when the user sets the sensor. */
  setNoiseBase(partId: string, prop: string, value: number): boolean {
    const n = this.noise.get(partId);
    if (n && n.prop === prop) {
      n.base = value;
      return true;
    }
    return false;
  }

  faults(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const add = (id: string, f: string) => (out[id] ??= []).push(f);
    for (const id of this.disconnected) add(id, "disconnect");
    for (const id of this.noise.keys()) add(id, "noisy");
    if (this.wifiDropPart) add(this.wifiDropPart, "wifi_drop");
    for (const [id, f] of this.busFaults) if (f !== "disconnect") add(id, `i2c_${f.replace("-", "_")}`);
    return out;
  }

  private applyNoise(): void {
    if (!this.noise.size) return;
    const t = this.sim.timeMs;
    if (t - this.lastNoiseMs < 10) return;
    this.lastNoiseMs = t;
    for (const [id, n] of this.noise) {
      const v: PropValue = round(n.base + (this.rand() * 2 - 1) * n.amplitude);
      this.sim.setProp(id, n.prop, v);
    }
  }

  // ------------------------------------------------------------------ reading

  serialSince(offset: number): string {
    return this.sim.serialText().slice(offset);
  }

  /** Board pins that matter, as compact strings: "out H", "in_pullup H 5.00V". */
  pinSummary(): Record<string, string> {
    const out: Record<string, string> = {};
    const mcu = this.sim.mcu;
    const board = this.sim.boardId;
    if (!mcu || !board) return out;
    const wired = new Set<string>();
    for (const w of this.project.wires) for (const e of [w.from, w.to]) if (e.part === board) wired.add(e.pin);
    for (const pin of mcu.pinIds) {
      const st = mcu.readPin(pin);
      if (!wired.has(pin) && st.mode !== "output") continue;
      let v = 0;
      try {
        v = this.sim.pinVoltage(board, pin);
      } catch {
        v = 0;
      }
      const mode = st.mode === "output" ? "out" : st.mode;
      let pwm: ReturnType<Simulation["pwm"]>;
      try {
        pwm = st.mode === "output" ? this.sim.pwm(board, pin) : undefined;
      } catch {
        pwm = undefined;
      }
      if (pwm && pwm.periodUs > 0 && pwm.periodUs <= 100_000 && pwm.sinceEdgeUs <= 2 * pwm.periodUs + 1000) {
        // Still toggling: the level at this instant says little (a servo pulse is HIGH 5% of the time).
        const hz = pwm.freqHz >= 100 ? Math.round(pwm.freqHz) : Math.round(pwm.freqHz * 10) / 10;
        const servoLike = pwm.periodUs >= 10_000 && pwm.periodUs <= 30_000 && pwm.highUs >= 400 && pwm.highUs <= 2600;
        out[pin] = pwm.periodUs >= 5000 ? `out pulse ${hz}Hz ${Math.round(pwm.highUs)}us (${servoLike ? "servo-style; " : ""}now ${st.value ? "H" : "L"})` : `out PWM ${hz}Hz duty ${Math.round(pwm.duty * 1000) / 10}%`;
        continue;
      }
      out[pin] = `${mode} ${st.value ? "H" : "L"} ${v.toFixed(2)}V`;
    }
    return out;
  }

  /** Part states without render-only noise (transforms, colours, huge strings). */
  compactStates(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const id of this.sim.partIds()) {
      const s = this.sim.partState(id);
      if (!s) continue;
      out[id] = compactState(s);
    }
    return out;
  }

  /** ASCII art of a display part's screen (pixels/width/height in its state). */
  /** The current frame of a display part (1 bit per pixel). Fails with a readable error on non-displays. */
  displayFrame(partId: string): MonoFrame {
    const s = this.sim.partState(partId);
    if (!s) fail("unknown-part", `no simulated display '${partId}'`, "it is not in the project or its type is unknown", "pass a display part id from get_project");
    const width = Number(s.width);
    const height = Number(s.height);
    if (typeof s.pixels !== "string" || !width || !height) {
      const color = this.sim.framebuffer(partId);
      if (color) return colorToMono(color);
      fail("not-a-display", `'${partId}' has no screen`, `its state has no pixels/width/height (keys: ${Object.keys(s).join(", ")})`, "use a display part such as ssd1306-oled-i2c, lcd1602-i2c or ili9341-tft");
    }
    return decodeMonoFrame(s.pixels, width, height);
  }

  display(partId: string, scale = 2): { width: number; height: number; lit: number; ascii: string } {
    const s = this.sim.partState(partId);
    if (!s) fail("unknown-part", `read_display: no simulated part '${partId}'`, "it is not in the project or its type is unknown", "pass a display part id from get_project");
    const pixels = s.pixels;
    const width = Number(s.width);
    const height = Number(s.height);
    const color = typeof pixels !== "string" ? this.sim.framebuffer(partId) : undefined;
    if (!color && (typeof pixels !== "string" || !width || !height)) {
      fail("not-a-display", `read_display: '${partId}' has no screen`, `its state has no pixels/width/height (keys: ${Object.keys(s).join(", ")})`, "use it on a display part such as ssd1306-oled-i2c, lcd1602-i2c or ili9341-tft");
    }
    const f = color ? colorToMono(color) : decodeMonoFrame(pixels as string, width, height);
    let lit = 0;
    for (const b of f.data) for (let v = b; v; v >>= 1) lit += v & 1;
    return { width: f.width, height: f.height, lit, ascii: monoToAscii(f, scale) };
  }

  pin(partId: string, pinId: string): { voltage: number; level: "high" | "low" | "undefined"; mode?: string; floating?: boolean } {
    const v = this.sim.pinVoltage(partId, pinId);
    const vcc = this.sim.mcu?.vcc ?? 5;
    const out: { voltage: number; level: "high" | "low" | "undefined"; mode?: string; floating?: boolean } = {
      voltage: round(v),
      level: v >= 0.6 * vcc ? "high" : v <= 0.3 * vcc ? "low" : "undefined",
    };
    if (partId === this.sim.boardId && this.sim.mcu?.pinIds.includes(pinId)) {
      const st = this.sim.mcu.readPin(pinId);
      out.mode = st.mode;
      if (st.mode === "output") out.level = st.value ? "high" : "low";
    }
    try {
      const node = this.sim.nodeOf(partId, pinId);
      if (this.sim.lastSolve?.isFloating(node)) out.floating = true;
    } catch {
      // ignore
    }
    return out;
  }
}

export function compactState(s: VisualState): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (/Transform$|^lens$|Opacity$/.test(k)) continue;
    if (/^pin_/.test(k)) continue;
    if (typeof v === "string" && v.startsWith("data:image/")) {
      o[k] = `<picture, ${v.length} chars; screenshot shows it>`; // round 13: a camera preview
      continue;
    }
    if (typeof v === "string" && v.length > 64) {
      o[k] = `<${v.length} chars; use read_display>`;
      continue;
    }
    o[k] = typeof v === "number" ? round(v) : v;
  }
  return o;
}

/**
 * A colour panel (TFT) as a 1-bit frame for display checks: a pixel is lit when it is not black,
 * the same rule as the panel's `lit` state; a dark panel (off / asleep) is all unlit.
 */
export function colorToMono(f: ColorFrame): MonoFrame {
  const stride = (f.width + 7) >> 3;
  const data = new Uint8Array(stride * f.height);
  if (!f.on) return { width: f.width, height: f.height, data };
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      let c = f.data[y * f.width + x]!;
      if (f.inverted) c = ~c & 0xffff;
      if (c !== 0) data[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { width: f.width, height: f.height, data };
}
