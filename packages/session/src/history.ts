import type { Project } from "@jumper/project-format";

/**
 * Undo / steps, at the level of entities: "part:<id>", "wire:<id>", "firmware", "scenario:<id>",
 * "meta" (name + description) and "file:<path>". A step remembers each touched entity's value
 * before its first change and after its last change. Undoing or rejecting a step puts back the
 * "before" values of entities that still have the step's "after" value; an entity changed again by
 * a later step is a conflict and is left alone (the result says so).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type EntityMap = Record<string, Json | null>;

export type StepStatus = "pending" | "accepted" | "rejected" | "undone";

export interface Step {
  id: number;
  why: string;
  status: StepStatus;
  /** Action-log sequence numbers of the ops in this step. */
  ops: number[];
  /** Op names, for display ("place_part led1"). */
  labels: string[];
  before: EntityMap;
  after: EntityMap;
  /** Wall time the step started (ISO). */
  t: string;
  /**
   * Who made it: "mcp", "cli", "web"… The person's own steps (actor "web": the code editor, a
   * History restore, Update case) are accepted when made and never wait for Accept / Reject.
   */
  actor?: string;
}

/** The person at the web page made this change themselves (never an agent proposal). */
export const isPersonActor = (actor: string | undefined): boolean => actor === "web";

export interface HistoryState {
  steps: Step[];
  nextId: number;
  /** Ids of undone steps, most recent last (redo pops from the end). */
  redo: number[];
  /** A step new ops without a `why` join; closed by undo/redo/accept/reject or a new `why`. */
  open: number | undefined;
}

export function emptyHistory(): HistoryState {
  return { steps: [], nextId: 1, redo: [], open: undefined };
}

export function projectEntities(p: Project): EntityMap {
  const out: EntityMap = {};
  out.meta = { name: p.name, ...(p.description !== undefined ? { description: p.description } : {}) };
  for (const part of p.parts) out[`part:${part.id}`] = part as unknown as Json;
  for (const w of p.wires) out[`wire:${w.id}`] = w as unknown as Json;
  out.firmware = (p.firmware ?? null) as unknown as Json;
  for (const s of p.scenarios) out[`scenario:${s.id}`] = s as unknown as Json;
  out.world = (p.world ?? null) as unknown as Json;
  // round 6 (decision 0004, R2 / R3): how it is built, powered and housed
  for (const k of ["assembly", "power", "enclosure"] as const) if (p[k] !== undefined) out[k] = p[k] as unknown as Json;
  return out;
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Changed keys between two entity maps, with their before / after values. */
export function diffEntities(a: EntityMap, b: EntityMap): { before: EntityMap; after: EntityMap } {
  const before: EntityMap = {};
  const after: EntityMap = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!same(a[k], b[k])) {
      before[k] = a[k] ?? null;
      after[k] = b[k] ?? null;
    }
  }
  return { before, after };
}

/** Apply entity values (null = remove) to a project. Keeps order; new parts/wires/scenarios go last. */
export function applyToProject(p: Project, changes: EntityMap): Project {
  let next: Project = { ...p, parts: [...p.parts], wires: [...p.wires], scenarios: [...p.scenarios] };
  for (const [k, v] of Object.entries(changes)) {
    const [kind, ...rest] = k.split(":");
    const id = rest.join(":");
    if (kind === "meta" && v && typeof v === "object") {
      const m = v as { name: string; description?: string };
      next = { ...next, name: m.name };
      if (m.description !== undefined) next.description = m.description;
      else delete next.description;
    } else if (kind === "firmware") {
      if (v === null) delete next.firmware;
      else next.firmware = v as unknown as Project["firmware"];
    } else if (kind === "world") {
      if (v === null) delete next.world;
      else next.world = v as unknown as Project["world"];
    } else if (kind === "assembly" || kind === "power" || kind === "enclosure") {
      // round 6 (decision 0004, R2 / R3)
      if (v === null) delete next[kind];
      else (next as Record<string, unknown>)[kind] = v;
    } else if (kind === "part" || kind === "wire" || kind === "scenario") {
      const field = kind === "part" ? "parts" : kind === "wire" ? "wires" : "scenarios";
      const arr = next[field] as { id: string }[];
      const i = arr.findIndex((x) => x.id === id);
      if (v === null) {
        if (i >= 0) arr.splice(i, 1);
      } else if (i >= 0) arr[i] = v as unknown as { id: string };
      else arr.push(v as unknown as { id: string });
    }
  }
  return next;
}

