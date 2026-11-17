// Round 10 (decision 0006): the person's Run for a board that runs in a local emulator process
// (ESP32 family on Espressif's QEMU, Renode boards). Those never run in the browser: the Faber
// server owns the emulator, runs the Simulation paced to the wall clock (× speed), and streams
// frames to every page that follows it over ws /live; button presses and sensor values come back
// the same way. In-process boards (AVR, RP2040) keep running in the page and never come here.
import { isProcessBackend, type VisualValue } from "@faber/sim-core";
import { asFaberError } from "./errors.ts";
import { firmwareBoardOf, SimHost, type Frame } from "./sim.ts";
import { setPartValue } from "./scenario.ts";
import type { ProjectSession } from "./session.ts";

/** Server → page. */
export type RemoteRunEvent =
  | { type: "sim-status"; state: "preparing" | "running" | "paused" | "stopped" | "error"; text?: string; stage?: string; error?: string; board?: string; backend?: string; boot_ms?: number; built?: string }
  | { type: "sim-frame"; frame: Frame; t_ms: number; wall_ms: number; factor: number; speed: number };

/** Page → server ({type: "sim", ...}). */
export interface RemoteRunCommand {
  type: "sim";
  action: "start" | "stop" | "pause" | "resume" | "reset" | "speed" | "input" | "set";
  speed?: number;
  part?: string;
  kind?: "press" | "release" | "set";
  key?: string;
  value?: VisualValue;
  field?: string;
}

const TICK_MS = 33;
/** Wall ms one tick may spend simulating before it gives the server back. */
const BUDGET_MS = 25;
/** Virtual ms the run may fall behind before it stops trying to catch up (a slow emulator). */
const MAX_LAG_MS = 250;

export class RemoteRun {
  private host: SimHost | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private speed = 1;
  private paused = false;
  private wallStart = 0;
  private virtStart = 0;
  private wallUsed = 0;
  /** Real-time factor over the last ~second. */
  private window = { wall: 0, virt: 0, at: 0, factor: 0 };
  private starting: Promise<void> | undefined;
  private generation = 0;

  constructor(
    private session: () => ProjectSession,
    private send: (ev: RemoteRunEvent) => void,
  ) {}

  get active(): boolean {
    return !!this.host || !!this.starting;
  }

  /** True when the open project's firmware board runs in a local emulator. */
  static wants(session: ProjectSession): boolean {
    const b = firmwareBoardOf(session.project, session.registry);
    return !!b && isProcessBackend(b.mcu.backend);
  }

  async handle(cmd: RemoteRunCommand): Promise<void> {
    switch (cmd.action) {
      case "start":
        if (typeof cmd.speed === "number" && cmd.speed > 0) this.speed = cmd.speed;
        return this.start();
      case "stop":
        return this.stop();
      case "pause":
        this.paused = true;
        this.send({ type: "sim-status", state: "paused" });
        return;
      case "resume":
        if (!this.host) return this.start();
        this.paused = false;
        this.resync();
        this.send({ type: "sim-status", state: "running" });
        return;
      case "reset":
        if (!this.host) return;
        try {
          this.host.reset();
        } catch (err) {
          return this.fail(err);
        }
        this.resync();
        this.emitFrame(true);
        return;
      case "speed":
        if (typeof cmd.speed === "number" && cmd.speed > 0) {
          this.speed = Math.min(64, cmd.speed);
          this.resync();
        }
        return;
      case "input":
        if (!this.host || !cmd.part) return;
        try {
          this.host.sim.interact(cmd.part, { kind: cmd.kind ?? "press", ...(cmd.key ? { key: cmd.key } : {}), ...(cmd.value !== undefined ? { value: cmd.value } : {}) });
        } catch (err) {
          this.send({ type: "sim-status", state: "running", error: asFaberError(err, `Could not press ${cmd.part}`).message });
        }
        this.emitFrame(false);
        return;
      case "set":
        if (!this.host || !cmd.part || !cmd.field || cmd.value === undefined) return;
        try {
          setPartValue(this.host, this.session().project, this.session().registry, cmd.part, cmd.field, cmd.value);
        } catch (err) {
          this.send({ type: "sim-status", state: "running", error: asFaberError(err, `Could not set ${cmd.part}.${cmd.field}`).message });
        }
        this.emitFrame(false);
        return;
    }
  }

