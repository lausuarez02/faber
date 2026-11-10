import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  JumperError,
  ProjectSession,
  composeSvg,
  deviceStill, // round 6 frames
  diskFirmwareFiles,
  jumperHome,
  lastTestsFromLog,
  listRegisteredProjects,
  listVersions,
  newProjectFolder,
  projectId,
  registerProject,
  registryForProjectDir,
  stillKey, // round 6 frames
  svgToPng,
  TEMPLATES,
  versionCount,
  versionDetail,
} from "@jumper/session";
import type { ApiRoute, RouteContext, ServerHook } from "./types.ts";

type Project = ProjectSession["project"];
type PartRegistry = ProjectSession["registry"];

/**
 * Round 5, track "projects" (owner). Decision 0003, C3.
 * Endpoints: GET /api/projects, GET /api/projects/:id, GET /api/projects/:id/thumbnail.png, POST /api/projects, POST /api/projects/:id/open, GET /api/history, GET /api/history/:version, POST /api/history/:version/restore, GET /api/files, GET /api/file, PUT /api/file, POST /api/build.
 * Also GET /api/history/:version/preview.svg: the canvas at that version with the device state of
 * its last run (lit LEDs, screens), drawn by the same composeSvg as screenshot and thumbnails.
 */

export interface ProjectCard {
  /** projectId(dir): 12 hex of sha256(abs dir). */
  id: string;
  name: string;
  dir: string;
  kind: "project" | "example" | "agent-built" | "registered";
  description?: string;
  /** Board part type. */
  board?: string;
  boardName?: string;
  parts: number;
  /** Scenarios in jumper.json (beyond the contract's fields). */
  scenarios?: number;
  /** ISO. */
  updatedAt: string;
  tests?: { passed: number; total: number; at?: string };
  /** URL with ?v=<hash>. */
  thumbnail: string;
  /** Examples: opening copies them. */
  readOnly: boolean;
  /** Versions in its history (beyond the contract's fields; not for examples). */
  versions?: number;
  /** Agent-made part types placed on its canvas (create_part; "agent-made: behavioral, unverified"). */
  agentMade?: number;
}

/** The registry a folder draws with: the active session's, or built-ins plus that folder's parts/. */
function registryOf(dir: string, ctx: RouteContext): PartRegistry {
  const s = ctx.session();
  if (resolve(dir) === resolve(ctx.dir())) return s.registry;
  return existsSync(join(dir, "parts")) ? registryForProjectDir(dir) : s.registry;
}

/** jumper.json plus the agent-made parts' files, so a thumbnail changes when a part's drawing does. */
function drawingKey(dir: string, raw: string): string {
  raw += `\nstill:${stillKey(dir)}`; // round 6 frames: a new run redraws the screens in the thumbnail
  const root = join(dir, "parts");
  if (!existsSync(root)) return raw;
  let extra = "";
  try {
    for (const id of readdirSync(root).sort())
      for (const f of ["part.json", "visual.svg"]) {
        const file = join(root, id, f);
        if (existsSync(file)) extra += `\n${id}/${f}:${readFileSync(file, "utf8")}`;
      }
  } catch {
    // unreadable parts/: the canvas alone decides
  }
  return raw + extra;
}

const err = (what: string, why: string, fix: string) => ({ error: `${what}. Why: ${why}. Fix: ${fix}` });

/** A JumperError ("what: why. Fix: fix") in the server's error shape. */
function opError(e: unknown): { error: string; code?: string } {
  if (e instanceof JumperError) return { error: `${e.what}. Why: ${e.why.replace(/\.$/, "")}. Fix: ${e.fix}`, code: e.code };
  return { error: (e as Error).message };
}

function needToken(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (req.headers["x-jumper-token"] === ctx.token) return true;
  ctx.json(res, 403, err("Missing or wrong x-jumper-token", "changing a project needs the token from GET /api/connect, which only pages served by this Jumper server can read", "open the Jumper app from the jumper serve URL and try again"));
  return false;
}

