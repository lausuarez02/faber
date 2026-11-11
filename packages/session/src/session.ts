import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import {
  FORMAT_VERSION,
  buildNets,
  parseProject,
  safeParseProject,
  serializeProject,
  type PartInstance,
  type PinRef,
  type Project,
  type PropValue,
  type Rotation,
  type Scenario,
  type Wire,
  normalizeScenarioStep,
} from "@jumper/project-format";
import { AGENT_MADE_LABEL, boardWiring, formatClips, parseClips, rankParts, registry as defaultRegistry, withProjectParts } from "@jumper/parts";
import { PART_CATEGORIES, type PartRegistry, type PartSpec, type VisualValue } from "@jumper/sim-core";
import { hexToUf2 } from "@jumper/sim-backends";
import { buildFirmware, type BuildRequest, type BuildResult } from "@jumper/runner";
import { checkDesign, type DesignIssue } from "./drc.ts";
import { asJumperError, didYouMean, fail, JumperError } from "./errors.ts";
import { bomMarkdown, solderedAssemblyMarkdown, wiringMarkdown } from "./exporter.ts";
import { assemblyStyle, wireCuts, wireCutsCsv } from "./assembly.ts"; // round 6 power
import { createPartTemplate, fits, resolvePartType } from "./catalog-fit.ts"; // round 6 power
import { fidelityReport } from "./fidelity.ts";
import { suggestConnections, usageFor } from "./hints.ts";
import {
  applyToProject,
  diffEntities,
  emptyHistory,
  fileChanges,
  planRevert,
  projectEntities,
  isPersonActor,
  record,
  stepSummary,
  type EntityMap,
  type HistoryState,
  type Json,
  type Step,
} from "./history.ts";
import { autoPlace, overlappingParts, sizeOf } from "./layout.ts";
import { findPart, fmtRef, resolveRef, specOf } from "./pins.ts";
import { readNetworkLog, runLive, setAiMode } from "./network.ts";
import { runScenario, setPartValue, validateScenario, type ScenarioResult } from "./scenario.ts";
import { composeSvg, svgToPng } from "./screenshot.ts";
import { limitColorFrames } from "./color-frames.ts"; // round 6 frames
import { clampRegion, litCount, loadSnapshot, regionRows, saveSnapshot } from "./snapshots.ts";
import { compactState, FAULT_KINDS, SimHost, type Frame } from "./sim.ts";
import { TEMPLATE_SOURCES, TEMPLATES } from "./templates.ts";
import { EXT_OPS, type ExtOpContext } from "./tools/index.ts";
import { isProjectPartRegistry, refreshProjectParts } from "./tools/agentparts.ts";
import { viewerUrlFor } from "./agent-runtime.ts";
import { chromiumProblem } from "./recorder.ts";
import { newProjectFolder, projectId, projectSlug, registerProject } from "./projects-registry.ts";
import { compactVisual, displayPng, runScenarioVisual, type VisualReport, type VisualScenario } from "./visual-capture.ts";

export type Builder = (req: BuildRequest) => Promise<BuildResult>;

export interface SessionOptions {
  /** Project folder (jumper.json + firmware/). Created on the first change if missing. */
  dir: string;
  registry?: PartRegistry;
  /** Firmware builder; default: the local Docker runner. */
  builder?: Builder;
  /** Who is acting, recorded in the action log: "mcp", "cli", "web", "test". */
  actor?: string;
  /**
   * Round 5 (decision 0003, C3): lets new_project {folder} make the new folder the active project
   * of the host (jumper serve swaps its session, hub and MCP binding). Without it, new_project
   * {folder} creates and registers the folder and tells the caller to reopen with --project.
   */
  openProject?: (dir: string) => Promise<void>;
  /** Where new_project {folder} creates project folders (C3). Default: the parent of `dir`. */
  projectsRoot?: string;
}

/** One line of .jumper/actions.jsonl: what happened, when (wall + virtual), and the state after. */
export interface ActionEntry {
  seq: number;
  /** Wall time, ISO. */
  t: string;
  /** Virtual (simulated) ms at the time of the action, when a simulation exists. */
  vt?: number;
  actor: string;
  /** Which ProjectSession instance (one per process / server) wrote the line. */
  sid?: string;
  /** The MCP client that made the call ("claude-code 2.1.319"), when known. */
  client?: string;
  op: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  summary?: string;
  step?: { id: number; why: string };
  /** The part / pin being edited, for the agent cursor. */
  target?: { part: string; pin?: string };
  /** Project after a change. */
  project?: Project;
  file?: { path: string; content: string | null };
  frames?: Frame[];
  steps?: ReturnType<typeof stepSummary>[];
  /**
   * Firmware hex after a successful build (replay loads it for live LEDs). Round 5 (decision 0003,
   * C3/C6): `hash` is the sha256 of the hex and a copy is kept at .jumper/builds/<hash>.hex, so
   * history can show the device at any version and followers can tell new firmware from old.
   */
  firmware?: { artifact: string; hash?: string; /** sourceHash() the hex was built from (round 6b) */ source?: string };
  /** The op's result when it is small (test results, check results…), for replay captions. */
  result?: unknown;
}

export type SessionEvent = { type: "action"; entry: ActionEntry };

/** Who makes one call, when one session serves several faces (jumper serve: web canvas + MCP clients). */
export interface CallMeta {
  /** Overrides the session's actor for this call: "mcp", "web", "cli"… */
  actor?: string;
  /** MCP client name and version, e.g. "claude-code 2.1.319". */
  client?: string;
}

interface OpCtx {
  seq: number;
  why: string | undefined;
  /** Who made the call (actor / client), for ops that act on another project (new_project {folder}). */
  meta?: CallMeta;
  summary?: string;
  target?: { part: string; pin?: string };
  project?: boolean;
  file?: { path: string; content: string | null };
  frames?: Frame[];
  steps?: boolean;
  firmware?: { artifact: string; hash?: string; source?: string };
  /** The step this op's changes went into (the person's own step is not the open one). */
  step?: number;
}

const WIRE_COLORS = ["#FFB23F", "#4DA3FF", "#F2E14A", "#B47CFF", "#E9EDF2", "#5CF2A1"];
const SHORT_IDS: Record<string, string> = {
  "arduino-uno": "uno",
  "arduino-nano": "nano",
  "dfplayer-mini": "df", // round 7 voice
  speaker: "spk", // round 7 voice
  "speaker-20mm": "spk", // round 8 parts-advice
  "speaker-15mm": "spk",
  "raspberry-pi-pico": "pico",
  "seeed-xiao-rp2040": "xiao",
  "waveshare-rp2040-zero": "zero",
  "ssd1306-oled-i2c": "oled",
  pushbutton: "btn",
  potentiometer: "pot",
  photoresistor: "ldr",
  resistor: "r",
  led: "led",
  "rgb-led": "rgb",
  "slide-switch": "sw",
  buzzer: "buzzer",
  "hc-sr04": "sonar",
  l298n: "driver",
  "dc-motor": "motor",
  servo: "servo",
  "servo-sg90": "servo",
  "robot-chassis-2wd": "chassis",
  "battery-pack": "battery",
  bme280: "bme",
  mpu6050: "imu",
  "ds3231-rtc": "rtc",
  "lcd1602-i2c": "lcd",
};
const SOURCE_EXT = /\.(ino|pde|h|hpp|hh|c|cc|cpp|cxx|S|s)$/;