  /** Builds when the sketch changed, boots the emulator (progress events), then runs. */
  start(): Promise<void> {
    if (this.host) {
      this.paused = false;
      this.resync();
      this.send({ type: "sim-status", state: "running" });
      return Promise.resolve();
    }
    if (this.starting) return this.starting;
    const gen = ++this.generation;
    this.starting = (async () => {
      const s = this.session();
      const board = firmwareBoardOf(s.project, s.registry);
      const base = { board: board?.name ?? "", backend: board?.mcu.backend ?? "" };
      try {
        let built: string | undefined;
        const st = s.firmwareState();
        if (st === "stale" || st === "missing") {
          this.send({ type: "sim-status", state: "preparing", stage: "build", text: st === "missing" ? "building the firmware (first build of this board can take a minute)" : "rebuilding the firmware (the sketch changed)", ...base });
          const r = (await s.call("build", {}, { actor: "web" })) as { ok: boolean; errors?: string[]; log?: string };
          if (!r.ok) {
            const why = (r.errors ?? [r.log ?? "unknown error"]).slice(0, 3).join(" | ");
            throw new Error(`Can't run: the firmware does not compile: ${why}. Fix: correct the code (the errors name file:line), then press Run again.`);
          }
          built = st === "missing" ? "built the firmware first" : "rebuilt the firmware first (sources changed)";
        }
        const fw = (s as unknown as { loadHex(): string | Uint8Array | undefined }).loadHex();
        if (fw === undefined) throw new Error("Can't run: the project has no built firmware. Fix: write the sketch (firmware/main.ino), then press Run.");
        const t0 = Date.now();
        const host = await SimHost.create(s.project, s.registry, fw, (p) => this.send({ type: "sim-status", state: "preparing", stage: p.stage, text: p.text, ...base }));
        if (gen !== this.generation) {
          host.dispose();
          return;
        }
        this.host = host;
        this.paused = false;
        this.resync();
        this.window = { wall: 0, virt: 0, at: Date.now(), factor: 0 };
        this.send({ type: "sim-status", state: "running", boot_ms: Date.now() - t0, ...(built ? { built } : {}), ...base });
        this.emitFrame(true);
        this.schedule();
      } catch (err) {
        if (gen === this.generation) this.fail(err);
      } finally {
        if (gen === this.generation) this.starting = undefined;
      }
    })();
    return this.starting;
  }

  stop(): void {
    this.generation++;
    this.starting = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const had = !!this.host;
    this.host?.dispose();
    this.host = undefined;
    if (had) this.send({ type: "sim-status", state: "stopped" });
  }

  dispose(): void {
    this.stop();
  }

  private resync(): void {
    this.wallStart = Date.now();
    this.virtStart = this.host?.timeMs ?? 0;
    this.wallUsed = 0;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    const host = this.host;
    if (!host) return;
    if (!this.paused) {
      const w0 = Date.now();
      let target = this.virtStart + (w0 - this.wallStart) * this.speed;
      if (target - host.timeMs > MAX_LAG_MS) {
        // The emulator cannot keep up at this speed: drop the backlog (no spiral), report the factor.
        this.virtStart = host.timeMs;
        this.wallStart = w0;
        target = host.timeMs + TICK_MS * this.speed;
      }
      const v0 = host.timeMs;
      try {
        while (host.timeMs < target - 1e-6 && Date.now() - w0 < BUDGET_MS) host.run(Math.min(5, target - host.timeMs));
      } catch (err) {
        return this.fail(err);
      }
      const now = Date.now();
      this.window.wall += now - this.window.at;
      this.window.at = now;
      this.window.virt += host.timeMs - v0;
      this.wallUsed += now - w0;
      if (this.window.wall >= 500) {
        this.window.factor = this.window.virt / this.window.wall;
        this.window.wall = 0;
        this.window.virt = 0;
      }
      this.emitFrame(false);
    }
    this.schedule();
  }

  private emitFrame(full: boolean): void {
    const host = this.host;
    if (!host) return;
    const f = host.frame(!full);
    const frame = f ?? { vt: Math.round(host.timeMs * 1000) / 1000 };
    this.send({ type: "sim-frame", frame, t_ms: frame.vt, wall_ms: Date.now() - this.wallStart, factor: Math.round(this.window.factor * 100) / 100, speed: this.speed });
  }

  private fail(err: unknown): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.host?.dispose();
    this.host = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    this.send({ type: "sim-status", state: "error", error: msg });
  }
}