function host(ctx: RouteContext) {
  if (!ctx.projects) throw new Error("This server has no projects host. Why: startJumperServer did not pass `projects` to the routes. Fix: start it with `jumper serve`.");
  return ctx.projects;
}

async function readBody<T>(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, example: string): Promise<T | undefined> {
  try {
    return await ctx.body<T>(req);
  } catch (e) {
    ctx.json(res, 400, err("The request body is not JSON", (e as Error).message, `send ${example} with content-type application/json`));
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------ cards

function readProject(dir: string): { project?: Project; raw?: string } {
  const file = join(dir, "jumper.json");
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  try {
    // Shape check only (the CLI does not depend on project-format); `jumper check` validates fully.
    const p = JSON.parse(raw) as Project;
    return p && Array.isArray(p.parts) && Array.isArray(p.wires) ? { project: { ...p, scenarios: Array.isArray(p.scenarios) ? p.scenarios : [] }, raw } : { raw };
  } catch {
    return { raw };
  }
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function firstParagraph(md: string): string | undefined {
  for (const block of md.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^[#<|!>`-]/.test(t)) continue;
    return t.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`_]/g, "");
  }
  return undefined;
}

function oneLine(text: string | undefined, max = 140): string | undefined {
  if (!text) return undefined;
  const first = text.split(/(?<=\.)\s/)[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

function hash12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function makeCard(dir: string, kind: ProjectCard["kind"], ctx: RouteContext): ProjectCard {
  const { project, raw } = readProject(dir);
  const registry = registryOf(dir, ctx);
  const boardId = project?.firmware?.board;
  const boardPart = project?.parts.find((p) => p.id === boardId) ?? project?.parts.find((p) => registry.get(p.type)?.spec.category === "board");
  const readme = join(dir, "README.md");
  const description = oneLine(project?.description) ?? (existsSync(readme) ? oneLine(firstParagraph(readFileSync(readme, "utf8"))) : undefined);
  const ownLog = join(dir, ".jumper", "actions.jsonl");
  const agentLog = join(dir, "agent-actions.jsonl");
  const tests = lastTestsFromLog(existsSync(ownLog) ? ownLog : agentLog);
  const updated = Math.max(mtime(join(dir, "jumper.json")), mtime(ownLog));
  const id = projectId(dir);
  const readOnly = kind === "example" || kind === "agent-built";
  const agentMade = new Set((project?.parts ?? []).filter((p) => registry.get(p.type)?.fidelity.origin === "agent-made").map((p) => p.type)).size;
  return {
    id,
    name: project?.name ?? basename(dir),
    dir,
    kind,
    ...(description ? { description } : {}),
    ...(boardPart ? { board: boardPart.type, boardName: registry.get(boardPart.type)?.spec.name ?? boardPart.type } : {}),
    parts: project?.parts.length ?? 0,
    scenarios: project?.scenarios.length ?? 0,
    updatedAt: new Date(updated || Date.now()).toISOString(),
    ...(tests ? { tests } : {}),
    thumbnail: `/api/projects/${id}/thumbnail.png?v=${hash12(drawingKey(dir, raw ?? ""))}`,
    readOnly,
    ...(readOnly ? {} : { versions: versionCount(dir) }),
    ...(agentMade ? { agentMade } : {}),
  };
}

function childProjects(root: string, skip: Set<string> = new Set()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith(".") && !skip.has(n))
    .map((n) => join(root, n))
    .filter((d) => existsSync(join(d, "jumper.json")));
}

interface Listing {
  active: string;
  projects: ProjectCard[];
  examples: ProjectCard[];
}

function isInside(dir: string, root: string): boolean {
  const r = relative(resolve(root), resolve(dir));
  return !!r && !r.startsWith("..") && !r.includes(sep);
}

function listing(ctx: RouteContext): Listing {
  const h = host(ctx);
  const active = resolve(ctx.dir());
  const seen = new Set<string>();
  const examples = childProjects(h.examplesRoot, new Set(["agent-built"])).map((d) => {
    seen.add(resolve(d));
    return makeCard(d, "example", ctx);
  });
  // Blink first (the one to start with), then by name.
  examples.sort((a, b) => (basename(a.dir) === "blink" ? -1 : basename(b.dir) === "blink" ? 1 : a.name.localeCompare(b.name)));
  const agentBuilt = childProjects(join(h.examplesRoot, "agent-built")).map((d) => {
    seen.add(resolve(d));
    return makeCard(d, "agent-built", ctx);
  });
  agentBuilt.sort((a, b) => a.name.localeCompare(b.name));
  const projects: ProjectCard[] = [];
  const add = (d: string, kind: ProjectCard["kind"]) => {
    const abs = resolve(d);
    if (seen.has(abs)) return;
    seen.add(abs);
    projects.push(makeCard(abs, kind, ctx));
  };
  add(active, isInside(active, h.root) ? "project" : "registered");
  for (const d of childProjects(h.root)) add(d, "project");
  for (const r of listRegisteredProjects()) if (existsSync(join(r.dir, "jumper.json"))) add(r.dir, isInside(r.dir, h.root) ? "project" : "registered");
  projects.sort((a, b) => (a.dir === active ? -1 : b.dir === active ? 1 : b.updatedAt.localeCompare(a.updatedAt)));
  return { active: projectId(active), projects, examples: [...examples, ...agentBuilt] };
}

function findCard(ctx: RouteContext, id: string): ProjectCard | undefined {
  const l = listing(ctx);
  return [...l.projects, ...l.examples].find((c) => c.id === id);
}

function noProject(id: string) {
  return err(`No project with id '${id}'`, "it is not in the projects folder, examples/ or the registry ($JUMPER_HOME/projects.json), or its folder was moved", "reload the Projects view (GET /api/projects) and use one of its ids");
}

// ------------------------------------------------------------------------------------ thumbnails

const rendering = new Map<string, Promise<Buffer | undefined>>();
let chain: Promise<unknown> = Promise.resolve();

/** One render at a time (each launches a headless Chromium); the same file is rendered once. */
function renderThumb(file: string, dir: string, project: Project, ctx: RouteContext): Promise<Buffer | undefined> {
  const running = rendering.get(file);
  if (running) return running;
  const p = chain.then(
    async () => {
      const svg = await thumbSvg(dir, project, ctx); // round 6 frames: lit screens, colour TFTs
      const w = Number(svg.match(/width="(\d+(?:\.\d+)?)"/)?.[1] ?? 1200);
      const png = await svgToPng(svg, Math.min(1, 640 / w));
      if (png) {
        try {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, png);
        } catch {
          // a read-only folder: the PNG is still served, just not cached
        }
      }
      return png;
    },
    () => undefined,
  );
  chain = p.catch(() => {});
  rendering.set(file, p);
  void p.finally(() => rendering.delete(file)).catch(() => {});
  return p;
}

/** Round 6 frames: the canvas with the device as it last ran (or its built firmware run for 2 s). */
async function thumbSvg(dir: string, project: Project, ctx: RouteContext): Promise<string> {
  const registry = registryOf(dir, ctx);
  const still = await deviceStill(dir, project, registry);
  return composeSvg(project, registry, still ? { states: still.states, liveWires: still.live, ...(still.color ? { color: still.color } : {}) } : {});
}

async function thumbnail(res: ServerResponse, ctx: RouteContext, id: string): Promise<void> {
  const card = findCard(ctx, id);
  if (!card) return ctx.json(res, 404, noProject(id));
  const { project, raw } = readProject(card.dir);
  if (!project || !raw) return ctx.json(res, 404, err(`No canvas to draw for ${card.name}`, `${join(card.dir, "jumper.json")} is missing or invalid`, `run \`jumper check -p ${card.dir}\``));
  const hash = createHash("sha256").update(drawingKey(card.dir, raw)).digest("hex").slice(0, 16);
  // Examples are read-only (C3): their thumbnails are cached under $JUMPER_HOME.
  const file = card.readOnly ? join(jumperHome(), "thumbs", `${id}-${hash}.png`) : join(card.dir, ".jumper", "thumbs", `${hash}.png`);
  const headers = { "cache-control": "max-age=31536000, immutable" };
  if (existsSync(file)) {
    res.writeHead(200, { "content-type": "image/png", ...headers });
    res.end(readFileSync(file));
    return;
  }
  const png = await renderThumb(file, card.dir, project, ctx);
  if (png) {
    res.writeHead(200, { "content-type": "image/png", ...headers });
    res.end(png);
    return;
  }
  // No Chromium for Playwright: the same drawing as SVG (an <img> shows it all the same), not cached.
  res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store", "x-jumper-note": "PNG needs Playwright's Chromium (pnpm exec playwright install chromium); served SVG instead" });
  res.end(await thumbSvg(card.dir, project, ctx)); // round 6 frames
}

// -------------------------------------------------------------------------------- create / open

const COPY_SKIP_DIRS = new Set([".jumper", "media", "shots", "export", "node_modules", ".git"]);
const COPY_SKIP_EXT = /\.(mp4|webm|mov|gif)$/i;

/** Copy an example into a new project folder; an agent-built example's log becomes the copy's history. */
function copyExample(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (!rel) return true;
      if (COPY_SKIP_DIRS.has(rel.split(sep)[0]!)) return false;
      return !COPY_SKIP_EXT.test(src);
    },
  });
  const agentLog = join(from, "agent-actions.jsonl");
  if (existsSync(agentLog)) {
    mkdirSync(join(to, ".jumper"), { recursive: true });
    cpSync(agentLog, join(to, ".jumper", "actions.jsonl"));
  }
}

