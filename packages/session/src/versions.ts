import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@jumper/project-format";
import { applyToProject, projectEntities, same, type EntityMap, type HistoryState, type Step } from "./history.ts";
import type { ActionEntry } from "./session.ts";
import type { VisualState } from "@jumper/sim-core";
import type { ColorFrameImage } from "./sim.ts";

/**
 * Round 5, projects track (decision 0003, C3): a project's versions, rebuilt from its append-only
 * action log (.jumper/actions.jsonl). Version N is the N-th ok log line that changed the project or
 * a file. Every such line already holds the whole project after the change, so version N's circuit
 * is exact. Files are rebuilt from the log's file entries plus the undo history (history.json) for
 * writes the log does not carry (template files, undo / reject of a write); a file Jumper never
 * changed is taken as it is on disk now. Built firmware is kept by hash in .jumper/builds/.
 */

export interface VersionChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface VersionSummary {
  /** 1-based among ok action-log lines with project or file. */
  version: number;
  seq: number;
  t: string;
  actor: string;
  client?: string;
  op: string;
  why?: string;
  summary?: string;
  step?: number;
  /** Entity keys: "part:led1", "wire:w3", "file:firmware/main.ino", "firmware", "scenario:x", "world", "meta". */
  changes: VersionChanges;
  /** sha256 of the hex built while this version was current (the last build before the next version). */
  firmwareHash?: string;
  /** A build happened by this version, though its hash was not recorded (logs from before round 5). */
  firmwareBuilt?: boolean;
  /** A run / test frame exists for this version (the device as it was). */
  hasFrame: boolean;
}

export interface VersionFrame {
  t_ms: number;
  parts: Record<string, VisualState>;
  /** Wires carrying a HIGH level at that moment. */
  live?: string[];
  /** Round 6 (decision 0004, R7): colour screens at that moment (frames track fills it). */
  color?: Record<string, ColorFrameImage>;
}

export interface VersionDetail {
  version: number;
  summary: VersionSummary;
  project: Project;
  /** path → content at this version (only files Jumper knows about). */
  files: Record<string, string>;
  /** Paths whose content at this version is not known exactly (truncated in the log). */
  approxFiles: string[];
  firmware?: { hash: string; hex: string };
  frame?: VersionFrame;
  changes: VersionChanges;
}

interface ParsedLog {
  key: string;
  entries: ActionEntry[];
  /** Indexes into entries of the version lines. */
  versionIdx: number[];
}

const cache = new Map<string, ParsedLog>();

/** Max length write_file keeps in the log (session.ts); a longer file is truncated there. */
const LOG_FILE_CAP = 50_000;

function readLog(dir: string): ParsedLog {
  const file = join(dir, ".jumper", "actions.jsonl");
  if (!existsSync(file)) return { key: "", entries: [], versionIdx: [] };
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit;
  const entries: ActionEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ActionEntry);
    } catch {
      // a half-written last line: skip
    }
  }
  const versionIdx: number[] = [];
  entries.forEach((e, i) => {
    if (e.ok && (e.project || e.file)) versionIdx.push(i);
  });
  const parsed = { key, entries, versionIdx };
  cache.set(file, parsed);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return parsed;
}

function readHistory(dir: string): HistoryState | undefined {
  const f = join(dir, ".jumper", "history.json");
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as HistoryState;
  } catch {
    return undefined;
  }
}

function entityDiff(a: EntityMap, b: EntityMap): VersionChanges {
  const out: VersionChanges = { added: [], removed: [], changed: [] };
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (same(av, bv)) continue;
    if (av === null) out.added.push(k);
    else if (bv === null) out.removed.push(k);
    else out.changed.push(k);
  }
  return out;
}

/** Entity map of a project (empty before the first version). */
function entitiesOf(p: Project | undefined): EntityMap {
  return p ? projectEntities(p) : {};
}

/**
 * Walk the log once and compute, for each version, the project and the files map. Files: the log's
 * file entries, history steps for ops that wrote files without logging them, and a baseline for
 * the time before the first logged change.
 */