function topologyKey(p: Project): string {
  return JSON.stringify([p.parts.map((x) => [x.id, x.type, x.props ?? {}]), p.wires.map((w) => [w.from.part, w.from.pin, w.to.part, w.to.pin]), p.firmware?.board ?? null, p.power?.usb !== false]); // round 6 power: USB plugged or not
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * A project folder as a headless editing + simulation session. Every public op validates its input,
 * returns a compact JSON-able result, and is appended to .jumper/actions.jsonl. Edits are grouped
 * into steps (with the caller's "why") that can be undone, redone, accepted or rejected.
 */
export class ProjectSession {
  readonly dir: string;
  readonly registry: PartRegistry;
  readonly actor: string;
  /** Short id of this session instance, written on every action-log line (tells processes apart). */
  readonly sid: string = randomUUID().slice(0, 8);
  private builder: Builder;
  project: Project;
  history: HistoryState = emptyHistory();
  private seq = 0;
  private host: SimHost | undefined;
  private hostKey = "";
  private diskStamp = "";
  private listeners = new Set<(e: SessionEvent) => void>();
  private lastBuild: BuildResult | undefined;
  /** The last run_tests as a visual report (filmstrips), served to the web app's Tests panel. */
  lastVisualReport: VisualReport | undefined;
  /** set_ai_mode, kept across simulation restarts. */
  private aiMode: "mock" | "live" = "mock";
  /** What the last commit did to the running simulation (set by pushPropsOrInvalidate). */
  private liveNote: string | undefined;

  /** Host hook to switch the active project (SessionOptions.openProject). */
  readonly openProject: ((dir: string) => Promise<void>) | undefined;
  /** Where new_project {folder} creates folders (SessionOptions.projectsRoot). */
  readonly projectsRoot: string;

  constructor(opts: SessionOptions) {
    this.dir = resolve(opts.dir);
    this.openProject = opts.openProject;
    this.projectsRoot = resolve(opts.projectsRoot ?? dirname(this.dir));
    // --- agentparts (decision 0003, C4): built-ins + this project's agent-made parts (parts/<id>/), refreshed in sync()
    this.registry = withProjectParts(opts.registry ?? defaultRegistry);
    // --- end agentparts
    this.builder = opts.builder ?? buildFirmware;
    this.actor = opts.actor ?? "session";
    this.project = { format: FORMAT_VERSION, name: basename(this.dir) || "project", parts: [], wires: [], scenarios: [] };
    this.sync(true);
  }

  // =================================================================== plumbing

  get projectFile(): string {
    return join(this.dir, "jumper.json");
  }
  private get metaDir(): string {
    return join(this.dir, ".jumper");
  }
  get actionLogFile(): string {
    return join(this.metaDir, "actions.jsonl");
  }
  get exists(): boolean {
    return existsSync(this.projectFile);
  }

  onEvent(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private stamp(): string {
    const parts: string[] = [];
    for (const f of [this.projectFile, join(this.metaDir, "history.json"), this.actionLogFile]) {
      try {
        const s = statSync(f);
        parts.push(`${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push("-");
      }
    }
    return parts.join("|");
  }

  /** Re-read jumper.json / history / log position if another process (CLI, web, another agent) changed them. */
  sync(force = false): void {
    // --- agentparts (decision 0003, C4): reload parts/ when it changed; a changed part restarts the sim
    if (refreshProjectParts(this.dir, this.registry, force)) this.hostKey = "";
    // --- end agentparts
    const st = this.stamp();
    if (!force && st === this.diskStamp) return;
    if (existsSync(this.projectFile)) {
      const res = safeParseProject(readFileSync(this.projectFile, "utf8"));
      if (!res.ok) {
        fail(
          "invalid-project",
          `jumper.json in ${this.dir} is invalid`,
          res.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; "),
          "fix the file by hand (or restore it with git), then retry",
        );
      }
      this.project = res.project;
    }
    const hf = join(this.metaDir, "history.json");
    if (existsSync(hf)) {
      try {
        this.history = JSON.parse(readFileSync(hf, "utf8")) as HistoryState;
      } catch {
        this.history = emptyHistory();
      }
      this.settlePersonSteps();
    }
    if (existsSync(this.actionLogFile)) {
      const text = readFileSync(this.actionLogFile, "utf8").trimEnd();
      const last = text.slice(text.lastIndexOf("\n") + 1);
      try {
        this.seq = Math.max(this.seq, (JSON.parse(last) as ActionEntry).seq ?? 0);
      } catch {
        this.seq = Math.max(this.seq, text ? text.split("\n").length : 0);
      }
    }
    this.diskStamp = this.stamp();
  }

  /**
   * Steps saved before steps carried their actor: a pending one whose ops were all the person's own
   * (actor "web" in the action log) is accepted, so it never shows as an agent proposal.
   */
  private settlePersonSteps(): void {
    const unknown = this.history.steps.filter((s) => s.status === "pending" && !s.actor);
    if (!unknown.length || !existsSync(this.actionLogFile)) return;
    const actorOf = new Map<number, string>();
    for (const line of readFileSync(this.actionLogFile, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as ActionEntry;
        if (e.seq !== undefined && e.actor) actorOf.set(e.seq, e.actor);
      } catch {
        // a torn line: skip it
      }
    }
    for (const s of unknown) {
      const actors = s.ops.map((n) => actorOf.get(n));
      if (!actors.length || !actors.every((a) => isPersonActor(a))) continue;
      s.actor = "web";
      s.status = "accepted";
      if (this.history.open === s.id) this.history.open = undefined;
    }
  }

  private persist(): void {
    mkdirSync(this.metaDir, { recursive: true });
    writeFileSync(this.projectFile, serializeProject(this.project));
    writeFileSync(join(this.metaDir, "history.json"), JSON.stringify(this.history));
    const gi = join(this.metaDir, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "# Jumper session state (undo history, build cache info). The action log is worth keeping for replays.\nhistory.json\nbuild.json\nbuilds/\nthumbs/\n");
  }

  // round 6 power: planning calls (plan_device, search_parts, get_part) before new_project {folder} belong to the
  // project they lead to, not to the one that happens to be open. They wait here (shown live at once) and are
  // written to whichever log comes next: the new project's, or this one's on the next other call / dispose.
  private planBuffer: ActionEntry[] = [];

  private flushPlanning(): void {
    if (!this.planBuffer.length) return;
    const lines = this.planBuffer.splice(0).map((e) => JSON.stringify(e) + "\n").join("");
    try {
      mkdirSync(this.metaDir, { recursive: true });
      appendFileSync(this.actionLogFile, lines);
    } catch {
      // logging must never break an op
    }
    this.diskStamp = this.stamp();
  }

  /** Hand the waiting planning entries to another project folder's log (new_project {folder}). */
  private movePlanningTo(dir: string): number {
    const n = this.planBuffer.length;
    if (!n) return 0;
    const lines = this.planBuffer.splice(0).map((e) => JSON.stringify({ ...e, moved_from: this.dir }) + "\n").join("");
    try {
      mkdirSync(join(dir, ".jumper"), { recursive: true });
      appendFileSync(join(dir, ".jumper", "actions.jsonl"), lines);
    } catch {
      // logging must never break an op
    }
    return n;
  }

  private logAction(entry: ActionEntry): void {
    if (PLANNING_OPS.has(entry.op)) {
      this.planBuffer.push(entry);
      if (this.planBuffer.length > 200) this.flushPlanning();
      for (const l of this.listeners) l({ type: "action", entry });
      return;
    }
    if (!(entry.op === "new_project" && entry.ok && (entry.args as { folder?: unknown }).folder)) this.flushPlanning();
    try {
      mkdirSync(this.metaDir, { recursive: true });
      appendFileSync(this.actionLogFile, JSON.stringify(entry) + "\n");
    } catch {
      // logging must never break an op
    }
    this.diskStamp = this.stamp();
    for (const l of this.listeners) l({ type: "action", entry });
  }

  /**
   * Run one op by name with validation, logging and error shaping. All three faces (MCP, CLI, web)
   * go through here, so they behave the same.
   */
  async call(op: string, args: Record<string, unknown> = {}, meta: CallMeta = {}): Promise<unknown> {
    const ext = OP_METHODS[op] ? undefined : EXT_OPS[op];
    const handler = ext
      ? (a: Record<string, unknown>, c: OpCtx) => ext(a, this.extContext(c))
      : (this as unknown as Record<string, unknown>)[OP_METHODS[op] ?? ""];
    if (typeof handler !== "function") {
      const names = allOpNames();
      fail("unknown-op", `Unknown operation '${op}'`, `the operations are: ${names.join(", ")}`, `call one of those.${didYouMean(op, names)}`);
    }
    this.sync();
    const why = typeof args.why === "string" ? args.why : undefined;
    const ctx: OpCtx = { seq: ++this.seq, why, meta };
    const t = new Date().toISOString();
    const vt = this.host ? round(this.host.timeMs) : undefined;
    const who = { actor: meta.actor ?? this.actor, sid: this.sid, ...(meta.client ? { client: meta.client } : {}) };
    try {
      const result = await (handler as (a: Record<string, unknown>, c: OpCtx) => unknown).call(this, args, ctx);
      const stepId = ctx.step ?? this.history.open;
      const step = ctx.project || ctx.file ? this.history.steps.find((s) => s.id === stepId) : undefined;
      this.logAction({
        seq: ctx.seq,
        t,
        ...(vt !== undefined ? { vt } : {}),
        ...who,
        op,
        args: trimArgs(args),
        ok: true,
        ...(ctx.summary ? { summary: ctx.summary } : {}),
        ...(step ? { step: { id: step.id, why: step.why } } : {}),
        ...(ctx.target ? { target: ctx.target } : {}),
        ...(ctx.project ? { project: this.project } : {}),
        ...(ctx.file ? { file: ctx.file } : {}),
        ...(ctx.frames?.length ? { frames: ctx.frames } : {}),
        ...(ctx.steps || ctx.project || ctx.file ? { steps: this.history.steps.slice(-30).map(stepSummary) } : {}),
        ...(ctx.firmware ? { firmware: ctx.firmware } : {}),
        ...(LOG_RESULT_OPS.has(op) ? { result: smallResult(result) } : {}),
      });
      return result;
    } catch (err) {
      const je = asJumperError(err, `${op} failed`);
      this.logAction({ seq: ctx.seq, t, ...(vt !== undefined ? { vt } : {}), ...who, op, args: trimArgs(args), ok: false, error: je.message });
      throw je;
    }
  }

  /** What a round-5 tool module handler gets (src/tools/types.ts). */
  private extContext(ctx: OpCtx): ExtOpContext {
    return {
      session: this,
      why: ctx.why,
      commit: (label, next, files) => this.commit(ctx, label, next, files),
      summary: (text) => {
        ctx.summary = text;
      },
      target: (part, pin) => {
        ctx.target = pin ? { part, pin } : { part };
      },
    };
  }

  /** Apply a project change as one recorded edit. Validates, writes jumper.json and files, records the step. */
  private commit(ctx: OpCtx, label: string, next: Project, files: Record<string, string | null> = {}): Step {
    const res = safeParseProject(next);
    if (!res.ok) {
      fail("invalid-change", `${label} would make the project invalid`, res.issues.map((i) => `${i.path}: ${i.message}`).join("; "), "change the arguments (this is usually a duplicate id or a wire to a missing part)");
    }
    const beforeEnt = projectEntities(this.project);
    const afterEnt = projectEntities(res.project);
    for (const [path, content] of Object.entries(files)) {
      beforeEnt[`file:${path}`] = this.readFileOrNull(path);
      afterEnt[`file:${path}`] = content;
    }
    const { before, after } = diffEntities(beforeEnt, afterEnt);
    const topoChanged = topologyKey(this.project) !== topologyKey(res.project);
    const oldProject = this.project;
    this.project = res.project;
    for (const [path, content] of Object.entries(files)) this.writeOrDelete(path, content);
    const step = record(this.history, ctx.why, ctx.seq, label, before, after, new Date().toISOString(), ctx.meta?.actor ?? this.actor);
    this.persist();
    ctx.project = true;
    ctx.step = step.id;
    if (topoChanged) this.liveNote = this.pushPropsOrInvalidate(oldProject);
    return step;
  }

  /**
   * Same circuit with new props → push them into the running sim (and keep them for run {reset}).
   * Props of parts the physics world reads at start (chassis, motors…) and anything else restart the
   * sim on next use. Returns what happened, for the op's result.
   */
  private pushPropsOrInvalidate(old: Project): string | undefined {
    if (!this.host) return undefined;
    const shape = (p: Project) => JSON.stringify([p.parts.map((x) => [x.id, x.type]), p.wires.map((w) => [w.from, w.to]), p.firmware?.board]);
    if (shape(old) !== shape(this.project)) return "the next run restarts the simulation at 0 ms with the new circuit and values"; // getHost() rebuilds
    const worldText = JSON.stringify(this.project.world ?? null);
    const changedParts = this.project.parts.filter((p) => JSON.stringify(old.parts.find((x) => x.id === p.id)?.props ?? {}) !== JSON.stringify(p.props ?? {})).map((p) => p.id);
    if (changedParts.some((id) => worldText.includes(`"${id}"`))) {
      this.hostKey = ""; // getHost() rebuilds (and says so)
      return `${changedParts.join(", ")} ${changedParts.length > 1 ? "are" : "is"} part of the robot world, which is built at 0 ms, so the next run restarts the simulation at 0 ms with the new value`;
    }
    if (this.hostKey !== this.simKey(old)) return "the next run restarts the simulation at 0 ms with the new circuit and values"; // the host was already stale; getHost() rebuilds
    let changed: string[];
    try {
      changed = this.host.adoptProps(this.project);
    } catch {
      return "the next run restarts the simulation at 0 ms with the new circuit and values";
    }
    this.hostKey = this.simKey();
    return changed.length ? `applied live to the running simulation at ${round(this.host.timeMs)} ms (${changed.join(", ")}); run {reset: true} also starts from the new value` : undefined;
  }

  private readFileOrNull(rel: string): string | null {
    const abs = join(this.dir, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  private writeOrDelete(rel: string, content: string | null): void {
    const abs = join(this.dir, rel);
    if (content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  private spec(type: string): PartSpec {
    const def = this.registry.get(type);
    if (!def) {
      const ids = this.registry.list().map((d) => d.spec.id);
      fail("unknown-part-type", `No part type '${type}' in the catalog`, `there are ${ids.length} types`, `call search_parts to find one (e.g. search_parts "button").${didYouMean(type, ids)}`);
    }
    return def.spec;
  }

  // =================================================================== project

  /** new_project: start a project in this folder from a template, or in a new folder ({folder}). */
  async newProject(args: { template?: string; name?: string; overwrite?: boolean; folder?: boolean | string }, ctx: OpCtx): Promise<unknown> {
    const template = args.template ?? "blank";
    const t = TEMPLATES[template];
    if (!t) fail("unknown-template", `No template '${template}'`, `templates are: ${Object.entries(TEMPLATES).map(([k, v]) => `${k} (${v.description})`).join("; ")}`, `pass one of: ${Object.keys(TEMPLATES).join(", ")}.${didYouMean(template, Object.keys(TEMPLATES))}`);
    const missing = t.needs.filter((n) => !this.registry.get(n));
    if (missing.length) fail("template-unavailable", `Template '${template}' cannot be used`, `the catalog has no ${missing.join(", ")}`, "use template 'blank' and place parts with search_parts / place_part");
    // Round 5 (decision 0003, C5): a new idea gets its own folder instead of overwriting this one.
    if (args.folder !== undefined && args.folder !== false) return this.newProjectFolder({ ...args, template, folder: args.folder }, ctx);
    if (this.exists && (this.project.parts.length || this.project.wires.length) && !args.overwrite) {
      fail("project-exists", `${this.projectFile} already has ${this.project.parts.length} parts`, "new_project would replace it", `for a new idea pass folder: true to start it in its own project folder (new_project {"folder": true, "name": "${args.name ?? "my device"}"}); pass overwrite: true only to throw this project away`);
    }
    const name = args.name ?? (basename(this.dir) || "project");
    const next = parseProject(t.project(name));
    const files: Record<string, string | null> = { ...t.files };
    this.host?.dispose();
    this.host = undefined;
    this.commit(ctx, `new_project ${template}`, next, files);
    ctx.summary = `new ${template} project '${name}'`;
    return { ok: true, dir: this.dir, id: projectId(this.dir), template, ...this.compactProject() };
  }

  /** new_project {folder}: a fresh folder under projectsRoot, registered, then opened by the host when it can. */
  private async newProjectFolder(args: { template: string; name?: string; folder: true | string }, ctx: OpCtx): Promise<unknown> {
    if (typeof args.folder === "string" && projectSlug(args.folder) === "project" && !/project/i.test(args.folder)) {
      fail("bad-arg", `new_project: folder '${args.folder}' has no usable characters`, "the folder name is made of a-z, 0-9 and dashes from what you pass", 'pass folder: true with a name, or a folder name such as "plant-waterer"');
    }
    const label = typeof args.folder === "string" ? args.folder : (args.name ?? args.template);
    const dir = newProjectFolder(this.projectsRoot, label);
    const name = args.name ?? label;
    this.movePlanningTo(dir); // round 6 power: the plan and searches that led here go into the new project's log
    const child = new ProjectSession({ dir, registry: this.registry, builder: this.builder, actor: this.actor, projectsRoot: this.projectsRoot });
    try {
      await child.call("new_project", { template: args.template, name, ...(ctx.why ? { why: ctx.why } : {}) }, ctx.meta ?? {});
    } finally {
      child.dispose();
    }
    registerProject(dir, { name, source: "agent" });
    const id = projectId(dir);
    ctx.summary = `new ${args.template} project '${name}' in ${dir}`;
    let opened = false;
    let openError: string | undefined;
    if (this.openProject) {
      try {
        await this.openProject(dir);
        opened = true;
      } catch (err) {
        openError = (err as Error).message;
      }
    }
    const viewer = viewerUrlFor(dir);
    return {
      ok: true,
      dir,
      id,
      template: args.template,
      name,
      opened,
      ...(opened && viewer ? { viewer_url: viewer } : {}),
      note: opened
        ? "This is now the open project: every next call (place_part, connect…) works on it, and the canvas shows it."
        : openError
          ? `Created, but the server could not switch to it: ${openError}. Fix: open it from the Projects gallery, or reconnect with --project ${dir}.`
          : `Created and registered, but this connection stays on ${this.dir}. Fix: reconnect the MCP server with --project ${dir} (jumper mcp --project ${dir}), or open it from the Projects gallery of jumper serve.`,
    };
  }

  private compactProject() {
    const p = this.project;
    const wires = p.wires.map((w) => `${w.id}: ${fmtRef(w.from)} -> ${fmtRef(w.to)}`);
    const nets = buildNets(p)
      .filter((n) => n.pins.length > 2)
      .map((n) => n.pins.map(fmtRef).join(" "));
    const used: Record<string, string[]> = {};
    for (const w of p.wires) for (const e of [w.from, w.to]) (used[e.part] ??= []).includes(e.pin) || used[e.part]!.push(e.pin);
    return {
      name: p.name,
      parts: p.parts.map((x) => `${x.id} (${x.type})${x.props && Object.keys(x.props).length ? ` ${JSON.stringify(x.props)}` : ""} @${x.x},${x.y}${x.rotation ? ` r${x.rotation}` : ""}`),
      wires,
      ...(nets.length ? { shared_nets: nets } : {}),
      pins_in_use: Object.fromEntries(Object.entries(used).map(([k, v]) => [k, v.join(" ")])),
      firmware: p.firmware ? { board: p.firmware.board, sketch: p.firmware.sketch ?? null, libraries: p.firmware.libraries ?? [], built: this.firmwareState() } : null,
      files: this.listFirmwareFiles(),
      scenarios: p.scenarios.map((s) => s.id),
      ...(p.world ? { world: Object.keys(p.world) } : {}),
      pending_steps: this.history.steps.filter((s) => s.status === "pending").length,
    };
  }

  /** get_project: compact summary of the whole project. */
  async getProject(): Promise<unknown> {
    const overlaps = overlappingParts(this.project, this.registry);
    return { dir: this.dir, exists: this.exists, ...this.compactProject(), ...(overlaps.length ? { overlapping_parts: overlaps.map((o) => o.join("+")) } : {}) };
  }

  // =================================================================== parts catalog

  async searchParts(args: { query?: string; category?: string }): Promise<unknown> {
    if (args.category && !(PART_CATEGORIES as readonly string[]).includes(args.category)) {
      fail("bad-category", `Unknown category '${args.category}'`, `categories are: ${PART_CATEGORIES.join(", ")}`, "pass one of those or leave category out");
    }
    const base = isProjectPartRegistry(this.registry) ? this.registry.base : this.registry;
    let defs = base === defaultRegistry ? rankParts(this.registry.list(), args.query ?? "") : this.registry.list().filter((d) => !args.query || `${d.spec.id} ${d.spec.name} ${(d.spec.tags ?? []).join(" ")}`.toLowerCase().includes(args.query!.toLowerCase()));
    if (args.category) defs = defs.filter((d) => d.spec.category === args.category);
    // round 6 power: only description mentions ("diode" in an LED's text) is not a fit: say so and hand a create_part template.
    const q = (args.query ?? "").trim();
    if (q && !defs.some((d) => fits(d, q))) {
      const mentioned = defs.slice(0, 5).map((d) => d.spec.id);
      return {
        count: 0,
        results: [],
        hint: `Nothing in the catalog is a '${q}'${args.category ? ` in category ${args.category}` : ""}${mentioned.length ? ` (only mentioned in the descriptions of ${mentioned.join(", ")})` : ""}. Fix: if a close built-in really does the job, search a broader word (e.g. "sensor", "display", "switch") or search_parts with no query to list all ${this.registry.list().length} types; otherwise make it with create_part: fill in create_part_template from the real part's datasheet (pins, voltages, behaviour numbers) and send it as {"part": …}. It is marked "${AGENT_MADE_LABEL}"; tell the person.`,
        create_part_template: createPartTemplate(q, new Set(this.registry.list().map((d) => d.spec.id))),
        ...(mentioned.length ? { mentioned_in: mentioned } : {}),
      };
    }
    const results = defs.slice(0, 25).map((d) => ({ type: d.spec.id, name: d.spec.name, category: d.spec.category, fidelity: d.fidelity.origin === "agent-made" ? AGENT_MADE_LABEL : d.fidelity.level, about: d.spec.description.split(/(?<=\.)\s/)[0] }));
    return {
      count: results.length,
      results,
      ...(results.length === 0
        ? { hint: `nothing matches '${args.query}'. Try a broader word (e.g. "display", "button", "sensor") or search_parts with no query to list all ${this.registry.list().length} types. If the part really is missing, make it with create_part (a declarative part: pins + a behaviour template; it is marked "${AGENT_MADE_LABEL}"), or use a close built-in as a stand-in and say so.` }
        : {}),
    };
  }

  async getPart(args: { type: string }): Promise<unknown> {
    if (!args.type) fail("missing-arg", "get_part needs 'type'", "no part type was given", 'pass a type id from search_parts, e.g. { "type": "led" }');
    // round 6 power: forgiving ids ("rp2040-zero" → waveshare-rp2040-zero).
    let type = args.type;
    let matched: string | undefined;
    if (!this.registry.get(type)) {
      const all = this.registry.list();
      const res = resolvePartType(type, all.map((d) => d.spec.id), all);
      if (res.id) {
        matched = `'${args.type}' is ${res.id}: use that id in place_part`;
        type = res.id;
      } else if (res.candidates.length > 1) {
        fail("ambiguous-part-type", `'${args.type}' matches ${res.candidates.length} part types`, `it fits ${res.candidates.join(", ")}`, `pass one of those ids, e.g. get_part {"type": "${res.candidates[0]}"}`);
      }
    }
    const spec = this.spec(type);
    const def = this.registry.get(type)!;
    const usage = usageFor(spec);
    // Round 6: the wiring for the board this project actually has (a XIAO's SDA is GP6, not the Uno's A4).
    const boardInst = this.project.parts.find((p) => this.registry.get(p.type)?.spec.category === "board");
    const boardSpec = boardInst ? this.registry.get(boardInst.type)?.spec : undefined;
    const onBoard = boardSpec ? boardWiring(spec, boardSpec) : undefined;
    return {
      type: spec.id,
      ...(matched ? { matched } : {}),
      name: spec.name,
      category: spec.category,
      description: spec.description,
      pins: spec.pins.map((p) => {
        const bits: string[] = [p.type];
        if (p.voltage) bits.push(`${p.voltage.min}-${p.voltage.max}V`);
        if (p.protocols?.length) bits.push(p.protocols.join(","));
        return `${p.id}${p.label !== p.id ? ` "${p.label}"` : ""}: ${bits.join(" ")}${p.description ? ` - ${p.description}` : ""}`;
      }),
      props: (spec.props ?? []).map((p) => `${p.id} (${p.type}${p.unit ? `, ${p.unit}` : ""}) default ${JSON.stringify(p.default)}${p.min !== undefined ? ` range ${p.min}..${p.max}` : ""}${p.options ? ` options ${p.options.map((o) => (typeof o === "string" ? o : o.value)).join("|")}` : ""}`),
      ...(spec.bus?.i2c ? { i2c: { addresses: spec.bus.i2c.addresses.map((a) => `0x${a.toString(16).toUpperCase()}`), on_board_pullups: !!spec.bus.i2c.pullUpOhms } } : {}),
      state: (spec.bindings ?? []).map((b) => `${b.key} (${b.type})`).filter((s) => !/Transform|Opacity/.test(s)),
      ...(spec.limits ? { limits: spec.limits } : {}),
      fidelity: { level: def.fidelity.level, gaps: def.fidelity.doesNotEmulate.slice(0, 5), test_on_real_device: def.fidelity.testOnRealDevice.slice(0, 4) },
      wiring: usage.wiring,
      ...(onBoard && boardInst ? { wiring_on_this_board: `${onBoard.text}${onBoard.lines.some((l) => l.note) ? ` ${onBoard.lines.filter((l) => l.note).map((l) => `${l.pin}: ${l.note}`).join("; ")}.` : ""} Use "${boardInst.id}.<pin>" in connect; this overrides any Uno pin names in wiring / example.` } : {}),
      ...(usage.connect ? { typical_connections: usage.connect } : {}),
      ...(usage.libraries ? { libraries: usage.libraries } : {}),
      ...(usage.controls ? { controls: usage.controls } : {}),
      ...(usage.example ? { example: usage.example } : {}),
    };
  }

  // =================================================================== editing

  private nextId(type: string): string {
    const used = new Set([...this.project.parts.map((p) => p.id), ...this.project.wires.map((w) => w.id)]);
    let base = SHORT_IDS[type] ?? type.replace(/[^A-Za-z0-9_]/g, "");
    if (!/^[A-Za-z]/.test(base)) base = `p${base}`;
    // Boards are usually alone: the first one is just "uno" / "nano".
    if (this.registry.get(type)?.spec.category === "board" && !used.has(base)) return base;
    for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
  }

  async placePart(args: { type: string; id?: string; x?: number; y?: number; rotation?: number; props?: Record<string, PropValue>; why?: string }, ctx: OpCtx): Promise<unknown> {
    if (!args.type) fail("missing-arg", "place_part needs 'type'", "no part type was given", 'pass a type from search_parts, e.g. { "type": "led" }');
    const spec = this.spec(args.type);
    const rotation = (args.rotation ?? 0) as Rotation;
    if (![0, 90, 180, 270].includes(rotation)) fail("bad-rotation", `Rotation ${args.rotation} is not allowed`, "parts rotate in quarter turns", "pass 0, 90, 180 or 270");
    let id = args.id ?? this.nextId(spec.id);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) fail("bad-id", `Invalid part id '${id}'`, "ids start with a letter and use only letters, digits, '_' or '-' (no dots: dots separate part and pin)", `use something like '${this.nextId(spec.id)}'`);
    if (this.project.parts.some((p) => p.id === id) || this.project.wires.some((w) => w.id === id)) {
      fail("duplicate-id", `Id '${id}' is already used`, "every part and wire needs a unique id", `pick another id or omit id to get '${this.nextId(spec.id)}'`);
    }
    const props = this.validateProps(spec, args.props ?? {});
    let { x, y } = args;
    if (x === undefined || y === undefined) {
      const spot = autoPlace(this.project, this.registry, spec, rotation);
      x ??= spot.x;
      y ??= spot.y;
    }
    const part: PartInstance = { id, type: spec.id, x: Math.round(x), y: Math.round(y), rotation, ...(Object.keys(props).length ? { props } : {}) };
    let next: Project = { ...this.project, parts: [...this.project.parts, part] };
    if (spec.category === "board" && !next.firmware) next = this.autoFirmware(next, id) ?? next;
    const step = this.commit(ctx, `place_part ${id}`, next);
    ctx.target = { part: id };
    ctx.summary = `placed ${id} (${spec.id}) at ${part.x},${part.y}`;
    const usage = usageFor(spec);
    return {
      id,
      type: spec.id,
      x: part.x,
      y: part.y,
      size: sizeOf(spec, rotation),
      pins: spec.pins.map((p) => p.id).join(" "),
      wiring: usage.wiring,
      ...(usage.connect ? { typical_connections: suggestConnections(this.project, (t) => this.registry.get(t)?.spec, id, (t) => SHORT_IDS[t] ?? t) ?? usage.connect } : {}),
      step: { id: step.id, why: step.why },
    };
  }

  private validateProps(spec: PartSpec, props: Record<string, PropValue>): Record<string, PropValue> {
    const out: Record<string, PropValue> = {};
    for (const [k, v] of Object.entries(props)) {
      const ps = spec.props?.find((p) => p.id === k) ?? (spec.id === "resistor" && k === "ohms" ? spec.props?.find((p) => p.id === "resistance") : undefined);
      if (!ps) {
        const ids = (spec.props ?? []).map((p) => p.id);
        fail("unknown-prop", `${spec.id} has no property '${k}'`, ids.length ? `its properties are: ${ids.join(", ")}` : "it has no properties", ids.length ? `use one of those.${didYouMean(k, ids)}` : "leave props out");
      }
      if (ps.type === "number") {
        const n = typeof v === "number" ? v : parseNumber(String(v));
        if (!Number.isFinite(n)) fail("bad-value", `${spec.id}.${ps.id} must be a number`, `got ${JSON.stringify(v)}`, `pass a number${ps.unit ? ` in ${ps.unit}` : ""}, e.g. ${JSON.stringify(ps.default)} (strings like "10k" also work)`);
        if ((ps.min !== undefined && n < ps.min) || (ps.max !== undefined && n > ps.max)) fail("out-of-range", `${spec.id}.${ps.id} = ${n} is out of range`, `allowed ${ps.min ?? "-∞"}..${ps.max ?? "∞"}${ps.unit ? ` ${ps.unit}` : ""}`, "pass a value inside the range");
        out[ps.id] = n;
      } else if (ps.type === "enum") {
        const opts = (ps.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
        if (!opts.includes(String(v))) fail("bad-value", `${spec.id}.${ps.id} = ${JSON.stringify(v)} is not allowed`, `options are ${opts.join(", ")}`, `pass one of them.${didYouMean(String(v), opts)}`);
        out[ps.id] = String(v);
      } else if (ps.type === "boolean") {
        out[ps.id] = v === true || v === "true" || v === 1 || v === "1";
      } else if (ps.type === "text") {
        // round 7 voice: free text; a DFPlayer's clips are kept as "N: words" lines (a JSON object is accepted)
        const raw = v as unknown;
        if (ps.id === "clips") {
          const { clips, problems } = parseClips(raw);
          if (problems.length) fail("bad-value", `${spec.id}.clips has lines it cannot read`, `${problems.slice(0, 3).join("; ")}: each line must be "N: words" (or "F/N: words" for folder F)`, `pass e.g. "1: hi! I'm Eggy\\n2: whoa, I'm dizzy!" or {"1": "hi! I'm Eggy", "2": "whoa, I'm dizzy!"}`);
          out[ps.id] = formatClips(clips);
        } else out[ps.id] = typeof raw === "object" && raw !== null ? JSON.stringify(raw) : String(raw ?? "");
      } else out[ps.id] = v;
    }
    return out;
  }

  /** A firmware block for a board when the folder already has a sketch (or will get one). */
  private autoFirmware(p: Project, boardId: string, sketch?: string): Project | undefined {
    const board = p.parts.find((x) => x.id === boardId);
    const spec = board ? this.registry.get(board.type)?.spec : undefined;
    if (!spec?.mcu) return undefined;
    const sk = sketch ?? this.listFirmwareFiles().find((f) => /\.(ino|pde)$/.test(f))?.replace(/^firmware\//, "");
    if (!sk) return undefined;
    const base = basename(sk).replace(/\.(ino|pde)$/, "");
    return { ...p, firmware: { board: boardId, dir: "firmware", sketch: sk, artifact: `firmware/${base}.hex`, build: { tool: "arduino-cli", fqbn: spec.mcu.fqbn ?? "arduino:avr:uno" } } };
  }

  async movePart(args: { id: string; x?: number; y?: number; rotation?: number; why?: string }, ctx: OpCtx): Promise<unknown> {
    const part = findPart(this.project, args.id);
    if (args.x === undefined && args.y === undefined && args.rotation === undefined) fail("missing-arg", "move_part needs x/y or rotation", "nothing to change was given", `pass e.g. { "id": "${args.id}", "x": 300, "y": -120 } or { "rotation": 90 }`);
    if (args.rotation !== undefined && ![0, 90, 180, 270].includes(args.rotation)) fail("bad-rotation", `Rotation ${args.rotation} is not allowed`, "parts rotate in quarter turns", "pass 0, 90, 180 or 270");
    const moved: PartInstance = { ...part, x: Math.round(args.x ?? part.x), y: Math.round(args.y ?? part.y), rotation: (args.rotation ?? part.rotation) as Rotation };
    const step = this.commit(ctx, `move_part ${part.id}`, { ...this.project, parts: this.project.parts.map((p) => (p.id === part.id ? moved : p)) });
    ctx.target = { part: part.id };
    ctx.summary = `moved ${part.id} to ${moved.x},${moved.y}${moved.rotation ? ` r${moved.rotation}` : ""}`;
    return { id: part.id, x: moved.x, y: moved.y, rotation: moved.rotation, step: { id: step.id, why: step.why } };
  }

  async remove(args: { id: string; why?: string }, ctx: OpCtx): Promise<unknown> {
    const id = args.id;
    const part = this.project.parts.find((p) => p.id === id);
    const wire = this.project.wires.find((w) => w.id === id);
    const scenario = !part && !wire ? this.project.scenarios.find((s) => s.id === id) : undefined;
    if (scenario) {
      const step = this.commit(ctx, `remove scenario ${id}`, { ...this.project, scenarios: this.project.scenarios.filter((s) => s.id !== id) });
      ctx.summary = `removed test scenario ${id}`;
      return { removed: id, kind: "scenario", step: { id: step.id, why: step.why } };
    }
    if (!part && !wire) {
      const ids = [...this.project.parts.map((p) => p.id), ...this.project.wires.map((w) => w.id), ...this.project.scenarios.map((s) => s.id)];
      fail("unknown-id", `Nothing called '${id}' in the project`, `part, wire and scenario ids are: ${ids.join(", ") || "none"}`, `pass one of them.${didYouMean(id, ids)}`);
    }
    let next: Project;
    let removedWires: string[] = [];
    if (part) {
      removedWires = this.project.wires.filter((w) => w.from.part === id || w.to.part === id).map((w) => w.id);
      next = { ...this.project, parts: this.project.parts.filter((p) => p.id !== id), wires: this.project.wires.filter((w) => !removedWires.includes(w.id)) };
      if (next.firmware?.board === id) delete next.firmware;
    } else {
      next = { ...this.project, wires: this.project.wires.filter((w) => w.id !== id) };
    }
    const step = this.commit(ctx, `remove ${id}`, next);
    ctx.target = part ? { part: id } : { part: wire!.from.part, pin: wire!.from.pin };
    ctx.summary = part ? `removed ${id} and ${removedWires.length} wires` : `removed wire ${id}`;
    return { removed: id, ...(removedWires.length ? { removed_wires: removedWires } : {}), step: { id: step.id, why: step.why } };
  }

  async connect(args: { from: string; to: string; color?: string; why?: string }, ctx: OpCtx): Promise<unknown> {
    if (!args.from || !args.to) fail("missing-arg", "connect needs 'from' and 'to'", "one end is missing", 'pass both as "part.pin", e.g. { "from": "uno.D13", "to": "r1.1" }');
    const a = resolveRef(this.project, this.registry, args.from);
    const b = resolveRef(this.project, this.registry, args.to);
    if (a.ref.part === b.ref.part && a.ref.pin === b.ref.pin) fail("same-pin", `Cannot connect ${fmtRef(a.ref)} to itself`, "both ends are the same pin", "pick two different pins");
    const dup = this.project.wires.find((w) => (same(w.from, a.ref) && same(w.to, b.ref)) || (same(w.from, b.ref) && same(w.to, a.ref)));
    if (dup) return { wire: dup.id, from: fmtRef(dup.from), to: fmtRef(dup.to), note: "already connected; nothing changed" };
    const railA = a.pin.type === "power" && a.spec.category === "board";
    const railB = b.pin.type === "power" && b.spec.category === "board";
    if ((railA && b.pin.type === "ground") || (railB && a.pin.type === "ground")) {
      fail("short-circuit", `Refusing to connect ${fmtRef(a.ref)} to ${fmtRef(b.ref)}`, "that wires a supply rail straight to ground (a short circuit that kills a real USB port or regulator)", "connect the supply to the module's VCC/+ pin and ground to its GND pin instead");
    }
    const color = args.color ?? (a.pin.type === "ground" || b.pin.type === "ground" ? "#2B3038" : a.pin.type === "power" || b.pin.type === "power" ? "#FF4D2E" : WIRE_COLORS[this.project.wires.length % WIRE_COLORS.length]!);
    if (args.color && !/^(#[0-9a-fA-F]{3,8}|[a-z]+)$/.test(args.color)) fail("bad-color", `Wire colour '${args.color}' is not a CSS colour`, "colours are hex (#FF4D2E) or names (red)", 'pass e.g. "#FF4D2E" or leave it out');
    const used = new Set([...this.project.parts.map((p) => p.id), ...this.project.wires.map((w) => w.id)]);
    let n = 1;
    while (used.has(`w${n}`)) n++;
    const wire: Wire = { id: `w${n}`, from: a.ref, to: b.ref, color };
    const next = { ...this.project, wires: [...this.project.wires, wire] };
    const step = this.commit(ctx, `connect ${fmtRef(a.ref)}-${fmtRef(b.ref)}`, next);
    ctx.target = { part: b.ref.part, pin: b.ref.pin };
    ctx.summary = `wired ${fmtRef(a.ref)} → ${fmtRef(b.ref)}`;
    const keys = new Set([fmtRef(a.ref), fmtRef(b.ref)]);
    const mine = checkDesign(next, this.registry, this.firmwareSource(), this.checkOptions()).filter((i) => (i.pins ?? []).some((p) => keys.has(p)));
    const warnings = mine.filter((i) => i.severity !== "info" && !["unpowered", "unconnected-supply", "i2c-unwired", "not-connected"].includes(i.code)).map((i) => i.message);
    const reminders = mine.filter((i) => i.severity === "info" && i.code === "floating-input").map((i) => i.message);
    const resolvedNote = [args.from !== fmtRef(a.ref) ? `${args.from} → ${fmtRef(a.ref)}` : "", args.to !== fmtRef(b.ref) ? `${args.to} → ${fmtRef(b.ref)}` : ""].filter(Boolean);
    return { wire: wire.id, from: fmtRef(a.ref), to: fmtRef(b.ref), ...(resolvedNote.length ? { resolved: resolvedNote } : {}), ...(warnings.length ? { warnings } : {}), ...(reminders.length ? { reminders } : {}), step: { id: step.id, why: step.why } };
  }

  /** Design-check options from the project state (the sketch may still be the starter template). */
  private checkOptions() {
    const src = this.firmwareSource().trim();
    return { templateSketch: !src || TEMPLATE_SOURCES.has(src) };
  }

  async disconnect(args: { wire?: string; from?: string; to?: string; why?: string }, ctx: OpCtx): Promise<unknown> {
    let targets: Wire[] = [];
    if (args.wire) {
      const w = this.project.wires.find((x) => x.id === args.wire);
      if (!w) fail("unknown-wire", `No wire '${args.wire}'`, `wires are: ${this.project.wires.map((x) => x.id).join(", ") || "none"}`, "pass a wire id from get_project, or from + to pins");
      targets = [w];
    } else if (args.from) {
      const a = resolveRef(this.project, this.registry, args.from).ref;
      const b = args.to ? resolveRef(this.project, this.registry, args.to).ref : undefined;
      targets = this.project.wires.filter((w) => (same(w.from, a) && (!b || same(w.to, b))) || (same(w.to, a) && (!b || same(w.from, b))));
      if (!targets.length) fail("not-connected", `No wire ${b ? `between ${fmtRef(a)} and ${fmtRef(b)}` : `on ${fmtRef(a)}`}`, "nothing to disconnect", "check get_project's wires list");
    } else fail("missing-arg", "disconnect needs 'wire' or 'from'", "nothing to disconnect was named", 'pass { "wire": "w3" } or { "from": "uno.D13", "to": "r1.1" }');
    const ids = targets.map((w) => w.id);
    const step = this.commit(ctx, `disconnect ${ids.join(",")}`, { ...this.project, wires: this.project.wires.filter((w) => !ids.includes(w.id)) });
    ctx.target = { part: targets[0]!.from.part, pin: targets[0]!.from.pin };
    ctx.summary = `removed ${ids.join(", ")}`;
    return { removed: ids, step: { id: step.id, why: step.why } };
  }

  async setPartProperty(args: { id: string; prop: string; value: PropValue; why?: string }, ctx: OpCtx): Promise<unknown> {
    const part = findPart(this.project, args.id);
    const spec = specOf(this.registry, part);
    if (args.prop === undefined || args.value === undefined) fail("missing-arg", "set_part_property needs 'prop' and 'value'", "one is missing", `pass e.g. { "id": "${part.id}", "prop": "${spec.props?.[0]?.id ?? "x"}", "value": ${JSON.stringify(spec.props?.[0]?.default ?? 1)} }`);
    const props = this.validateProps(spec, { [args.prop]: args.value });
    const next = { ...this.project, parts: this.project.parts.map((p) => (p.id === part.id ? { ...p, props: { ...p.props, ...props } } : p)) };
    this.liveNote = undefined;
    const step = this.commit(ctx, `set ${part.id}.${args.prop}`, next);
    ctx.target = { part: part.id };
    ctx.summary = `${part.id}.${args.prop} = ${JSON.stringify(Object.values(props)[0])}`;
    const simulation = this.liveNote ?? (this.host ? "unchanged value; the running simulation already uses it" : "no simulation running yet; the next run uses the new value");
    return { id: part.id, props: next.parts.find((p) => p.id === part.id)!.props, simulation, step: { id: step.id, why: step.why } };
  }

  async setLibraries(args: { libraries: string[]; why?: string }, ctx: OpCtx): Promise<unknown> {
    if (!Array.isArray(args.libraries)) fail("missing-arg", "set_libraries needs 'libraries'", "no list was given", 'pass e.g. { "libraries": ["Adafruit SSD1306", "Adafruit GFX Library"] }');
    if (!this.project.firmware) fail("no-firmware", "set_libraries: the project has no firmware yet", "libraries belong to a sketch", 'write the sketch first (write_file "firmware/main.ino") after placing a board');
    const libs = [...new Set(args.libraries.map((l) => String(l).trim()).filter(Boolean))];
    const fw = { ...this.project.firmware, libraries: libs } as NonNullable<Project["firmware"]>;
    if (!libs.length) delete (fw as { libraries?: string[] }).libraries;
    const next: Project = { ...this.project, firmware: fw };
    const step = this.commit(ctx, "set_libraries", next);
    ctx.summary = `libraries: ${libs.join(", ") || "none"}`;
    return { libraries: libs, step: { id: step.id, why: step.why } };
  }

  async setWorld(args: { world: Record<string, unknown> | null; why?: string }, ctx: OpCtx): Promise<unknown> {
    if (args.world === undefined) fail("missing-arg", "set_world needs 'world'", "no world was given", 'pass e.g. { "world": { "arena": { "width": 300, "height": 200 }, "obstacles": [{ "id": "box", "shape": "box", "x": 150, "y": 100, "w": 30, "h": 30 }], "robot": { "start": { "x": 40, "y": 40, "heading": 0 } } } } (null removes it)');
    let next: Project;
    if (args.world === null) {
      next = { ...this.project };
      delete next.world;
    } else {
      if (typeof args.world !== "object" || Array.isArray(args.world)) fail("bad-world", "world must be an object", `got ${JSON.stringify(args.world)}`, "pass { arena, obstacles, robot } or { arm }");
      const { parseWorld } = await import("@jumper/physics");
      try {
        parseWorld(args.world, this.project);
      } catch (err) {
        fail("bad-world", "The world is invalid", (err as Error).message.replace(/\n\s*-\s*/g, "; "), "fix the fields named above (get_part robot-chassis-2wd explains the robot)");
      }
      next = { ...this.project, world: args.world };
    }
    const step = this.commit(ctx, "set_world", next);
    ctx.summary = args.world ? "set the world (arena / robot)" : "removed the world";
    const w = (args.world ?? {}) as Record<string, unknown>;
    const next_: string[] = [];
    if (w.robot || w.arena) {
      next_.push('run: the rover moves with its motors; the result\'s world shows {robot {x, y, heading}, collisions, min_clearance_cm, travelled_cm, sonar_cm}. Test with expect_part "world.<field>": e.g. {"expect_part": "world.collisions", "op": "==", "value": 0} and a real safety margin {"expect_part": "world.min_clearance_cm", "op": ">=", "value": 3} (any gap above 0 counts as no collision, so 0.5 cm is a scrape)');
    }
    if (w.arm) {
      next_.push('run: the joints follow their servos; the result\'s world shows {arm {gripper {x, y}, reached}}. Test with expect_part "world.gripper_x", "world.gripper_y" (cm) and "world.reached" (comma list of target ids the gripper touches, e.g. {"expect_part": "world.reached", "op": "contains", "value": "cup"}); servo angles are "<servo>.angle"');
    }
    return { world: args.world ? Object.keys(args.world) : null, ...(args.world ? { next: next_.join(" | ") || "run, then check the world fields in the run result" } : {}), step: { id: step.id, why: step.why } };
  }

  // =================================================================== files

  private relFirmwarePath(path: string): string {
    if (typeof path !== "string" || !path.trim()) fail("missing-arg", "A file path is needed", "path is empty", 'pass a path under firmware/, e.g. "firmware/main.ino"');
    let p = normalize(path.trim().replace(/^\/+/, "")).split(sep).join("/");
    if (!p.startsWith("firmware/")) p = `firmware/${p}`;
    if (p.split("/").includes("..")) fail("bad-path", `Path '${path}' leaves the firmware folder`, "files can only be written under firmware/", 'use a path like "firmware/main.ino" or "firmware/src/pet.h"');
    return p;
  }

  async writeFile(args: { path: string; content: string; why?: string }, ctx: OpCtx): Promise<unknown> {
    const rel = this.relFirmwarePath(args.path);
    if (typeof args.content !== "string") fail("missing-arg", "write_file needs 'content'", "no text was given", "pass the whole file as a string");
    if (/\.(hex|bin|elf)$/.test(rel)) fail("bad-path", `Refusing to write ${rel}`, "built binaries come from build()", "write source files (.ino/.h/.cpp) and call build");
    const isSketch = /\.(ino|pde)$/.test(rel);
    let next = this.project;
    const notes: string[] = [];
    if (isSketch) {
      if (!next.firmware) {
        const board = next.parts.find((p) => this.registry.get(p.type)?.spec.mcu);
        if (board) {
          next = this.autoFirmware(next, board.id, rel.replace(/^firmware\//, "")) ?? next;
          notes.push(`firmware.sketch set to ${rel}; it runs on ${board.id}`);
        } else notes.push("no board placed yet: place_part arduino-uno and this sketch is picked up automatically");
      } else if (!next.firmware.sketch) {
        next = { ...next, firmware: { ...next.firmware, sketch: rel.replace(/^firmware\//, "") } };
        notes.push(`firmware.sketch set to ${rel}`);
      } else {
        const main = `firmware/${next.firmware.sketch}`;
        if (main !== rel && dirname(main) === dirname(rel)) notes.push(`${rel} sits next to the main sketch ${main}; Arduino merges every .ino in that folder into one program`);
        else if (main !== rel) notes.push(`the main sketch is ${main}; ${rel} is in another folder and is NOT compiled. To make it the main sketch, delete the old one or move this file next to it`);
      }
    }
    const step = this.commit(ctx, `write_file ${rel}`, next, { [rel]: args.content });
    ctx.file = { path: rel, content: args.content.length > 50_000 ? args.content.slice(0, 50_000) : args.content };
    ctx.summary = `wrote ${rel} (${args.content.split("\n").length} lines)`;
    return { path: rel, bytes: Buffer.byteLength(args.content), lines: args.content.split("\n").length, ...(notes.length ? { notes } : {}), next: "build (or run, which builds when sources changed)", step: { id: step.id, why: step.why } };
  }

  async readFile(args: { path: string }): Promise<unknown> {
    const rel = args.path === "jumper.json" ? "jumper.json" : this.relFirmwarePath(args.path);
    const abs = join(this.dir, rel);
    if (!existsSync(abs)) fail("no-file", `No file ${rel}`, `files are: ${this.listFirmwareFiles().join(", ") || "none"}`, "list_files shows what exists; write_file creates one");
    const content = readFileSync(abs, "utf8");
    return { path: rel, content };
  }

  private listFirmwareFiles(): string[] {
    const root = join(this.dir, "firmware");
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const abs = join(d, n);
        if (statSync(abs).isDirectory()) {
          if (n !== "build" && !n.startsWith(".")) walk(abs);
        } else out.push(relative(this.dir, abs).split(sep).join("/"));
      }
    };
    walk(root);
    return out;
  }

  async listFiles(): Promise<unknown> {
    return { files: this.listFirmwareFiles(), main: this.project.firmware?.sketch ? `firmware/${this.project.firmware.sketch}` : null };
  }

  // =================================================================== firmware

  private firmwareInfo() {
    const fw = this.project.firmware;
    if (!fw) return undefined;
    const board = this.project.parts.find((p) => p.id === fw.board);
    const fqbn = fw.build?.fqbn ?? (board ? this.registry.get(board.type)?.spec.mcu?.fqbn : undefined) ?? "arduino:avr:uno";
    const sketchAbs = fw.sketch ? join(this.dir, "firmware", fw.sketch) : undefined;
    return { fw, fqbn, sketchAbs, sketchDir: sketchAbs ? dirname(sketchAbs) : undefined, artifactAbs: join(this.dir, fw.artifact) };
  }

  private firmwareSource(): string {
    const info = this.firmwareInfo();
    if (!info?.sketchDir || !existsSync(info.sketchDir)) return "";
    return readdirSync(info.sketchDir)
      .filter((f) => SOURCE_EXT.test(f))
      .map((f) => readFileSync(join(info.sketchDir!, f), "utf8"))
      .join("\n");
  }

  /**
   * What the firmware is built from: board (fqbn), libraries (sorted: their order never changes the
   * build), the main sketch, and every source file in the sketch folder with line endings made LF
   * (a CRLF checkout or editor is the same sketch). `legacy` is the round 6 formula, so build
   * records written before still count.
   */
  private sourceHash(legacy = false): string | undefined {
    const info = this.firmwareInfo();
    if (!info?.sketchDir || !existsSync(info.sketchDir)) return undefined;
    const h = createHash("sha256");
    const libs = [...(info.fw.libraries ?? [])];
    h.update(`${info.fqbn}|${(legacy ? libs : libs.map((l) => l.trim()).sort()).join(",")}|${info.fw.sketch}\n`);
    for (const f of readdirSync(info.sketchDir).sort()) {
      if (!SOURCE_EXT.test(f)) continue;
      const text = readFileSync(join(info.sketchDir, f), "utf8");
      h.update(`${f}\0${legacy ? text : text.replace(/\r\n?/g, "\n")}\0`);
    }
    return h.digest("hex").slice(0, 16);
  }

  /** "fresh" | "stale" (sources changed since the last build) | "missing" | "none" (no firmware). */
  firmwareState(): "fresh" | "stale" | "missing" | "none" {
    const info = this.firmwareInfo();
    if (!info) return "none";
    if (!existsSync(info.artifactAbs)) return info.sketchAbs ? "missing" : "none";
    const hash = this.sourceHash();
    if (!hash) return "fresh";
    const bf = join(this.metaDir, "build.json");
    if (existsSync(bf)) {
      try {
        const rec = JSON.parse(readFileSync(bf, "utf8")) as { hash: string; artifact?: string };
        if (rec.artifact === undefined || rec.artifact === info.fw.artifact) return rec.hash === hash || rec.hash === this.sourceHash(true) ? "fresh" : "stale";
      } catch {
        // fall through
      }
    }
    // No build record here (a committed example, a copy): the action log may say which sources this
    // very hex was built from.
    const logged = this.loggedSourceOf(info.artifactAbs);
    if (logged) return logged === hash ? "fresh" : "stale";
    // Otherwise compare times; files copied together (opening an example copies the folder) land
    // within a moment of each other, so a source a second newer than the hex is not an edit.
    const hexTime = statSync(info.artifactAbs).mtimeMs;
    const newest = readdirSync(info.sketchDir!).filter((f) => SOURCE_EXT.test(f)).reduce((m, f) => Math.max(m, statSync(join(info.sketchDir!, f)).mtimeMs), 0);
    return newest <= hexTime + 2000 ? "fresh" : "stale";
  }

  /** The source hash the action log recorded for the build that made this hex (newest first), if any. */
  private loggedSourceOf(artifactAbs: string): string | undefined {
    let hexHash: string;
    try {
      hexHash = createHash("sha256").update(readFileSync(artifactAbs, "utf8")).digest("hex");
    } catch {
      return undefined;
    }
    for (const file of [this.actionLogFile, join(this.dir, "agent-actions.jsonl")]) {
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!;
        if (!l.includes(hexHash) || !l.includes('"source"')) continue;
        try {
          const e = JSON.parse(l) as { firmware?: { hash?: string; source?: string } };
          if (e.firmware?.hash === hexHash && e.firmware.source) return e.firmware.source;
        } catch {
          // a torn line
        }
      }
    }
    return undefined;
  }

  /**
   * A copied example ships its built firmware next to its sketch (the repo keeps them in step), so
   * the copy records that build as made from the sources it came with: no false "sketch changed"
   * because copying gave the files new times. Does nothing without both the hex and the sketch.
   */
  adoptShippedBuild(): boolean {
    const info = this.firmwareInfo();
    const hash = this.sourceHash();
    if (!info || !hash || !existsSync(info.artifactAbs)) return false;
    mkdirSync(this.metaDir, { recursive: true });
    writeFileSync(join(this.metaDir, "build.json"), JSON.stringify({ hash, artifact: info.fw.artifact, at: new Date().toISOString(), shipped: true }));
    return true;
  }

  async build(args: { force?: boolean } = {}, ctx?: OpCtx): Promise<unknown> {
    const info = this.firmwareInfo();
    if (!info) {
      const board = this.project.parts.find((p) => this.registry.get(p.type)?.spec.mcu);
      fail("no-firmware", "Nothing to build", board ? "the project has a board but no sketch" : "the project has no board and no sketch", board ? 'write_file("firmware/main.ino", "...") first' : 'place_part "arduino-uno", then write_file("firmware/main.ino", "...")');
    }
    if (!info.sketchAbs || !existsSync(info.sketchAbs)) {
      fail("no-sketch", "Nothing to build", `firmware.sketch is ${info.fw.sketch ? `'${info.fw.sketch}' but that file does not exist` : "not set"}`, 'write the sketch with write_file("firmware/main.ino", "...")');
    }
    const displayPrefix = `${relative(this.dir, info.sketchDir!).split(sep).join("/")}/`;
    const r = await this.builder({
      sketchDir: info.sketchDir!,
      main: basename(info.sketchAbs),
      fqbn: info.fqbn,
      libraries: info.fw.libraries ?? [],
      displayPrefix,
      ...(args.force ? { cache: false } : {}),
    });
    // Hints are written for any project; name this project's real sketch folder.
    for (const d of r.diagnostics ?? []) if (d.hint) d.hint = d.hint.replaceAll("firmware/<sketch folder>/", displayPrefix);
    this.lastBuild = r;
    if (r.ok && r.hex) {
      mkdirSync(dirname(info.artifactAbs), { recursive: true });
      writeFileSync(info.artifactAbs, r.hex);
      mkdirSync(this.metaDir, { recursive: true });
      writeFileSync(join(this.metaDir, "build.json"), JSON.stringify({ hash: this.sourceHash(), artifact: info.fw.artifact, at: new Date().toISOString() }));
      const hexHash = createHash("sha256").update(r.hex).digest("hex");
      try {
        mkdirSync(join(this.metaDir, "builds"), { recursive: true });
        const kept = join(this.metaDir, "builds", `${hexHash}.hex`);
        if (!existsSync(kept)) writeFileSync(kept, r.hex);
      } catch {
        // keeping old builds is a convenience for history; never fail a build over it
      }
      const source = this.sourceHash();
      if (ctx) ctx.firmware = { artifact: info.fw.artifact, hash: hexHash, ...(source ? { source } : {}) };
    }
    if (ctx) ctx.summary = r.ok ? `build ok${r.cached ? " (cached)" : ""}` : `build failed: ${r.errors} errors`;
    const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
    return {
      ok: r.ok,
      ...(r.ok ? { artifact: info.fw.artifact } : {}),
      cached: r.cached,
      ms: r.durationMs,
      ...(r.size ? { size: `flash ${r.size.flash}/${r.size.flashMax} B (${pct(r.size.flash, r.size.flashMax)}), ram ${r.size.ram}/${r.size.ramMax} B (${pct(r.size.ram, r.size.ramMax)})` } : {}),
      ...(r.errors ? { errors: r.diagnostics.filter((d) => d.severity === "error").map(fmtDiag) } : {}),
      ...(r.warnings ? { warnings: r.diagnostics.filter((d) => d.severity === "warning").slice(0, 8).map(fmtDiag) } : {}),
      ...(r.libraries.length ? { libraries: r.libraries } : {}),
      ...(!r.ok && !r.errors ? { log: r.logTail } : {}),
      next: r.ok ? "run (e.g. run 3000 ms) or run_tests" : "fix the errors (read_file shows the code with the reported line) and build again",
    };
  }

  private loadHex(): string | undefined {
    const info = this.firmwareInfo();
    if (!info || !existsSync(info.artifactAbs)) return undefined;
    return readFileSync(info.artifactAbs, "utf8");
  }

  /** Make sure the firmware hex matches the sources; builds when needed. Returns a note when it built. */
  private async ensureBuilt(ctx?: OpCtx): Promise<string | undefined> {
    const st = this.firmwareState();
    if (st === "fresh" || st === "none") return undefined;
    const r = (await this.build({}, ctx)) as { ok: boolean; errors?: string[]; log?: string };
    if (!r.ok) {
      fail("build-failed", "Cannot run: the firmware does not compile", (r.errors ?? [r.log ?? "unknown error"]).slice(0, 5).join(" | "), "fix the errors (build shows file:line and a hint for each), then run again", { errors: r.errors ?? [] });
    }
    return st === "missing" ? "built the firmware first (it had never been built)" : "rebuilt the firmware first (sources changed)";
  }

  // =================================================================== simulation

  private simKey(project: Project = this.project): string {
    return topologyKey(project) + "|" + (this.loadHex() ?? "").length + ":" + createHash("sha1").update(this.loadHex() ?? "").digest("hex").slice(0, 8);
  }

  private async getHost(): Promise<{ host: SimHost; restarted?: string }> {
    await SimHost.preparePhysics(this.project);
    return this.getHostSync();
  }

  private getHostSync(): { host: SimHost; restarted?: string } {
    const key = this.simKey();
    if (this.host && key === this.hostKey) return { host: this.host };
    const had = !!this.host;
    this.host?.dispose();
    this.host = new SimHost(this.project, this.registry, this.loadHex());
    this.hostKey = key;
    if (this.aiMode === "live") {
      try {
        setAiMode(this.host.network, "live");
      } catch {
        this.aiMode = "mock"; // the provider went away; set_ai_mode live says why next time
      }
    }
    return { host: this.host, ...(had ? { restarted: "the circuit or firmware changed, so the simulation restarted at 0 ms" } : {}) };
  }

  async run(args: { ms?: number; duration_ms?: number; speed?: number; reset?: boolean; frames?: boolean }, ctx: OpCtx): Promise<unknown> {
    const ms = Number(args.ms ?? args.duration_ms ?? 1000);
    if (!Number.isFinite(ms) || ms <= 0) fail("bad-arg", `run: duration ${args.ms ?? args.duration_ms} is not valid`, "it must be a positive number of milliseconds", "pass e.g. { \"ms\": 3000 }");
    if (ms > 600_000) fail("bad-arg", `run: ${ms} ms is too long for one call`, "one call is capped at 600000 ms (10 virtual minutes)", "run in several calls, or write a scenario");
    const built = await this.ensureBuilt(ctx);
    const { host, restarted } = await this.getHost();
    const faults = Object.keys(host.faults()).length;
    if (args.reset && !restarted) host.reset();
    const serialFrom = host.serialCursor;
    const t0 = host.timeMs;
    const frames: Frame[] = [];
    const frameMs = Math.max(20, Math.ceil(ms / 400 / 10) * 10);
    const wall0 = Date.now();
    host.run(ms, { frameMs, onFrame: (f) => frames.push(f) });
    const wallMs = Date.now() - wall0;
    ctx.frames = limitColorFrames(frames); // round 6 frames: colour screens, thinned for the log
    const serial = host.serialSince(serialFrom);
    host.serialCursor = host.sim.serialText().length;
    const diags = host.sim.diagnostics();
    const wf = host.worldFields();
    const nearMiss = wf && typeof wf.min_clearance_cm === "number" && wf.min_clearance_cm < 2 && wf.collisions === 0 ? `near miss: the closest gap to a wall or obstacle was ${wf.min_clearance_cm} cm (a real rover scrapes at that distance; sensor noise and wheel slip are not simulated). Fix: turn earlier or slow down, and test a margin with {"expect_part": "world.min_clearance_cm", "op": ">=", "value": 3}` : undefined;
    const notes = [built, restarted, nearMiss, args.reset && faults ? `restarted from 0 ms with the injected faults still active (${JSON.stringify(host.faults())}); inject_fault kind "clear" removes them` : undefined, !host.hasFirmware && this.project.firmware ? "no firmware loaded: only the passive circuit runs" : undefined].filter(Boolean);
    // round 6 switch: plain words, no "ran 3000 ms (now 3000 ms)".
    ctx.summary = runSummary(round(host.timeMs - t0), round(host.timeMs));
    const displays = this.project.parts.filter((p) => typeof host.sim.partState(p.id)?.pixels === "string").map((p) => p.id);
    // round 7 voice: what the device said during this run
    const said = host.sim.speech().filter((u) => u.t_ms >= t0 - 1e-6);
    return {
      ...(said.length ? { said: said.slice(-20).map((u) => `${round(u.t_ms)} ms ${u.partId}: ${JSON.stringify(u.text)}${u.audible ? "" : " (nobody heard it: no speaker wired)"}`) } : {}),
      t_ms: round(host.timeMs),
      ran_ms: round(host.timeMs - t0),
      speed: `${round(ms / Math.max(1, wallMs))}x real time`,
      serial: serial.length > 3000 ? `…${serial.slice(-3000)}` : serial,
      ...(serial.length > 3000 ? { serial_note: `${serial.length} chars printed; showing the last 3000 (read_serial since 0 for all)` } : {}),
      pins: host.pinSummary(),
      parts: host.compactStates(),
      ...(displays.length ? { displays: `${displays.join(", ")}: call read_display to see the screen` } : {}),
      ...(host.worldSummary() ? { world: host.worldSummary() } : {}),
      diagnostics: diags.map((d) => `${d.severity} ${d.partId}${d.code ? ` [${d.code}]` : ""}: ${d.message}`),
      ...(Object.keys(host.faults()).length ? { faults: host.faults() } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  async readSerial(args: { since?: number }): Promise<unknown> {
    const { host } = await this.getHost();
    const text = host.sim.serialText();
    const since = Math.max(0, Math.min(Number(args.since ?? 0), text.length));
    return { t_ms: round(host.timeMs), since, next: text.length, text: text.slice(since) };
  }

  async readPin(args: { pin: string }): Promise<unknown> {
    const r = resolveRef(this.project, this.registry, args.pin);
    const { host } = await this.getHost();
    const info = host.pin(r.ref.part, r.ref.pin);
    const nets = buildNets(this.project);
    const net = nets.find((n) => n.pins.some((p) => p.part === r.ref.part && p.pin === r.ref.pin));
    return { pin: fmtRef(r.ref), t_ms: round(host.timeMs), ...info, connected_to: net ? net.pins.filter((p) => !(p.part === r.ref.part && p.pin === r.ref.pin)).map(fmtRef) : [] };
  }

  async readDisplay(args: { part: string; scale?: number; region?: number[]; save_as?: string }, ctx: OpCtx): Promise<unknown> {
    findPart(this.project, args.part);
    const { host } = await this.getHost();
    const scale = Math.max(1, Math.min(8, Math.round(args.scale ?? 2)));
    const d = host.display(args.part, scale);
    let saved: Record<string, unknown> | undefined;
    if (args.region !== undefined || args.save_as !== undefined) {
      const f = host.displayFrame(args.part);
      const region = clampRegion(f, args.region, `read_display ${args.part}`);
      const rows = regionRows(f, region);
      if (args.save_as !== undefined) {
        const path = saveSnapshot(this.dir, String(args.save_as), { part: args.part, t_ms: round(host.timeMs), region, rows });
        ctx.summary = `saved ${args.part} snapshot '${args.save_as}'`;
        saved = { saved_as: args.save_as, file: relative(this.dir, path), use: `{"expect_display": "${args.part}", "matches": "${args.save_as}", "within_ms": 2000} in a scenario` };
      }
      return { part: args.part, t_ms: round(host.timeMs), width: d.width, height: d.height, lit_pixels: d.lit, region, region_lit: litCount(rows), ...saved, scale: 1, screen: rows.join("\n") };
    }
    return { part: args.part, t_ms: round(host.timeMs), width: d.width, height: d.height, lit_pixels: d.lit, scale, screen: d.ascii, test_it: `{"expect_display": "${args.part}", "region": [x, y, w, h], "lit": {"min": n}} or save this frame with save_as and use "matches"` };
  }

  async interact(args: { part: string; action: string; value?: VisualValue; key?: string; hold_ms?: number }, ctx: OpCtx): Promise<unknown> {
    const part = findPart(this.project, args.part);
    const spec = specOf(this.registry, part);
    const action = args.action;
    if (!["press", "release", "set", "click", "toggle"].includes(action)) fail("bad-action", `interact: unknown action '${action}'`, "actions are press, release, click (press, hold_ms 200 by default, release), toggle and set (with value)", 'pass e.g. { "part": "btn1", "action": "press" }');
    const { host } = await this.getHost();
    const serialFrom = host.sim.serialText().length;
    const holdMs = Math.max(1, Number(args.hold_ms ?? 200));
    if (action === "click") {
      // A finger press lasts ~100-300 ms; a shorter one is missed by loops that redraw a display or delay().
      host.sim.interact(part.id, { kind: "press", ...(args.key ? { key: args.key } : {}) });
      host.run(holdMs);
      host.sim.interact(part.id, { kind: "release", ...(args.key ? { key: args.key } : {}) });
    } else if (action === "toggle") host.sim.interact(part.id, { kind: "press" });
    else {
      if (action === "set" && args.value === undefined) fail("missing-arg", "interact set needs 'value'", "no value was given", `pass e.g. { "part": "${part.id}", "action": "set", "value": 0.5 }`);
      host.sim.interact(part.id, { kind: action as "press" | "release" | "set", ...(args.key ? { key: args.key } : {}), ...(args.value !== undefined ? { value: args.value } : {}) });
    }
    ctx.target = { part: part.id };
    ctx.summary = `${action} ${part.id}`;
    ctx.frames = [host.frame() ?? { vt: round(host.timeMs) }];
    const serial = host.sim.serialText().slice(serialFrom);
    if (action === "click") host.serialCursor = host.sim.serialText().length;
    return { part: part.id, type: spec.id, action, ...(action === "click" ? { held_ms: holdMs } : {}), t_ms: round(host.timeMs), state: compactState(host.sim.partState(part.id) ?? {}), ...(serial ? { serial } : {}), next: action === "press" ? "run a few hundred ms so the firmware sees the press, then release" : "run to let the firmware react" };
  }

  async setSensorValue(args: { part: string; field: string; value: VisualValue }, ctx: OpCtx): Promise<unknown> {
    if (args.field === undefined || args.value === undefined) fail("missing-arg", "set_sensor_value needs 'field' and 'value'", "one is missing", 'pass e.g. { "part": "pot1", "field": "position", "value": 0.75 }');
    findPart(this.project, args.part);
    const { host } = await this.getHost();
    const did = setPartValue(host, this.project, this.registry, args.part, args.field, args.value);
    ctx.target = { part: args.part };
    ctx.summary = did;
    ctx.frames = [host.frame() ?? { vt: round(host.timeMs) }];
    return { set: did, t_ms: round(host.timeMs), state: compactState(host.sim.partState(args.part) ?? {}), note: "simulation-only; the project file is unchanged (use set_part_property to save a value)" };
  }

  async injectFault(args: { part: string; kind: string; amplitude?: number; field?: string }, ctx: OpCtx): Promise<unknown> {
    if (!args.kind) fail("missing-arg", "inject_fault needs 'kind'", "no fault kind given", `pass one of: ${FAULT_KINDS.join(", ")}`);
    const { host } = await this.getHost();
    const did = host.injectFault(args.part, args.kind, { ...(args.amplitude !== undefined ? { amplitude: args.amplitude } : {}), ...(args.field ? { field: args.field } : {}) });
    ctx.target = { part: args.part };
    ctx.summary = did;
    return { fault: did, active: host.faults(), next: "run and watch serial / state: does the firmware notice and recover?" };
  }

  // =================================================================== network / AI

  async setAiMode(args: { mode: string }, ctx: OpCtx): Promise<unknown> {
    const { host } = await this.getHost();
    const r = setAiMode(host.network, String(args.mode));
    this.aiMode = args.mode === "live" ? "live" : "mock";
    ctx.summary = `AI mode ${args.mode}`;
    return r;
  }

  async readNetworkLog(args: { since?: number; limit?: number }): Promise<unknown> {
    const { host } = await this.getHost();
    return { t_ms: round(host.timeMs), ...readNetworkLog(host.network, args) };
  }

  async runLive(args: { ms: number }, ctx: OpCtx): Promise<unknown> {
    const ms = Number(args.ms);
    if (!Number.isFinite(ms) || ms <= 0 || ms > 60_000) fail("bad-arg", `run_live: ms ${args.ms} is not valid`, "run_live runs at real time, so one call is capped at 60000 ms", 'pass e.g. { "ms": 8000 }');
    const built = await this.ensureBuilt(ctx);
    const { host, restarted } = await this.getHost();
    const serialFrom = host.serialCursor;
    const t0 = host.timeMs;
    const r = await runLive(host.network, (slice) => host.run(slice), ms);
    const serial = host.serialSince(serialFrom);
    host.serialCursor = host.sim.serialText().length;
    ctx.summary = `${runSummary(round(host.timeMs - t0), round(host.timeMs))} at real time`; // round 6 switch
    ctx.frames = [host.frame() ?? { vt: round(host.timeMs) }];
    const notes = [built, restarted, this.aiMode === "live" ? undefined : "AI mode is mock, so the mock answered; call set_ai_mode live first for a real model"].filter(Boolean);
    return { t_ms: round(host.timeMs), ran_from_ms: round(t0), ...r, serial: serial.length > 2000 ? `…${serial.slice(-2000)}` : serial, parts: host.compactStates(), ...(notes.length ? { notes } : {}), next: "screenshot to see the screen, read_network_log for the full exchange" };
  }

  // =================================================================== tests

  async writeScenario(args: { id: string; name?: string; description?: string; steps: unknown[]; timeout_ms?: number; why?: string }, ctx: OpCtx): Promise<unknown> {
    if (!args.id || !Array.isArray(args.steps)) fail("missing-arg", "write_scenario needs 'id' and 'steps'", "one is missing", 'pass e.g. { "id": "blinks", "steps": [{ "expect_serial": "LED on", "within_ms": 1100 }] }');
    const normalized: string[] = [];
    const steps = args.steps.map((raw, i) => {
      const n = normalizeScenarioStep(raw);
      if (n.note) normalized.push(`step ${i}: ${n.note}`);
      return n.step;
    });
    const s: Scenario = { id: args.id, ...(args.name ? { name: args.name } : {}), ...(args.description ? { description: args.description } : {}), steps, ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}) } as Scenario;
    validateScenario(s, this.project, this.registry, this.scenarioOptions());
    const exists = this.project.scenarios.some((x) => x.id === s.id);
    const next = { ...this.project, scenarios: exists ? this.project.scenarios.map((x) => (x.id === s.id ? s : x)) : [...this.project.scenarios, s] };
    const step = this.commit(ctx, `write_scenario ${s.id}`, next);
    ctx.summary = `${exists ? "updated" : "added"} scenario ${s.id} (${s.steps.length} steps)`;
    return { scenario: s.id, steps: s.steps.length, replaced: exists, ...(normalized.length ? { normalized } : {}), next: "run_tests", step: { id: step.id, why: step.why } };
  }

  private scenarioOptions() {
    return { snapshot: (name: string) => loadSnapshot(this.dir, name) };
  }

  async runTests(args: { name?: string; images?: boolean }, ctx: OpCtx): Promise<unknown> {
    const all = this.project.scenarios;
    if (!all.length) fail("no-scenarios", "No scenarios to run", "the project has no tests yet", 'add one with write_scenario, e.g. { "id": "boots", "steps": [{ "expect_serial": "ready", "within_ms": 1000 }] }');
    const pick = args.name ? all.filter((s) => s.id === args.name || s.name === args.name) : all;
    if (!pick.length) fail("unknown-scenario", `No scenario '${args.name}'`, `scenarios are: ${all.map((s) => s.id).join(", ")}`, `pass one of them or leave name out to run all.${didYouMean(args.name!, all.map((s) => s.id))}`);
    const built = await this.ensureBuilt(ctx);
    const hex = this.loadHex();
    await SimHost.preparePhysics(this.project);
    const results: ScenarioResult[] = [];
    const visuals: VisualScenario[] = [];
    // Frames of one representative scenario (the longest up to 2 virtual minutes), for live view / replay.
    let frames: Frame[] = [];
    let framesSpan = -1;
    for (const s of pick) {
      const host = new SimHost(this.project, this.registry, hex);
      const mine: Frame[] = [];
      try {
        const { result, visual } = runScenarioVisual(host, s, this.project, this.registry, (f) => mine.push(f), this.scenarioOptions());
        results.push(result);
        visuals.push(visual);
      } catch (err) {
        const je = asJumperError(err);
        results.push({ id: s.id, passed: false, t_ms: round(host.timeMs), failed_step: -1, reason: je.message, serial_tail: "", steps: [] });
        visuals.push({ id: s.id, ...(s.name ? { name: s.name } : {}), passed: false, t_ms: round(host.timeMs), reason: je.message, inputs: [], frames: [], replayable: false });
      } finally {
        host.dispose();
      }
      const span = mine.length ? mine[mine.length - 1]!.vt - mine[0]!.vt : 0;
      if (mine.length && (framesSpan < 0 || (span > framesSpan && span <= 120_000))) {
        frames = downsampleFrames(mine, 400);
        framesSpan = span;
      }
    }
    if (frames.length) ctx.frames = limitColorFrames(frames); // round 6 frames
    const passed = results.filter((r) => r.passed).length;
    ctx.summary = `${passed}/${results.length} scenarios passed`;
    this.lastVisualReport = { format: "jumper-visual-report/1", project: this.project.name, passed, failed: results.length - passed, scenarios: visuals };
    // Kept on disk so the web Tests panel still shows it after `jumper serve` restarts.
    try {
      mkdirSync(this.metaDir, { recursive: true });
      writeFileSync(join(this.metaDir, "visual-report.json"), JSON.stringify(this.lastVisualReport));
    } catch {
      // A read-only project folder: the report stays in memory only.
    }
    const frameImages = args.images ? this.writeFrameImages(visuals) : [];
    const pendingSteps = this.acceptAfterTests(results.length - passed, args.name, ctx);
    return {
      passed,
      failed: results.length - passed,
      ...(built ? { notes: [built] } : {}),
      ...pendingSteps,
      results: results.map((r, i) => {
        const visual = visuals[i] ? compactVisual(visuals[i]) : [];
        const v = visual.length ? { visual } : {};
        return r.passed
          ? { id: r.id, passed: true, t_ms: r.t_ms, ...(r.warnings ? { warnings: r.warnings } : {}), ...v }
          : { id: r.id, passed: false, t_ms: r.t_ms, reason: r.reason, serial_tail: r.serial_tail, ...(r.warnings ? { warnings: r.warnings } : {}), steps: r.steps.map((s) => `${s.ok ? "ok" : "FAIL"} @${s.t_ms}ms ${s.step}${s.detail ? ` - ${s.detail}` : ""}`), ...v };
      }),
      ...(frameImages.length ? { frame_images: frameImages } : {}),
    };
  }

  /**
   * Round 5 (decision 0003, C5): when every test passes (all scenarios, a clean design check), the
   * pending steps are accepted by the tests (accepted_by: "tests"), so replays and the step list do
   * not end with everything "pending". Otherwise the result says why they stay pending.
   */
  private acceptAfterTests(failed: number, only: string | undefined, ctx: OpCtx): Record<string, unknown> {
    const pending = this.history.steps.filter((s) => s.status === "pending");
    if (!pending.length) return {};
    const keep = (why: string) => ({ pending_steps: { count: pending.length, accepted: false, why } });
    if (failed) return keep(`${failed} test${failed > 1 ? "s" : ""} failed, so the ${pending.length} pending step${pending.length > 1 ? "s stay" : " stays"} pending. Fix and run_tests again; they are accepted when every test passes`);
    if (only) return keep(`only '${only}' ran; run_tests without a name accepts the ${pending.length} pending step${pending.length > 1 ? "s" : ""} when every test passes`);
    const errors = checkDesign(this.project, this.registry, this.firmwareSource(), this.checkOptions()).filter((i) => i.severity === "error");
    if (errors.length) return keep(`every test passed, but check_design reports ${errors.length} error${errors.length > 1 ? "s" : ""} (${errors.map((e) => e.code).join(", ")}). Fix them and run_tests again, or accept_step if the person agrees`);
    for (const st of pending) {
      st.status = "accepted";
      (st as Step & { accepted_by?: string }).accepted_by = "tests";
    }
    if (pending.some((st) => st.id === this.history.open)) this.history.open = undefined;
    this.persist();
    ctx.steps = true;
    return { accepted_steps: { ids: pending.map((st) => st.id), by: "tests", note: "every test passed and check_design found no errors, so the pending steps are accepted (undo still works)" } };
  }

  /** PNGs of the screen at each scenario's first failing check (or its last check), for run_tests {images: true}. */
  private writeFrameImages(visuals: VisualScenario[]): string[] {
    const out: string[] = [];
    const dir = join(this.dir, ".jumper", "test-frames");
    for (const v of visuals) {
      const checks = v.frames.filter((f) => f.kind.startsWith("expect") || !f.ok);
      const f = checks.find((c) => !c.ok) ?? checks[checks.length - 1];
      const png = f ? displayPng(f) : undefined;
      if (!f || !png) continue;
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${v.id}-step${f.step}.png`);
      writeFileSync(path, png);
      out.push(path);
      if (out.length >= 4) break;
    }
    return out;
  }

  // =================================================================== checks & reports

  async checkDesign(): Promise<unknown> {
    const issues: DesignIssue[] = checkDesign(this.project, this.registry, this.firmwareSource(), this.checkOptions());
    if (this.host) {
      for (const d of this.host.sim.diagnostics()) {
        if (issues.some((i) => i.code === d.code && i.parts.includes(d.partId))) continue;
        issues.push({ severity: d.severity, code: d.code ?? "sim", message: `${d.partId} (simulated at ${round(this.host.timeMs)} ms): ${d.message}`, parts: [d.partId] });
      }
    }
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warning").length;
    return {
      ok: errors === 0,
      errors,
      warnings,
      issues: issues.map((i) => `${i.severity} [${i.code}] ${i.message}`),
      ...(this.host ? {} : { note: "static checks only; run the simulation first to add live checks (overcurrent, floating inputs)" }),
    };
  }

  async fidelityReport(): Promise<unknown> {
    return fidelityReport(this.project, this.registry, this.host ? Object.keys(this.host.faults()) : []);
  }

  async screenshot(args: { path?: string; scale?: number; svg?: boolean; scenario?: string; at_step?: number; view?: string; ms?: number }, ctx: OpCtx): Promise<unknown> {
    if (args.view !== undefined && args.view !== "canvas" && args.view !== "device") fail("bad-arg", `screenshot: unknown view '${args.view}'`, "views are canvas (the circuit) and device (the physical device in 3D)", 'pass { "view": "device", "ms": 4000 } or leave view out');
    if (args.view === "device") return this.withViewer(await this.deviceScreenshot(args, ctx));
    let host = this.host;
    let scenarioNote: Record<string, unknown> | undefined;
    let tmpHost: SimHost | undefined;
    if (args.at_step !== undefined && !args.scenario) fail("missing-arg", "screenshot at_step needs 'scenario'", "at_step counts steps of a scenario", `pass e.g. { "scenario": "${this.project.scenarios[0]?.id ?? "my-test"}", "at_step": 3 }`);
    if (args.scenario) {
      const sc = this.project.scenarios.find((x) => x.id === args.scenario || x.name === args.scenario);
      const ids = this.project.scenarios.map((x) => x.id);
      if (!sc) fail("unknown-scenario", `screenshot: no scenario '${args.scenario}'`, `scenarios are: ${ids.join(", ") || "none"}`, `pass one of them.${didYouMean(args.scenario, ids)}`);
      const last = sc.steps.length - 1;
      const at = args.at_step ?? last;
      if (!Number.isInteger(at) || at < 0 || at > last) fail("bad-arg", `screenshot: at_step ${args.at_step} is out of range`, `scenario '${sc.id}' has steps 0..${last}`, `pass a step index between 0 and ${last} (or leave at_step out for the end)`);
      await this.ensureBuilt(ctx);
      await SimHost.preparePhysics(this.project);
      tmpHost = new SimHost(this.project, this.registry, this.loadHex());
      const r = runScenario(tmpHost, sc, this.project, this.registry, undefined, { ...this.scenarioOptions(), stopAfter: at });
      host = tmpHost;
      scenarioNote = { scenario: sc.id, at_step: at, step: JSON.stringify(sc.steps[at]), ...(r.passed ? {} : { note: `the scenario failed before step ${at}: ${r.reason}; the picture shows the moment it failed` }) };
    }
    try {
      return this.withViewer({ ...(await this.renderScreenshot(host, args, ctx)), ...scenarioNote });
    } finally {
      tmpHost?.dispose();
    }
  }

  /** Round 5 (C5): pictures carry the live viewer link when Jumper's server runs, so the person can open the real thing. */
  private withViewer(r: Record<string, unknown>): Record<string, unknown> {
    const viewer = viewerUrlFor(this.dir);
    return viewer ? { ...r, viewer_url: viewer } : r;
  }

  private async deviceScreenshot(args: { path?: string; scenario?: string; ms?: number }, ctx: OpCtx): Promise<Record<string, unknown>> {
    if (args.scenario) fail("bad-arg", "screenshot: view device does not take scenario", "the device view renders a fresh simulation at a virtual time", 'pass { "view": "device", "ms": 4000 }, or use the canvas view for a scenario step');
    const ms = Math.round(Number(args.ms ?? (this.host && this.host.timeMs > 0 ? this.host.timeMs : 3000)));
    if (!Number.isFinite(ms) || ms < 0 || ms > 120_000) fail("bad-arg", `screenshot: ms ${args.ms} is out of range`, "the device view simulates from 0 to ms in a browser (max 120000)", 'pass e.g. { "view": "device", "ms": 4000 }');
    // Fail in well under 5 s when Chromium is missing, instead of a 60 s page timeout (persona report, b5).
    const problem = chromiumProblem();
    if (problem) fail("device-render-failed", "screenshot: the device view needs a browser that is not installed", problem, "use the canvas view (leave view out) meanwhile; it works without a browser");
    await this.ensureBuilt(ctx);
    const out = resolve(this.dir, args.path ?? "device.png");
    mkdirSync(dirname(out), { recursive: true });
    const { renderDevice } = await import("./device-render.ts");
    let png: Buffer | undefined;
    try {
      png = (await renderDevice({ dir: this.dir, shots: [ms] }))[0];
    } catch (err) {
      fail("device-render-failed", "screenshot: the device view could not be rendered", (err as Error).message, "use the canvas view (leave view out) meanwhile; the device view needs Playwright Chromium (pnpm --filter @jumper/web exec playwright install chromium)");
    }
    if (!png) fail("device-render-failed", "screenshot: the device view returned no image", "the render page did not produce a frame", "try again with a smaller ms, or use the canvas view");
    writeFileSync(out, png);
    ctx.summary = `device screenshot ${relative(this.dir, out) || out}`;
    return { path: out, format: "png", bytes: png.length, view: "device", t_ms: ms, note: "rendered from a fresh simulation run to t_ms with no inputs (presses made in this session are not replayed)" };
  }

  private async renderScreenshot(host: SimHost | undefined, args: { path?: string; scale?: number; svg?: boolean }, ctx: OpCtx): Promise<Record<string, unknown>> {
    const states = host ? Object.fromEntries(host.sim.partIds().map((id) => [id, host.sim.partState(id) ?? {}])) : {};
    const framebuffers = host ? Object.fromEntries(host.sim.partIds().flatMap((id) => {
      const f = host.sim.framebuffer(id);
      return f ? [[id, f] as const] : [];
    })) : {};
    const world = host?.physics?.snapshot();
    const svg = composeSvg(this.project, this.registry, { states, framebuffers, liveWires: host?.liveWires() ?? [], title: this.project.name, ...(world ? { world } : {}) });
    const out = resolve(this.dir, args.path ?? "screenshot.png");
    mkdirSync(dirname(out), { recursive: true });
    if (args.svg || out.endsWith(".svg")) {
      writeFileSync(out.endsWith(".svg") ? out : out.replace(/\.png$/, ".svg"), svg);
      ctx.summary = `screenshot ${out}`;
      return { path: out.endsWith(".svg") ? out : out.replace(/\.png$/, ".svg"), format: "svg", t_ms: host ? round(host.timeMs) : null };
    }
    const png = await svgToPng(svg, args.scale ?? 1);
    if (!png) {
      const svgPath = out.replace(/\.png$/, ".svg");
      writeFileSync(svgPath, svg);
      return { path: svgPath, format: "svg", note: "Playwright/Chromium is not installed, so the screenshot is an SVG. Install with: pnpm --filter @jumper/web exec playwright install chromium" };
    }
    writeFileSync(out, png);
    ctx.summary = `screenshot ${relative(this.dir, out) || out}`;
    return { path: out, format: "png", bytes: png.length, t_ms: host ? round(host.timeMs) : null, ...(host ? {} : { note: "nothing has run in this session yet, so LEDs and displays show their idle look (and no robot world). Fix: call run first (CLI: jumper screenshot out.png --ms 3000, since each CLI command is a fresh session)" }) };
  }

  async export(args: { dir?: string }, ctx: OpCtx): Promise<unknown> {
    const out = resolve(this.dir, args.dir ?? "export");
    mkdirSync(out, { recursive: true });
    // round 6 power: a soldered (pocket / cased) build gets wire cuts and soldered steps, never breadboard or dupont lines.
    const style = assemblyStyle(this.project, this.registry);
    const cuts = style === "soldered" ? wireCuts(this.project, this.registry) : [];
    const bom = bomMarkdown(this.project, this.registry, style, cuts);
    writeFileSync(join(out, "BOM.md"), bom);
    writeFileSync(join(out, "WIRING.md"), wiringMarkdown(this.project, this.registry));
    const files = ["BOM.md", "WIRING.md"];
    if (style === "soldered") {
      writeFileSync(join(out, "WIRE-CUTS.csv"), wireCutsCsv(cuts, true));
      writeFileSync(join(out, "ASSEMBLY.md"), solderedAssemblyMarkdown(this.project, this.registry, cuts, true));
      files.push("WIRE-CUTS.csv", "ASSEMBLY.md");
    }
    const hex = this.loadHex();
    // rp2040 track: RP2040 boards also get a UF2 for the BOOTSEL drive, and their own flash line.
    const boardType = this.project.parts.find((p) => p.id === this.project.firmware?.board)?.type;
    const boardMcu = boardType ? this.registry.get(boardType)?.spec.mcu : undefined;
    const rp2040 = boardMcu?.backend === "rp2040js";
    if (hex) {
      writeFileSync(join(out, "firmware.hex"), hex);
      files.push("firmware.hex");
      if (rp2040) {
        writeFileSync(join(out, "firmware.uf2"), hexToUf2(hex));
        files.push("firmware.uf2");
      }
    }
    const fid = fidelityReport(this.project, this.registry);
    // Round 5 (C2/C4): stand-ins and agent-made parts are what the simulation trusted least.
    const flagged = this.project.parts.filter((p) => p.standIn || this.registry.get(p.type)?.fidelity.origin === "agent-made");
    const flaggedText = flagged.length
      ? `\n## Stand-ins and agent-made parts (check these first)\n\n${flagged.map((p) => `- [ ] ${p.id}: ${p.standIn ? `the real ${p.standIn} (simulated only as a ${this.registry.get(p.type)?.spec.name ?? p.type})` : `${this.registry.get(p.type)?.spec.name ?? p.type} (agent-made: behavioral, unverified)`}: wire it from its datasheet and re-run the tests' checks by hand`).join("\n")}\n`
      : "";
    writeFileSync(join(out, "TEST-ON-HARDWARE.md"), `# Test these on the real device: ${this.project.name}\n\n${fid.summary}\n\n${fid.testOnRealDevice.map((t) => `- [ ] ${t}`).join("\n")}\n${flaggedText}\n## Simulator limits\n\n${fid.global.map((g) => `- ${g}`).join("\n")}\n`);
    files.push("TEST-ON-HARDWARE.md");
    ctx.summary = `exported to ${out}`;
    return { dir: out, files, assembly: style, bom, ...(flagged.length ? { check_first: flagged.map((p) => (p.standIn ? `${p.id}: STAND-IN for ${p.standIn}` : `${p.id}: agent-made: behavioral, unverified`)) } : {}), ...(hex ? {} : { note: "no firmware.hex: build first to include it" }), flash: !hex ? undefined : rp2040 ? `hold BOOTSEL while plugging the board into USB, then copy ${join(out, "firmware.uf2")} to the RPI-RP2 drive that appears (or: picotool load -x ${join(out, "firmware.uf2")})` : `avrdude -p m328p -c arduino -P <port> -b 115200 -U flash:w:${join(out, "firmware.hex")}:i (or arduino-cli upload)` };
  }

  // =================================================================== steps

  async listSteps(): Promise<unknown> {
    return { steps: this.history.steps.slice(-40).map(stepSummary), can_undo: this.undoable().length > 0, can_redo: this.history.redo.length > 0 };
  }

  private undoable(): Step[] {
    return this.history.steps.filter((s) => s.status === "pending" || s.status === "accepted");
  }

  private currentEntities(keys: string[]): EntityMap {
    const ent = projectEntities(this.project);
    for (const k of keys) if (k.startsWith("file:")) ent[k] = this.readFileOrNull(k.slice(5));
    return ent;
  }

  private applyRevert(ctx: OpCtx, step: Step, direction: "back" | "forward", label: string): { conflicts: string[] } {
    const keys = Object.keys(step.before);
    const cur = this.currentEntities(keys);
    const plan = direction === "back" ? planRevert(cur, step.after, step.before) : planRevert(cur, step.before, step.after);
    const next = applyToProject(this.project, plan.changes);
    const res = safeParseProject(next);
    if (!res.ok) {
      fail("revert-conflict", `${label} step ${step.id} ("${step.why}") is not possible`, `later changes depend on it: ${res.issues.map((i) => i.message).join("; ")}`, "undo or reject the later steps first (list_steps shows them)");
    }
    const oldProject = this.project;
    this.project = res.project;
    for (const [path, content] of Object.entries(fileChanges(plan.changes))) this.writeOrDelete(path, content);
    this.history.open = undefined;
    this.persist();
    ctx.project = true;
    ctx.steps = true;
    if (topologyKey(oldProject) !== topologyKey(this.project)) this.pushPropsOrInvalidate(oldProject);
    return { conflicts: plan.conflicts };
  }

  async undo(_args: unknown, ctx: OpCtx): Promise<unknown> {
    const step = this.undoable().at(-1);
    if (!step) fail("nothing-to-undo", "Nothing to undo", "there are no applied steps", "make a change first");
    const { conflicts } = this.applyRevert(ctx, step, "back", "Undo");
    step.status = "undone";
    this.history.redo.push(step.id);
    this.persist();
    ctx.summary = `undid step ${step.id}: ${step.why}`;
    return { undone: stepSummary(step), ...(conflicts.length ? { kept: conflicts, note: "these were changed again by a later step and were left as they are" } : {}), ...this.compactProject() };
  }

  async redo(_args: unknown, ctx: OpCtx): Promise<unknown> {
    const id = this.history.redo.at(-1);
    const step = this.history.steps.find((s) => s.id === id);
    if (!step) fail("nothing-to-redo", "Nothing to redo", "no step was undone since the last change", "undo something first");
    const { conflicts } = this.applyRevert(ctx, step, "forward", "Redo");
    step.status = isPersonActor(step.actor) ? "accepted" : "pending";
    this.history.redo.pop();
    this.persist();
    ctx.summary = `redid step ${step.id}: ${step.why}`;
    return { redone: stepSummary(step), ...(conflicts.length ? { kept: conflicts } : {}) };
  }

  private findStep(id: unknown): Step {
    const n = Number(id);
    const step = this.history.steps.find((s) => s.id === n);
    if (!step) fail("unknown-step", `No step ${String(id)}`, `steps are: ${this.history.steps.slice(-10).map((s) => `${s.id} (${s.status})`).join(", ") || "none"}`, "list_steps shows them");
    return step;
  }

  async acceptStep(args: { step?: number | "all" }, ctx: OpCtx): Promise<unknown> {
    const targets = args.step === undefined || args.step === "all" ? this.history.steps.filter((s) => s.status === "pending") : [this.findStep(args.step)];
    for (const s of targets) {
      if (s.status !== "pending") fail("bad-step-state", `Step ${s.id} is ${s.status}`, "only pending steps can be accepted", "list_steps shows which are pending");
      s.status = "accepted";
    }
    if (targets.some((s) => s.id === this.history.open)) this.history.open = undefined;
    this.persist();
    ctx.steps = true;
    ctx.summary = `accepted ${targets.map((s) => s.id).join(", ") || "nothing"}`;
    return { accepted: targets.map((s) => s.id) };
  }

  async rejectStep(args: { step: number }, ctx: OpCtx): Promise<unknown> {
    const step = this.findStep(args.step);
    if (step.status === "rejected" || step.status === "undone") fail("bad-step-state", `Step ${step.id} is already ${step.status}`, "it is not applied", "nothing to do");
    const { conflicts } = this.applyRevert(ctx, step, "back", "Reject");
    step.status = "rejected";
    this.persist();
    ctx.summary = `rejected step ${step.id}: ${step.why}`;
    return { rejected: stepSummary(step), ...(conflicts.length ? { kept: conflicts, note: "changed again by later steps, so left as they are" } : {}), ...this.compactProject() };
  }

  /** For live sync/tests: the current part states (full, not compacted). */
  /** Round 7 (voice): what the talking parts said in the simulation (read_speech); starts one at 0 ms when none runs. */
  async speech(): Promise<{ t_ms: number; said: ReturnType<SimHost["sim"]["speech"]> }> {
    const { host } = await this.getHost();
    return { t_ms: round(host.timeMs), said: host.sim.speech() };
  }

  liveStates(): Record<string, Record<string, VisualValue>> | undefined {
    const host = this.host;
    if (!host) return undefined;
    return Object.fromEntries(host.sim.partIds().map((id) => [id, host.sim.partState(id) ?? {}]));
  }

  dispose(): void {
    this.flushPlanning(); // round 6 power
    this.host?.dispose();
    this.host = undefined;
  }
}

/** op name (MCP tool / CLI) → method. */
export const OP_METHODS: Record<string, string> = {
  new_project: "newProject",
  get_project: "getProject",
  search_parts: "searchParts",
  get_part: "getPart",
  place_part: "placePart",
  move_part: "movePart",
  remove: "remove",
  connect: "connect",
  disconnect: "disconnect",
  set_part_property: "setPartProperty",
  set_libraries: "setLibraries",
  set_world: "setWorld",
  write_file: "writeFile",
  read_file: "readFile",
  list_files: "listFiles",
  build: "build",
  run: "run",
  read_serial: "readSerial",
  read_pin: "readPin",
  read_display: "readDisplay",
  interact: "interact",
  set_sensor_value: "setSensorValue",
  inject_fault: "injectFault",
  write_scenario: "writeScenario",
  run_tests: "runTests",
  check_design: "checkDesign",
  fidelity_report: "fidelityReport",
  screenshot: "screenshot",
  export: "export",
  list_steps: "listSteps",
  undo: "undo",
  redo: "redo",
  accept_step: "acceptStep",
  reject_step: "rejectStep",
  set_ai_mode: "setAiMode",
  read_network_log: "readNetworkLog",
  run_live: "runLive",
};

/** Every op name: the built-in ones (OP_METHODS) and the round-5 tool modules (src/tools). */
export function allOpNames(): string[] {
  return [...Object.keys(OP_METHODS), ...Object.keys(EXT_OPS)];
}

/** Round 6 power: calls that plan a device (logged into the project they lead to). */
const PLANNING_OPS = new Set(["plan_device", "search_parts", "get_part"]);

/** Ops whose (compacted) result goes into the action log, for replay captions and the live panel. */
const LOG_RESULT_OPS = new Set(["build", "run_tests", "check_design", "fidelity_report", "read_display", "run", "export", "screenshot"]);

function smallResult(r: unknown): unknown {
  if (!r || typeof r !== "object") return r;
  const o = { ...(r as Record<string, unknown>) };
  delete o.parts;
  delete o.bom;
  const s = JSON.stringify(o);
  return s.length <= 8000 ? o : { truncated: true, keys: Object.keys(o) };
}

/** Keep at most `max` frames, merging dropped ones into the next kept one (states, serial, live). */
export function downsampleFrames(frames: Frame[], max: number): Frame[] {
  if (frames.length <= max) return frames;
  const per = Math.ceil(frames.length / max);
  const out: Frame[] = [];
  for (let i = 0; i < frames.length; i += per) {
    const group = frames.slice(i, i + per);
    const f: Frame = { vt: group[group.length - 1]!.vt };
    const states: NonNullable<Frame["states"]> = {};
    let serial = "";
    let live: string[] | undefined;
    let color: Frame["color"]; // round 6 frames: the latest colour image of each screen in the group
    for (const g of group) {
      if (g.states) for (const [id, st] of Object.entries(g.states)) states[id] = { ...(states[id] ?? {}), ...st };
      if (g.serial) serial += g.serial;
      if (g.live) live = g.live;
      if (g.color) color = { ...color, ...g.color };
    }
    if (Object.keys(states).length) f.states = states;
    if (serial) f.serial = serial;
    if (live) f.live = live;
    if (color) f.color = color;
    out.push(f);
  }
  return out;
}

function same(a: PinRef, b: PinRef): boolean {
  return a.part === b.part && a.pin === b.pin;
}

function parseNumber(s: string): number {
  const m = s.trim().match(/^(-?[\d.]+)\s*([kKmMuµ]?)\s*(?:Ω|ohm|ohms)?$/);
  if (!m) return Number(s);
  const mult: Record<string, number> = { "": 1, k: 1e3, K: 1e3, M: 1e6, m: 1e-3, u: 1e-6, "µ": 1e-6 };
  return Number(m[1]) * (mult[m[2]!] ?? 1);
}

function fmtDiag(d: { file?: string; line?: number; column?: number; message: string; hint?: string }): string {
  return `${d.file ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ""}: ` : ""}${d.message}${d.hint ? ` (fix: ${d.hint})` : ""}`;
}

function trimArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 20_000 ? `${v.slice(0, 20_000)}…` : v;
  }
  return out;
}

export { JumperError };
export type { Json };

// round 6 switch: the `run` summary people read in toasts, captions and the step list.
/** "ran the device for 3 s" from 0 ms, "ran 2 s more (device clock at 5 s)" when it continued. */
export function runSummary(ranMs: number, nowMs: number): string {
  const secs = (ms: number) => {
    const s = ms / 1000;
    const text = s >= 10 || Number.isInteger(s) ? String(Math.round(s * 10) / 10) : s.toFixed(1);
    return `${text} s`;
  };
  return Math.abs(nowMs - ranMs) < 1 ? `ran the device for ${secs(ranMs)}` : `ran ${secs(ranMs)} more (device clock at ${secs(nowMs)})`;
}