async function createProject(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  if (!needToken(req, res, ctx)) return;
  const h = host(ctx);
  const body = await readBody<{ name?: unknown; template?: unknown; from?: unknown }>(req, res, ctx, '{"name": "My device"}');
  if (!body) return;
  const template = typeof body.template === "string" ? body.template : undefined;
  if (template && !TEMPLATES[template]) return ctx.json(res, 400, err(`No template '${template}'`, `templates are ${Object.keys(TEMPLATES).join(", ")}`, "pass one of those, or leave template out for a blank project"));
  let source: ProjectCard | undefined;
  if (body.from !== undefined) {
    if (typeof body.from !== "string") return ctx.json(res, 400, err("'from' must be an example id", `got ${JSON.stringify(body.from)}`, "pass the id of a card in GET /api/projects examples"));
    source = findCard(ctx, body.from);
    if (!source) return ctx.json(res, 404, noProject(body.from));
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : (source?.name ?? "Untitled device");
  let dir: string;
  try {
    mkdirSync(h.root, { recursive: true });
    dir = newProjectFolder(h.root, name);
  } catch (e) {
    return ctx.json(res, 500, err(`Could not create a folder for '${name}' in ${h.root}`, (e as Error).message, "check that the folder is writable, or start jumper serve with --project in a writable place"));
  }
  try {
    if (source) {
      copyExample(source.dir, dir);
      // The copy is its own project with the chosen name.
      const file = join(dir, "jumper.json");
      const data = JSON.parse(readFileSync(file, "utf8")) as { name?: string };
      if (data.name !== name) writeFileSync(file, JSON.stringify({ ...data, name }, null, 2) + "\n");
    } else {
      // The same path an agent's new_project takes, so the first version is in the log.
      const s = new ProjectSession({ dir, actor: "web" });
      try {
        await s.call("new_project", { template: template ?? "blank", name, why: "new project from the Projects view" }, { actor: "web" });
      } finally {
        s.dispose();
      }
    }
  } catch (e) {
    return ctx.json(res, 500, { ...opError(e), dir });
  }
  registerProject(dir, { name, source: "web" });
  await h.open(dir);
  return ctx.json(res, 200, { id: projectId(dir), dir });
}

async function openProject(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, id: string): Promise<void> {
  if (!needToken(req, res, ctx)) return;
  const card = findCard(ctx, id);
  if (!card) return ctx.json(res, 404, noProject(id));
  if (card.readOnly) return ctx.json(res, 409, err(`${card.name} is an example`, "examples are read-only so the repo copy never gets overwritten", `copy it with POST /api/projects {"from": "${card.id}"} (the Projects view does this when you open an example)`));
  registerProject(card.dir, { name: card.name, source: "web" });
  await host(ctx).open(card.dir);
  return ctx.json(res, 200, { id: card.id, dir: card.dir });
}

// --------------------------------------------------------------------------------------- history

function parseVersion(res: ServerResponse, ctx: RouteContext, raw: string): number | undefined {
  const n = Number(raw);
  const count = versionCount(ctx.dir());
  if (Number.isInteger(n) && n >= 1 && n <= count) return n;
  ctx.json(res, 404, err(`No version ${raw}`, count ? `this project has versions 1 to ${count}` : "this project has no recorded changes yet", count ? "pick one from GET /api/history" : "make a change (place a part, write a file); every change becomes a version"));
  return undefined;
}

// ----------------------------------------------------------------------------------------- files

function safeRel(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.trim()) return undefined;
  const p = path.trim().replace(/^\/+/, "").split(/[\\/]+/).join("/");
  const rel = p.startsWith("firmware/") ? p : `firmware/${p}`;
  if (rel.split("/").some((s) => s === ".." || s === "")) return undefined;
  return rel;
}