function replay(dir: string, log: ParsedLog, upTo: number): { project: Project | undefined; files: Map<string, string | null>; approx: Set<string>; prevProject: Project | undefined; prevFiles: Map<string, string | null> } {
  const history = readHistory(dir);
  const steps = history?.steps ?? [];
  const stepOfSeq = new Map<number, Step>();
  for (const s of steps) for (const seq of s.ops) stepOfSeq.set(seq, s);

  // Baseline: the "before" of the earliest step that touched each file; else unknown (taken from disk lazily).
  const files = new Map<string, string | null>();
  const approx = new Set<string>();
  const sortedSteps = [...steps].sort((a, b) => (a.ops[0] ?? 0) - (b.ops[0] ?? 0));
  for (const s of sortedSteps) {
    for (const [k, v] of Object.entries(s.before)) {
      if (!k.startsWith("file:")) continue;
      const path = k.slice(5);
      if (!files.has(path)) files.set(path, (v as string | null) ?? null);
    }
  }

  let project: Project | undefined;
  let prevProject: Project | undefined;
  let prevFiles = new Map(files);
  const end = log.versionIdx[upTo - 1] ?? -1;
  for (let i = 0; i <= end; i++) {
    const e = log.entries[i]!;
    if (!e.ok) continue;
    const isVersion = !!(e.project || e.file);
    if (!isVersion) continue;
    if (i === end) {
      prevProject = project;
      prevFiles = new Map(files);
    }
    if (e.project) project = e.project;
    if (e.file) {
      files.set(e.file.path, e.file.content);
      if (typeof e.file.content === "string" && e.file.content.length >= LOG_FILE_CAP) approx.add(e.file.path);
      else approx.delete(e.file.path);
    } else {
      // Ops that change files without logging the content: take them from the undo history.
      const touched = fileEffects(e, stepOfSeq, steps);
      for (const [path, content] of Object.entries(touched)) {
        files.set(path, content);
        approx.delete(path);
      }
    }
  }
  return { project, files, approx, prevProject, prevFiles };
}

/** File contents an op without a `file` field left behind, from the step history. */
function fileEffects(e: ActionEntry, stepOfSeq: Map<number, Step>, steps: Step[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const fileKeys = (m: EntityMap) => Object.entries(m).filter(([k]) => k.startsWith("file:"));
  if (e.op === "undo" || e.op === "reject_step") {
    // Find which step: reject_step {step}; undo says "undid step N: …" in its summary.
    const id = e.op === "reject_step" ? Number(e.args?.step) : Number(/step (\d+)/.exec(e.summary ?? "")?.[1]);
    const s = steps.find((x) => x.id === id);
    if (s) for (const [k, v] of fileKeys(s.before)) out[k.slice(5)] = (v as string | null) ?? null;
    return out;
  }
  if (e.op === "redo") {
    const id = Number(/step (\d+)/.exec(e.summary ?? "")?.[1]);
    const s = steps.find((x) => x.id === id);
    if (s) for (const [k, v] of fileKeys(s.after)) out[k.slice(5)] = (v as string | null) ?? null;
    return out;
  }
  // new_project, restore_version, delete_file, create_part…: the step this op belongs to.
  const s = stepOfSeq.get(e.seq);
  if (s && s.ops.at(-1) === e.seq) for (const [k, v] of fileKeys(s.after)) out[k.slice(5)] = (v as string | null) ?? null;
  return out;
}

/**
 * The project before version 1, when the folder had one before its log started (an example copied
 * into a project, a jumper.json written by hand): the first step's "before" values applied back.
 * Undefined for a project the log starts from scratch (new_project), so everything shows as added.
 */
function firstBaseline(dir: string, log: ParsedLog): Project | undefined {
  const first = log.entries[log.versionIdx[0] ?? -1];
  if (!first?.project || first.op === "new_project") return undefined;
  const step = readHistory(dir)?.steps.find((s) => s.ops[0] === first.seq);
  if (!step) return undefined;
  const before = Object.fromEntries(Object.entries(step.before).filter(([k]) => !k.startsWith("file:")));
  // The step may hold later ops too; their keys' "before" is still the value before the first op.
  return applyToProject(first.project, before);
}

/** Index range [from, to) of log entries that belong to version n (its line up to the next version line). */
function span(log: ParsedLog, n: number): [number, number] {
  const from = log.versionIdx[n - 1]!;
  const to = log.versionIdx[n] ?? log.entries.length;
  return [from, to];
}

/** The last build at or before version n's span ends: its hash (logs before round 5 have none). */
function firmwareFor(log: ParsedLog, n: number): { hash?: string } | undefined {
  const [, to] = span(log, n);
  for (let i = to - 1; i >= 0; i--) {
    const fw = log.entries[i]!.firmware;
    if (fw) return fw.hash ? { hash: fw.hash } : {};
  }
  return undefined;
}

function frameFor(log: ParsedLog, n: number): VersionFrame | undefined {
  const [from, to] = span(log, n);
  for (let i = to - 1; i >= from; i--) {
    const frames = log.entries[i]!.frames;
    if (!frames?.length) continue;
    const parts: Record<string, VisualState> = {};
    let live: string[] | undefined;
    for (const f of frames) {
      Object.assign(parts, f.states ?? {});
      if (f.live) live = f.live;
    }
    return { t_ms: frames.at(-1)!.vt, parts, ...(live ? { live } : {}) };
  }
  return undefined;
}

/** Number of versions in a project's log. */
export function versionCount(dir: string): number {
  return readLog(dir).versionIdx.length;
}

/** Every version of the project in `dir`, oldest first. */
export function listVersions(dir: string): VersionSummary[] {
  const log = readLog(dir);
  const out: VersionSummary[] = [];
  let prev: Project | undefined = firstBaseline(dir, log);
  log.versionIdx.forEach((idx, k) => {
    const n = k + 1;
    const e = log.entries[idx]!;
    const changes = entityDiff(entitiesOf(prev), entitiesOf(e.project ?? prev));
    if (e.file && !changes.changed.includes(`file:${e.file.path}`)) {
      (e.file.content === null ? changes.removed : changes.changed).push(`file:${e.file.path}`);
    }
    if (e.project) prev = e.project;
    const [from, to] = span(log, n);
    let hasFrame = false;
    for (let i = from; i < to && !hasFrame; i++) hasFrame = !!log.entries[i]!.frames?.length;
    const fw = firmwareFor(log, n);
    out.push({
      version: n,
      seq: e.seq,
      t: e.t,
      actor: e.actor,
      ...(e.client ? { client: e.client } : {}),
      op: e.op,
      ...(e.step?.why ? { why: e.step.why } : typeof e.args?.why === "string" ? { why: e.args.why } : {}),
      ...(e.summary ? { summary: e.summary } : {}),
      ...(e.step ? { step: e.step.id } : {}),
      changes,
      ...(fw?.hash ? { firmwareHash: fw.hash } : fw ? { firmwareBuilt: true } : {}),
      hasFrame,
    });
  });
  return out;
}

/** Version n in full: project, files, firmware, the device frame, what changed. Undefined when n is out of range. */
export function versionDetail(dir: string, n: number): VersionDetail | undefined {
  const log = readLog(dir);
  if (!Number.isInteger(n) || n < 1 || n > log.versionIdx.length) return undefined;
  const summary = listVersions(dir)[n - 1]!;
  const r = replay(dir, log, n);
  // A version line always follows a project line in practice; if the first one is file-only, use the current project file's shape.
  const project = r.project ?? (JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")) as Project);
  const files: Record<string, string> = {};
  for (const [path, content] of r.files) {
    if (content !== null) files[path] = content;
  }
  // Firmware files Jumper never touched: as they are on disk (they did not change through Jumper).
  for (const path of diskFirmwareFiles(dir)) {
    if (!r.files.has(path) && !(path in files)) files[path] = readFileSync(join(dir, path), "utf8");
  }
  const changes = { ...summary.changes };
  for (const [path, content] of r.files) {
    const before = r.prevFiles.get(path);
    if (r.prevFiles.has(path) && !same(before, content) && !changes.changed.includes(`file:${path}`) && !changes.added.includes(`file:${path}`) && !changes.removed.includes(`file:${path}`)) {
      if (before === null) changes.added = [...changes.added, `file:${path}`];
      else if (content === null) changes.removed = [...changes.removed, `file:${path}`];
      else changes.changed = [...changes.changed, `file:${path}`];
    }
  }
  const hash = summary.firmwareHash;
  const hexFile = hash ? join(dir, ".jumper", "builds", `${hash}.hex`) : undefined;
  const frame = frameFor(log, n);
  return {
    version: n,
    summary,
    project,
    files,
    approxFiles: [...r.approx],
    ...(hash && hexFile && existsSync(hexFile) ? { firmware: { hash, hex: readFileSync(hexFile, "utf8") } } : {}),
    ...(frame ? { frame } : {}),
    changes,
  };
}

/** Files at version n as path → content | null (null = did not exist then); only paths Jumper knows. */
export function versionFiles(dir: string, n: number): Map<string, string | null> {
  return replay(dir, readLog(dir), n).files;
}

/** firmware/** source files on disk now (relative paths, build/ and dot folders skipped). */
export function diskFirmwareFiles(dir: string): string[] {
  const root = join(dir, "firmware");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const abs = join(d, n);
      const r = `${rel}/${n}`;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (n !== "build" && !n.startsWith(".")) walk(abs, r);
      } else if (!/\.(hex|bin|elf|eep)$/.test(n)) out.push(r);
    }
  };
  walk(root, "firmware");
  return out;
}


