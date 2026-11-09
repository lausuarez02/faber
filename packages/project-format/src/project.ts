import { FORMAT_VERSION, ProjectSchema, type PartInstance, type PinRef, type Project, type Wire } from "./schema.ts";

/** One readable validation problem. `path` is like "wires[2].from.part". */
export interface ProjectIssue {
  path: string;
  message: string;
}

export class ProjectParseError extends Error {
  readonly issues: ProjectIssue[];
  constructor(issues: ProjectIssue[]) {
    super(
      `Invalid jumper.json (${issues.length} problem${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n"),
    );
    this.name = "ProjectParseError";
    this.issues = issues;
  }
}

export type ParseResult = { ok: true; project: Project } | { ok: false; issues: ProjectIssue[] };

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

/** Validate without throwing. Accepts a JSON string or an already-parsed value. */
export function safeParseProject(input: string | unknown): ParseResult {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { ok: false, issues: [{ path: "", message: `not valid JSON: ${(err as Error).message}` }] };
    }
  }
  const res = ProjectSchema.safeParse(data);
  if (res.success) return { ok: true, project: res.data };
  return {
    ok: false,
    issues: res.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
  };
}

/** Parse and validate a jumper.json (string or object). Throws ProjectParseError with readable issues. */
export function parseProject(input: string | unknown): Project {
  const res = safeParseProject(input);
  if (!res.ok) throw new ProjectParseError(res.issues);
  return res.project;
}

/** A new empty project. */
export function createProject(name: string, description?: string): Project {
  return {
    format: FORMAT_VERSION,
    name,
    ...(description !== undefined ? { description } : {}),
    parts: [],
    wires: [],
    scenarios: [],
  };
}

// ---------------------------------------------------------------------------
// Stable serialization
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Copy `obj` with keys in `order` first (in that order), then remaining keys sorted. Drops undefined. */
function ordered(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function sortedKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return ordered(obj, []);
}

/** `{ "a": 1, "b": [1, 2] }` style, on one line. */
function inline(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")} }`;
}

function canonicalPart(p: PartInstance): Record<string, unknown> {
  return ordered(
    { ...p, props: p.props ? sortedKeys(p.props) : undefined },
    ["id", "type", "x", "y", "rotation", "props"],
  );
}

function canonicalPin(r: PinRef): Record<string, unknown> {
  return ordered(r as unknown as Record<string, unknown>, ["part", "pin"]);
}

function canonicalWire(w: Wire): Record<string, unknown> {
  return ordered(
    {
      ...w,
      from: canonicalPin(w.from),
      to: canonicalPin(w.to),
      waypoints: w.waypoints?.map((pt) => ordered(pt, ["x", "y"])),
    },
    ["id", "from", "to", "color", "waypoints"],
  );
}

function deepSorted(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepSorted);
  const o = sortedKeys(value as Record<string, unknown>);
  for (const k of Object.keys(o)) o[k] = deepSorted(o[k]);
  return o;
}

function arrayOfLines(items: unknown[], indent: string): string {
  if (items.length === 0) return "[]";
  return `[\n${items.map((i) => `${indent}  ${inline(i)}`).join(",\n")}\n${indent}]`;
}

/**
 * Serialize a project for disk: stable key order, 2-space indentation,
 * one part / wire / scenario per line, trailing newline.
 * Same project in → byte-identical string out.
 */
export function serializeProject(project: Project): string {
  const firmware = project.firmware
    ? ordered(
        {
          ...project.firmware,
          build: project.firmware.build ? ordered(project.firmware.build, ["tool", "fqbn"]) : undefined,
        },
        ["board", "dir", "sketch", "artifact", "build", "libraries"],
      )
    : undefined;

  const lines: string[] = ["{"];
  const fields: string[] = [];
  fields.push(`  "format": ${JSON.stringify(project.format)}`);
  fields.push(`  "name": ${JSON.stringify(project.name)}`);
  if (project.description !== undefined) fields.push(`  "description": ${JSON.stringify(project.description)}`);
  fields.push(`  "parts": ${arrayOfLines(project.parts.map(canonicalPart), "  ")}`);
  fields.push(`  "wires": ${arrayOfLines(project.wires.map(canonicalWire), "  ")}`);
  if (firmware) {
    const fw = JSON.stringify(firmware as Json, null, 2).replace(/\n/g, "\n  ");
    fields.push(`  "firmware": ${fw}`);
  }
  fields.push(`  "scenarios": ${arrayOfLines(project.scenarios.map(deepSorted), "  ")}`);
  if (project.world !== undefined) {
    fields.push(`  "world": ${JSON.stringify(project.world as Json, null, 2).replace(/\n/g, "\n  ")}`);
  }
  lines.push(fields.join(",\n"));
  lines.push("}");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------

/** An electrical net: every pin that is connected through wires. */
export interface Net {
  /** Stable id: "n0", "n1", ... ordered by the net's first pin (sorted by part, then pin). */
  id: string;
  /** Pins in this net, sorted by part id then pin id. */
  pins: PinRef[];
}

/** Canonical string key for a pin: "partId:pinId". */
export function pinKey(ref: PinRef): string {
  return `${ref.part}:${ref.pin}`;
}

function comparePins(a: PinRef, b: PinRef): number {
  if (a.part !== b.part) return a.part < b.part ? -1 : 1;
  if (a.pin !== b.pin) return a.pin < b.pin ? -1 : 1;
  return 0;
}

export interface BuildNetsOptions {
  /** Extra pins to include even when no wire touches them (they become single-pin nets). */
  extraPins?: Iterable<PinRef>;
}

/**
 * Group wired pins into nets with union-find. Deterministic: same project → same ids.
 * Pins not touched by any wire are only included when passed in `extraPins`.
 */
export function buildNets(project: Pick<Project, "wires">, options: BuildNetsOptions = {}): Net[] {
  const parent = new Map<string, string>();
  const refs = new Map<string, PinRef>();

  const add = (r: PinRef) => {
    const k = pinKey(r);
    if (!parent.has(k)) {
      parent.set(k, k);
      refs.set(k, { part: r.part, pin: r.pin });
    }
    return k;
  };
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = k;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  for (const w of project.wires) {
    const a = find(add(w.from));
    const b = find(add(w.to));
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  for (const r of options.extraPins ?? []) add(r);

  const groups = new Map<string, PinRef[]>();
  for (const k of parent.keys()) {
    const root = find(k);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = []));
    g.push(refs.get(k)!);
  }
  const sorted = [...groups.values()].map((pins) => pins.sort(comparePins)).sort((a, b) => comparePins(a[0]!, b[0]!));
  return sorted.map((pins, i) => ({ id: `n${i}`, pins }));
}

/** Map "partId:pinId" → net id, for quick lookup. */
export function netIndex(nets: readonly Net[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of nets) for (const p of n.pins) m.set(pinKey(p), n.id);
  return m;
}