interface Diagnostic {
  severity: "error" | "warning" | "note";
  file?: string;
  line?: number;
  column?: number;
  message: string;
  hint?: string;
}

/** "firmware/blink/blink.ino:5:3: expected ';' (fix: add it)" → a diagnostic, when the raw list is not at hand. */
export function parseDiag(text: string, severity: "error" | "warning"): Diagnostic {
  const m = /^(?<file>[^:\s][^:]*):(?<line>\d+)(?::(?<col>\d+))?: (?<msg>.*?)(?: \(fix: (?<hint>.*)\))?$/.exec(text);
  if (!m?.groups) return { severity, message: text };
  return { severity, file: m.groups.file!, line: Number(m.groups.line), ...(m.groups.col ? { column: Number(m.groups.col) } : {}), message: m.groups.msg!, ...(m.groups.hint ? { hint: m.groups.hint } : {}) };
}

async function build(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  if (!needToken(req, res, ctx)) return;
  const body = await readBody<{ run?: unknown; ms?: unknown }>(req, res, ctx, '{"run": true}');
  if (!body) return;
  let result: { ok: boolean; errors?: string[]; warnings?: string[]; log?: string; artifact?: string; size?: string; cached?: boolean };
  try {
    result = (await ctx.call("build", {}, { actor: "web" })) as typeof result;
  } catch (e) {
    return ctx.json(res, 400, { ok: false, diagnostics: [], ...opError(e) });
  }
  // The session keeps the builder's structured diagnostics (file / line / column / hint) from this build.
  const last = (ctx.session() as unknown as { lastBuild?: { diagnostics?: Diagnostic[] } }).lastBuild;
  const diagnostics = last?.diagnostics
    ? last.diagnostics.filter((d) => d.severity !== "note")
    : [...(result.errors ?? []).map((t) => parseDiag(t, "error")), ...(result.warnings ?? []).map((t) => parseDiag(t, "warning"))];
  const artifact = result.ok && result.artifact ? join(ctx.dir(), result.artifact) : undefined;
  const hex = artifact && existsSync(artifact) ? readFileSync(artifact, "utf8") : undefined;
  const hash = hex ? createHash("sha256").update(hex).digest("hex") : undefined;
  let run: unknown;
  if (result.ok && body.run) {
    try {
      const ms = typeof body.ms === "number" && body.ms > 0 ? Math.min(body.ms, 20_000) : 3000;
      run = await ctx.call("run", { ms, reset: true }, { actor: "web" });
    } catch (e) {
      run = opError(e);
    }
  }
  return ctx.json(res, 200, {
    ok: result.ok,
    diagnostics,
    ...(hash ? { hash, hex } : {}),
    ...(result.size ? { size: result.size } : {}),
    ...(result.cached !== undefined ? { cached: result.cached } : {}),
    ...(!result.ok && !diagnostics.length && result.log ? { log: result.log } : {}),
    ...(run ? { run } : {}),
  });
}

