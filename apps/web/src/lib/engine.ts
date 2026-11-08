import { Simulation, applyVisualState, type VisualState } from "@jumper/sim-core";
import { backendFactory } from "@jumper/sim-backends";
import type { Project, PropValue } from "@jumper/project-format";
import { registry } from "./parts.ts";
import type { JumperStore } from "./store.ts";

/**
 * Runs the Simulation on the main thread (M0; a worker comes later) and pushes its state
 * straight into the DOM: part SVG bindings, wire "live" flags and the serial console.
 * React never re-renders per frame.
 */

const MAX_FRAME_MS = 100; // wall ms per frame we account for (tab switches, hiccups)
const WALL_BUDGET_MS = 12; // stop simulating this frame after this much wall time
const SLICE_MS = 2; // virtual ms per runFor slice inside a frame
const SERIAL_CAP = 64 * 1024;
const HIGH_VOLTS = 1.5;

interface PartView {
  el: HTMLElement;
  last: string;
}

/** Only the parts of a project that change what the simulation is (not positions). */
function topologyKey(p: Project): string {
  return JSON.stringify([
    p.parts.map((x) => [x.id, x.type]),
    p.wires.map((w) => [w.from.part, w.from.pin, w.to.part, w.to.pin]),
    p.firmware?.board ?? null,
  ]);
}

export class Engine {
  private sim: Simulation | undefined;
  private simKey = "";
  private simProps = new Map<string, Record<string, PropValue>>();
  private parts = new Map<string, PartView>();
  private wires = new Map<string, { el: SVGElement; live: boolean }>();
  private consoleEl: HTMLElement | null = null;
  private serial = "";
  private serialPending: number[] = [];
  private raf = 0;
  private lastFrame = 0;
  private statsAt = 0;
  private factor = 0;
  private window: { wall: number; virt: number } = { wall: 0, virt: 0 };
  private unsubSim: (() => void) | undefined;

  constructor(private readonly store: JumperStore) {
    store.subscribe((s, prev) => {
      if (s.project !== prev.project) this.onProjectChange(s.project);
    });
  }

  // ------------------------------------------------------------- DOM registration

  registerPart(id: string, el: HTMLElement | null): void {
    if (el) {
      this.parts.set(id, { el, last: "" });
      this.paintPart(id);
    } else this.parts.delete(id);
  }

  registerWire(id: string, el: SVGElement | null): void {
    if (el) {
      this.wires.set(id, { el, live: false });
      this.paintWires();
    } else this.wires.delete(id);
  }

  registerConsole(el: HTMLElement | null): void {
    this.consoleEl = el;
    if (el) {
      el.textContent = this.serial;
      el.scrollTop = el.scrollHeight;
    }
  }

  get serialText(): string {
    return this.serial;
  }

  /** For tests / debugging: the live Simulation, if one exists. */
  get simulation(): Simulation | undefined {
    return this.sim;
  }

  // ------------------------------------------------------------- controls

  run(): void {
    const s = this.store.getState();
    if (s.run === "running") return;
    if (!this.sim && !this.build()) return;
    this.sim!.resume();
    s.setRun("running");
    this.lastFrame = performance.now();
    this.statsAt = this.lastFrame;
    this.factor = 0;
    this.window = { wall: 0, virt: 0 };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  }

  pause(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const s = this.store.getState();
    if (s.run === "running") s.setRun("paused");
    s.setStats(this.sim?.timeMs ?? 0, 0);
  }

  reset(): void {
    this.clearSerial();
    if (this.sim) {
      this.sim.reset();
      this.paintAll(true);
    }
    this.store.getState().setStats(0, 0);
  }

