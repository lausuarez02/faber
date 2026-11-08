import { create } from "zustand";
import type { PartInstance, Project, PropValue, Rotation, Wire, PinRef } from "@jumper/project-format";
import { nextPartId } from "./parts.ts";

export const WIRE_COLORS = ["#FF4D2E", "#FFB23F", "#F2E14A", "#4DA3FF", "#E9EDF2", "#2B3038", "#B47CFF"] as const;
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;
/**
 * The fastest speed the main-thread simulation holds on a typical laptop. Faster settings are
 * labelled "best effort" in the menu: the sim runs as fast as its per-frame budget allows
 * (about 5× for Blink) and the clock shows the real factor.
 */
export const RELIABLE_SPEED = 4;
const HISTORY_LIMIT = 200;

export type RunState = "idle" | "running" | "paused";
export type ThemeChoice = "system" | "dark" | "light";
export type FirmwareState =
  | { status: "loading" }
  | { status: "missing"; reason: string }
  | { status: "ready"; hex: string; name: string; source: "example" | "upload" }
  | { status: "none" };

export interface Toast {
  id: number;
  kind: "info" | "error";
  title: string;
  detail?: string;
}

export interface JumperState {
  project: Project;
  past: Project[];
  future: Project[];
  selectedParts: string[];
  selectedWires: string[];

  run: RunState;
  speed: number;
  timeMs: number;
  /** Measured virtual ms per wall ms. */
  factor: number;
  simError: string | undefined;
  firmware: FirmwareState;
  theme: ThemeChoice;
  toasts: Toast[];

  /** Replace the project and record the old one for undo. */
  commit(update: (p: Project) => Project): void;
  /** Replace the project without touching history (live drag). Call checkpoint() first. */
  setLive(update: (p: Project) => Project): void;
  /** Push the current project onto the undo stack (start of a drag). */
  checkpoint(): void;
  undo(): void;
  redo(): void;
  loadProject(p: Project): void;

  addPart(type: string, x: number, y: number, props?: Record<string, PropValue>): string;
  removeSelection(): void;
  removeItems(partIds: readonly string[], wireIds: readonly string[]): void;
  connect(a: PinRef, b: PinRef): string | undefined;
  setPartProp(partId: string, propId: string, value: PropValue): void;
  rotateSelected(): void;
  setWireColor(wireId: string, color: string): void;
  cycleWireColor(wireId: string): void;
  select(parts: string[], wires: string[]): void;
  rename(name: string): void;

  setRun(run: RunState): void;
  setSpeed(speed: number): void;
  setStats(timeMs: number, factor: number): void;
  setSimError(err: string | undefined): void;
  setFirmware(f: FirmwareState): void;
  setTheme(t: ThemeChoice): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;

function nextWireId(wires: readonly Wire[]): string {
  const used = new Set(wires.map((w) => w.id));
  for (let i = 1; ; i++) if (!used.has(`w${i}`)) return `w${i}`;
}

function samePin(a: PinRef, b: PinRef): boolean {
  return a.part === b.part && a.pin === b.pin;
}

/** Remove parts (and every wire touching them) and wires. Drops `firmware` if its board goes. */
export function withoutItems(p: Project, partIds: readonly string[], wireIds: readonly string[]): Project {
  const parts = new Set(partIds);
  const wires = new Set(wireIds);
  const next: Project = {
    ...p,
    parts: p.parts.filter((x) => !parts.has(x.id)),
    wires: p.wires.filter((w) => !wires.has(w.id) && !parts.has(w.from.part) && !parts.has(w.to.part)),
  };
  if (p.firmware && parts.has(p.firmware.board)) delete next.firmware;
  return next;
}

export function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem("jumper.theme");
    if (t === "dark" || t === "light" || t === "system") return t;
  } catch {
    // storage blocked
  }
  return "system";
}