// ---------------------------------------------------------------------------------------- routes

const ID = "(?<id>[0-9a-f]{12})";

export const projectsRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/projects",
    label: "GET /api/projects",
    handle: (_req, res, ctx) => ctx.json(res, 200, listing(ctx)),
  },
  {
    method: "POST",
    path: "/api/projects",
    label: "POST /api/projects",
    handle: (req, res, ctx) => createProject(req, res, ctx),
  },
  {
    method: "GET",
    path: new RegExp(`^/api/projects/${ID}$`),
    label: "GET /api/projects/:id",
    handle: (_req, res, ctx, { id }) => {
      const card = findCard(ctx, id!);
      if (!card) return ctx.json(res, 404, noProject(id!));
      const { project } = readProject(card.dir);
      if (!project) return ctx.json(res, 422, err(`${card.name} cannot be read`, `${join(card.dir, "jumper.json")} is missing or invalid`, `run \`jumper check -p ${card.dir}\` to see what is wrong`));
      return ctx.json(res, 200, { card, project, files: diskFirmwareFiles(card.dir) });
    },
  },
  {
    method: "GET",
    path: new RegExp(`^/api/projects/${ID}/thumbnail\\.png$`),
    label: "GET /api/projects/:id/thumbnail.png",
    handle: (_req, res, ctx, { id }) => thumbnail(res, ctx, id!),
  },
  {
    method: "POST",
    path: new RegExp(`^/api/projects/${ID}/open$`),
    label: "POST /api/projects/:id/open",
    handle: (req, res, ctx, { id }) => openProject(req, res, ctx, id!),
  },
  {
    method: "GET",
    path: "/api/history",
    label: "GET /api/history",
    handle: (_req, res, ctx) => ctx.json(res, 200, { id: projectId(ctx.dir()), dir: ctx.dir(), versions: listVersions(ctx.dir()) }),
  },
  {
    method: "GET",
    path: /^\/api\/history\/(?<version>\d+)$/,
    label: "GET /api/history/:version",
    handle: (_req, res, ctx, { version }) => {
      const n = parseVersion(res, ctx, version!);
      if (n === undefined) return;
      const d = versionDetail(ctx.dir(), n)!;
      return ctx.json(res, 200, {
        version: d.version,
        summary: d.summary,
        project: d.project,
        files: d.files,
        ...(d.approxFiles.length ? { approxFiles: d.approxFiles } : {}),
        ...(d.firmware ? { firmware: d.firmware } : {}),
        ...(d.frame ? { frame: { t_ms: d.frame.t_ms, parts: d.frame.parts, ...(d.frame.color ? { color: d.frame.color } : {}) } } : {}),
        changes: d.changes,
      });
    },
  },
  {
    method: "GET",
    path: /^\/api\/history\/(?<version>\d+)\/preview\.svg$/,
    label: "GET /api/history/:version/preview.svg",
    handle: (_req, res, ctx, { version }) => {
      const n = parseVersion(res, ctx, version!);
      if (n === undefined) return;
      const d = versionDetail(ctx.dir(), n)!;
      const highlight = [...d.changes.added, ...d.changes.changed].filter((k) => k.startsWith("part:")).map((k) => k.slice(5));
      const svg = composeSvg(d.project, ctx.session().registry, { ...(d.frame ? { states: d.frame.parts, liveWires: d.frame.live ?? [], ...(d.frame.color ? { color: d.frame.color } : {}) } : {}), highlight }); // round 6 frames: colour
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      res.end(svg);
    },
  },
  {
    method: "POST",
    path: /^\/api\/history\/(?<version>\d+)\/restore$/,
    label: "POST /api/history/:version/restore",
    handle: async (req, res, ctx, { version }) => {
      if (!needToken(req, res, ctx)) return;
      const body = await readBody<{ why?: unknown }>(req, res, ctx, '{"why": "back to the working version"}');
      if (!body) return;
      try {
        const r = await ctx.call("restore_version", { version: Number(version), ...(typeof body.why === "string" && body.why ? { why: body.why } : {}) }, { actor: "web" });
        return ctx.json(res, 200, r);
      } catch (e) {
        return ctx.json(res, e instanceof JumperError && e.code === "unknown-version" ? 404 : 400, opError(e));
      }
    },
  },
  {
    method: "GET",
    path: "/api/files",
    label: "GET /api/files",
    handle: (_req, res, ctx) => {
      const dir = ctx.dir();
      const fw = ctx.session().project.firmware;
      return ctx.json(res, 200, {
        files: diskFirmwareFiles(dir).map((path) => ({ path, size: statSync(join(dir, path)).size })),
        main: fw?.sketch ? `firmware/${fw.sketch}` : null,
      });
    },
  },
  {
    method: "GET",
    path: "/api/file",
    label: "GET /api/file?path=",
    handle: (req, res, ctx) => {
      const raw = new URL(req.url ?? "/", "http://x").searchParams.get("path");
      const rel = safeRel(raw);
      if (!rel) return ctx.json(res, 400, err(`Bad file path '${raw ?? ""}'`, "files are read from the project's firmware/ folder only", "pass ?path=firmware/<sketch>/<file>.ino (GET /api/files lists them)"));
      const abs = join(ctx.dir(), rel);
      if (!existsSync(abs) || statSync(abs).isDirectory()) return ctx.json(res, 404, err(`No file ${rel}`, `the files are: ${diskFirmwareFiles(ctx.dir()).join(", ") || "none"}`, "pick one from GET /api/files, or create it with PUT /api/file"));
      return ctx.json(res, 200, { path: rel, content: readFileSync(abs, "utf8") });
    },
  },
  {
    method: "PUT",
    path: "/api/file",
    label: "PUT /api/file",
    handle: async (req, res, ctx) => {
      if (!needToken(req, res, ctx)) return;
      const body = await readBody<{ path?: unknown; content?: unknown; why?: unknown }>(req, res, ctx, '{"path": "firmware/main/main.ino", "content": "…"}');
      if (!body) return;
      if (typeof body.content !== "string") return ctx.json(res, 400, err("No content to save", "'content' must be the whole file as a string", 'send {"path": "…", "content": "…"}'));
      try {
        const r = await ctx.call("write_file", { path: body.path, content: body.content, why: typeof body.why === "string" && body.why ? body.why : "edited in the code editor" }, { actor: "web" });
        return ctx.json(res, 200, r);
      } catch (e) {
        return ctx.json(res, 400, opError(e));
      }
    },
  },
  {
    method: "POST",
    path: "/api/build",
    label: "POST /api/build",
    handle: (req, res, ctx) => build(req, res, ctx),
  },
];

/**
 * A `{type: "version"}` live event after every change made through this server (decision 0003,
 * C6). Changes other processes make arrive as plain `action` events; the web app refetches on both.
 */
const versionEvents: ServerHook = (ctx) => {
  let count = 0;
  let off = () => {};
  const attach = (s: ProjectSession) => {
    off();
    count = versionCount(s.dir);
    off = s.onEvent(({ entry }) => {
      if (!entry.ok || !(entry.project || entry.file)) return;
      count += 1;
      ctx.hub.broadcast({ type: "version", version: count, at: entry.t, actor: entry.actor, ...(entry.step?.why ? { why: entry.step.why } : {}) });
    });
  };
  attach(ctx.session());
  const offSwap = ctx.projects?.onSessionChange(attach) ?? (() => {});
  return () => {
    off();
    offSwap();
  };
};

/** Started with the server, stopped on close. */
export const projectsHooks: ServerHook[] = [versionEvents];