  /** Throw the simulation away (firmware changed, project replaced…). */
  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.disposeSim();
    this.clearSerial();
    this.paintIdle();
    const s = this.store.getState();
    s.setRun("idle");
    s.setStats(0, 0);
  }

  interact(partId: string, kind: "press" | "release"): void {
    if (!this.sim) {
      if (!this.build()) return;
      this.store.getState().setRun("paused");
    }
    try {
      this.sim!.interact(partId, { kind });
      this.paintAll(false);
    } catch (err) {
      this.fail(err);
    }
  }

  // ------------------------------------------------------------- internals

  private build(): boolean {
    const s = this.store.getState();
    const project = s.project;
    let firmware: string | undefined;
    if (project.firmware) {
      if (s.firmware.status !== "ready") {
        const msg =
          s.firmware.status === "loading"
            ? "Firmware is still loading."
            : `Firmware not built: ${project.firmware.artifact} is missing. Build it with toolchains/arduino (or load a .hex).`;
        s.setSimError(msg);
        s.toast({ kind: "error", title: "Can't run yet", detail: msg });
        return false;
      }
      firmware = s.firmware.hex;
    }
    try {
      this.disposeSim();
      const sim = new Simulation({ project, registry, backendFactory, ...(firmware ? { firmware } : {}) });
      this.sim = sim;
      this.simKey = topologyKey(project);
      this.simProps = new Map(project.parts.map((p) => [p.id, { ...p.props }]));
      this.unsubSim = sim.subscribe((e) => {
        if (e.type === "serial") this.serialPending.push(e.byte);
      });
      const missing = sim.diagnostics().filter((d) => d.code === "unknown-part-type");
      s.setSimError(
        missing.length ? `Not simulated (unknown part types): ${missing.map((d) => d.partId).join(", ")}` : undefined,
      );
      this.paintAll(true);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private fail(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.disposeSim();
    const s = this.store.getState();
    s.setRun("idle");
    s.setSimError(`Simulator error: ${msg}`);
    s.toast({ kind: "error", title: "Simulation stopped", detail: msg });
  }

  private disposeSim(): void {
    this.unsubSim?.();
    this.unsubSim = undefined;
    this.sim?.dispose();
    this.sim = undefined;
    this.serialPending = [];
  }

  private onProjectChange(project: Project): void {
    if (!this.sim) return;
    if (topologyKey(project) !== this.simKey) {
      // Wiring changed: rebuild, keep the run state.
      const wasRunning = this.store.getState().run === "running";
      this.clearSerial();
      if (!this.build()) return;
      if (!wasRunning) this.store.getState().setRun("paused");
      this.store.getState().setStats(0, 0);
      return;
    }
    // Same circuit: push prop changes live.
    for (const part of project.parts) {
      const prev = this.simProps.get(part.id) ?? {};
      const next = part.props ?? {};
      for (const [k, v] of Object.entries(next)) {
        if (prev[k] !== v) {
          try {
            this.sim.setProp(part.id, k, v);
          } catch (err) {
            this.fail(err);
            return;
          }
        }
      }
      this.simProps.set(part.id, { ...next });
    }
    this.paintAll(false);
  }

  private frame = (now: number): void => {
    const sim = this.sim;
    const s = this.store.getState();
    if (!sim || s.run !== "running") return;
    const wallDt = Math.min(MAX_FRAME_MS, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    let todo = wallDt * s.speed;
    const t0 = performance.now();
    const v0 = sim.timeMs;
    try {
      while (todo > 1e-9) {
        const step = Math.min(SLICE_MS, todo);
        sim.runFor(step);
        todo -= step;
        if (performance.now() - t0 > WALL_BUDGET_MS) break; // can't keep up: drop the rest, no spiral
      }
    } catch (err) {
      this.fail(err);
      return;
    }
    this.flushSerial();
    this.paintAll(false);

    this.window.wall += wallDt;
    this.window.virt += sim.timeMs - v0;
    // The clock readout follows every frame; the real-time factor is averaged over ~250 ms windows.
    if (now - this.statsAt > 250) {
      this.factor = this.window.wall > 0 ? this.window.virt / this.window.wall : this.factor;
      this.statsAt = now;
      this.window = { wall: 0, virt: 0 };
    }
    s.setStats(sim.timeMs, this.factor);
    this.raf = requestAnimationFrame(this.frame);
  };

  private flushSerial(): void {
    if (this.serialPending.length === 0) return;
    let text = "";
    for (const b of this.serialPending) text += String.fromCharCode(b);
    this.serialPending = [];
    this.serial += text;
    let trimmed = false;
    if (this.serial.length > SERIAL_CAP) {
      this.serial = this.serial.slice(-SERIAL_CAP / 2);
      trimmed = true;
    }
    const el = this.consoleEl;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (trimmed) el.textContent = this.serial;
    else el.append(text);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  clearSerial(): void {
    this.serial = "";
    this.serialPending = [];
    if (this.consoleEl) this.consoleEl.textContent = "";
  }

  private paintAll(force: boolean): void {
    for (const id of this.parts.keys()) this.paintPart(id, force);
    this.paintWires();
  }

  private paintPart(id: string, force = false): void {
    const view = this.parts.get(id);
    const sim = this.sim;
    if (!view || !sim) return;
    let state: VisualState | undefined;
    try {
      state = sim.partState(id);
    } catch {
      state = undefined;
    }
    if (!state) return;
    const sig = JSON.stringify(state);
    if (!force && sig === view.last) return; // only touch parts whose state changed
    view.last = sig;
    const svg = view.el.querySelector(".part-svg");
    if (svg) applyVisualState(svg, state);
    paintStateAttrs(view.el, state);
  }

  private paintIdle(): void {
    for (const v of this.parts.values()) {
      v.last = "";
      v.el.dataset.lit = "false";
      v.el.style.removeProperty("--glow");
    }
    for (const w of this.wires.values()) {
      w.live = false;
      w.el.dataset.live = "false";
    }
  }

  private paintWires(): void {
    const sim = this.sim;
    if (!sim) return;
    const wires = this.store.getState().project.wires;
    const byId = new Map(wires.map((w) => [w.id, w]));
    for (const [id, view] of this.wires) {
      const w = byId.get(id);
      let live = false;
      if (w) {
        try {
          live = sim.pinVoltage(w.from.part, w.from.pin) > HIGH_VOLTS;
        } catch {
          live = false;
        }
      }
      if (live !== view.live) {
        view.live = live;
        view.el.dataset.live = String(live);
      }
    }
  }
}

/** Mirror visual state on the node element so CSS (glow) and tests (data-lit) can read it. */
function paintStateAttrs(el: HTMLElement, state: VisualState): void {
  let lit = false;
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === "string" && v.length > 40) continue;
    const attr = `state${k.replace(/(^|[_-])([a-z0-9])/gi, (_m, _s, c: string) => c.toUpperCase())}`;
    const val = String(v);
    if (el.dataset[attr] !== val) el.dataset[attr] = val;
    if (k === "brightness" && typeof v === "number" && v > 0.05) lit = true;
    if ((k === "lit" || k === "on") && v) lit = true;
  }
  const b = state.brightness;
  if (typeof b === "number") {
    el.style.setProperty("--glow-alpha", String(Math.min(1, Math.max(0, b))));
    if (typeof state.color === "string") el.style.setProperty("--glow", cssLedColor(state.color));
  }
  const litStr = String(lit);
  if (el.dataset.lit !== litStr) el.dataset.lit = litStr;
}

const LED_COLORS: Record<string, string> = {
  red: "#FF3B30",
  green: "#5CF2A1",
  blue: "#4DA3FF",
  yellow: "#FFD43B",
  white: "#FFFFFF",
  orange: "#FF8A1F",
};

function cssLedColor(c: string): string {
  return LED_COLORS[c.toLowerCase()] ?? c;
}