export function fileChanges(changes: EntityMap): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(changes)) if (k.startsWith("file:")) out[k.slice(5)] = v as string | null;
  return out;
}

/**
 * Record one op's entity changes. A new step starts when `why` is given and differs from the open
 * step's, or when no step is open.
 */
export function record(h: HistoryState, why: string | undefined, seq: number, label: string, before: EntityMap, after: EntityMap, now: string, actor?: string): Step {
  // Any new change makes redo impossible.
  for (const id of h.redo) {
    const s = h.steps.find((x) => x.id === id);
    if (s && s.status === "undone") s.status = "rejected";
  }
  h.redo = [];
  if (isPersonActor(actor)) {
    // The person's own edit: its own step, accepted now (undo still works), and an agent's open
    // step stays open for the agent's next op.
    // (several ops sent back to back with one explicit why, e.g. the Case view's Apply = remove +
    // place_part + connect, are one step, so one undo takes the whole change back)
    const last = h.steps[h.steps.length - 1];
    if (why?.trim() && last && last.actor === actor && last.status === "accepted" && last.why === why.trim() && last.ops[last.ops.length - 1] === seq - 1) {
      last.ops.push(seq);
      last.labels.push(label);
      for (const [k, v] of Object.entries(before)) if (!(k in last.before)) last.before[k] = v;
      for (const [k, v] of Object.entries(after)) last.after[k] = v;
      for (const k of Object.keys(last.after)) if (same(last.before[k], last.after[k])) {
        delete last.before[k];
        delete last.after[k];
      }
      return last;
    }
    const own: Step = { id: h.nextId++, why: why?.trim() || label, status: "accepted", ops: [seq], labels: [label], before: { ...before }, after: { ...after }, t: now, actor };
    for (const k of Object.keys(own.after)) if (same(own.before[k], own.after[k])) {
      delete own.before[k];
      delete own.after[k];
    }
    h.steps.push(own);
    return own;
  }
  let step = h.open !== undefined ? h.steps.find((s) => s.id === h.open && s.status === "pending") : undefined;
  if (!step || (why !== undefined && why.trim() !== "" && why !== step.why)) {
    step = { id: h.nextId++, why: why?.trim() || label, status: "pending", ops: [], labels: [], before: {}, after: {}, t: now, ...(actor ? { actor } : {}) };
    h.steps.push(step);
    h.open = step.id;
  }
  step.ops.push(seq);
  step.labels.push(label);
  for (const [k, v] of Object.entries(before)) if (!(k in step.before)) step.before[k] = v;
  for (const [k, v] of Object.entries(after)) step.after[k] = v;
  // Drop keys that ended where they started (e.g. place then remove in one step).
  for (const k of Object.keys(step.after)) if (same(step.before[k], step.after[k])) {
    delete step.before[k];
    delete step.after[k];
  }
  return step;
}

export interface RevertPlan {
  changes: EntityMap;
  conflicts: string[];
}

/** What to set to move `from` → `to` for each key of a step, skipping keys that moved on since. */
export function planRevert(current: EntityMap, from: EntityMap, to: EntityMap): RevertPlan {
  const changes: EntityMap = {};
  const conflicts: string[] = [];
  for (const k of Object.keys(from)) {
    if (same(current[k], from[k])) changes[k] = to[k] ?? null;
    else if (!same(current[k], to[k])) conflicts.push(k);
  }
  return { changes, conflicts };
}

/** Compact view of steps for tool results and the live panel. */
export function stepSummary(s: Step): { id: number; why: string; status: StepStatus; ops: string[]; actor?: string } {
  return { id: s.id, why: s.why, status: s.status, ops: s.labels, ...(s.actor ? { actor: s.actor } : {}) };
}