/**
 * The last run_tests in an action log: passed / total and when. Reads from the end in chunks and
 * only looks at each line's start (agent logs carry big frame arrays), so it is cheap on big logs.
 */
export function lastTestsFromLog(file: string): { passed: number; total: number; at?: string } | undefined {
  if (!existsSync(file)) return undefined;
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const chunk = 1 << 20;
    let pos = size;
    let carry = "";
    while (pos > 0) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const text = buf.toString("latin1") + carry;
      const lines = text.split("\n");
      carry = pos > 0 ? lines.shift()! : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const hit = testsLine(lines[i]!);
        if (hit) return hit;
      }
      // keep at most one partial line's head; a line start is all testsLine reads
      if (carry.length > 4 * chunk) carry = carry.slice(0, 4096);
    }
    return carry ? testsLine(carry) : undefined;
  } finally {
    closeSync(fd);
  }
}

function testsLine(line: string): { passed: number; total: number; at?: string } | undefined {
  if (!line.includes('"op":"run_tests"') || !line.includes('"ok":true')) return undefined;
  const m = /"summary":"(\d+)\/(\d+) scenarios passed"/.exec(line);
  if (!m) return undefined;
  const t = /"t":"([^"]+)"/.exec(line)?.[1];
  return { passed: Number(m[1]), total: Number(m[2]), ...(t ? { at: t } : {}) };
}