export function createJumperStore(initial: Project) {
  return create<JumperState>()((set, get) => ({
    project: initial,
    past: [],
    future: [],
    selectedParts: [],
    selectedWires: [],
    run: "idle",
    speed: 1,
    timeMs: 0,
    factor: 0,
    simError: undefined,
    firmware: { status: "loading" },
    theme: "system",
    toasts: [],

    commit(update) {
      const { project, past } = get();
      const next = update(project);
      if (next === project) return;
      set({ project: next, past: [...past, project].slice(-HISTORY_LIMIT), future: [] });
    },
    setLive(update) {
      const next = update(get().project);
      if (next !== get().project) set({ project: next });
    },
    checkpoint() {
      const { project, past } = get();
      if (past[past.length - 1] === project) return;
      set({ past: [...past, project].slice(-HISTORY_LIMIT), future: [] });
    },
    undo() {
      const { past, project, future } = get();
      let i = past.length - 1;
      // skip checkpoints that equal the current project (a click without a move)
      while (i >= 0 && past[i] === project) i--;
      const prev = past[i];
      if (!prev) return;
      set({ project: prev, past: past.slice(0, i), future: [project, ...future], ...pruneSelection(prev, get()) });
    },
    redo() {
      const { past, project, future } = get();
      const next = future[0];
      if (!next) return;
      set({ project: next, past: [...past, project], future: future.slice(1), ...pruneSelection(next, get()) });
    },
    loadProject(p) {
      set({ project: p, past: [], future: [], selectedParts: [], selectedWires: [] });
    },

    addPart(type, x, y, props) {
      const id = nextPartId(type, get().project.parts.map((p) => p.id));
      const part: PartInstance = { id, type, x, y, rotation: 0, ...(props ? { props } : {}) };
      get().commit((p) => ({ ...p, parts: [...p.parts, part] }));
      set({ selectedParts: [id], selectedWires: [] });
      return id;
    },
    removeSelection() {
      const { selectedParts, selectedWires } = get();
      get().removeItems(selectedParts, selectedWires);
    },
    removeItems(partIds, wireIds) {
      if (partIds.length === 0 && wireIds.length === 0) return;
      get().commit((p) => withoutItems(p, partIds, wireIds));
      set((s) => ({
        selectedParts: s.selectedParts.filter((id) => !partIds.includes(id)),
        selectedWires: s.selectedWires.filter((id) => !wireIds.includes(id)),
      }));
    },
    connect(a, b) {
      if (samePin(a, b)) return undefined;
      const { project } = get();
      const dup = project.wires.find(
        (w) => (samePin(w.from, a) && samePin(w.to, b)) || (samePin(w.from, b) && samePin(w.to, a)),
      );
      if (dup) return undefined;
      const id = nextWireId(project.wires);
      const color = WIRE_COLORS[project.wires.length % WIRE_COLORS.length]!;
      get().commit((p) => ({ ...p, wires: [...p.wires, { id, from: a, to: b, color }] }));
      return id;
    },
    setPartProp(partId, propId, value) {
      get().commit((p) => ({
        ...p,
        parts: p.parts.map((x) => (x.id === partId ? { ...x, props: { ...x.props, [propId]: value } } : x)),
      }));
    },
    rotateSelected() {
      const ids = new Set(get().selectedParts);
      if (ids.size === 0) return;
      get().commit((p) => ({
        ...p,
        parts: p.parts.map((x) => (ids.has(x.id) ? { ...x, rotation: ((x.rotation + 90) % 360) as Rotation } : x)),
      }));
    },
    setWireColor(wireId, color) {
      get().commit((p) => ({ ...p, wires: p.wires.map((w) => (w.id === wireId ? { ...w, color } : w)) }));
    },
    cycleWireColor(wireId) {
      const w = get().project.wires.find((x) => x.id === wireId);
      if (!w) return;
      const i = WIRE_COLORS.findIndex((c) => c.toLowerCase() === (w.color ?? "").toLowerCase());
      get().setWireColor(wireId, WIRE_COLORS[(i + 1) % WIRE_COLORS.length]!);
    },
    select(parts, wires) {
      const s = get();
      if (sameList(s.selectedParts, parts) && sameList(s.selectedWires, wires)) return;
      set({ selectedParts: parts, selectedWires: wires });
    },
    rename(name) {
      const n = name.trim();
      if (!n || n === get().project.name) return;
      get().commit((p) => ({ ...p, name: n }));
    },

    setRun(run) {
      set({ run });
    },
    setSpeed(speed) {
      set({ speed });
    },
    setStats(timeMs, factor) {
      set({ timeMs, factor });
    },
    setSimError(simError) {
      set({ simError });
    },
    setFirmware(firmware) {
      set({ firmware });
    },
    setTheme(theme) {
      try {
        localStorage.setItem("jumper.theme", theme);
      } catch {
        // storage blocked
      }
      set({ theme });
    },
    toast(t) {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
      setTimeout(() => get().dismissToast(id), t.kind === "error" ? 9000 : 3500);
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  }));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function pruneSelection(p: Project, s: JumperState): Pick<JumperState, "selectedParts" | "selectedWires"> {
  const parts = new Set(p.parts.map((x) => x.id));
  const wires = new Set(p.wires.map((x) => x.id));
  return {
    selectedParts: s.selectedParts.filter((id) => parts.has(id)),
    selectedWires: s.selectedWires.filter((id) => wires.has(id)),
  };
}

export type JumperStore = ReturnType<typeof createJumperStore>;
