import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, normalize, relative, resolve, sep } from "node:path";
import { adviceNotes, assemblyPlanFor, caseIsStale, caseMesh, deviceCase, draftCosts, layoutProposals, opsForApply, previewFit } from "@faber/session";
import type { ApiRoute, RouteContext, ServerHook } from "./types.ts";
import { projectFilePath } from "@faber/project-format/node";

/**
 * Round 6, track "case" (owner). Decision 0004, R6.
 *   GET  /api/case                 → { enclosure | null, report?, stale, variants }
 *   POST /api/case                 → CaseReport (design_case when there is no case, else update_case; actor web)
 *   POST /api/case/fit             → round 7: check_fit for a draft (shape, outline, size_mm, params, placements) with the
 *                                    front-view preview; no CAD, nothing written or logged (the Case view's live preview)
 *   POST /api/case/layouts         → round 8: propose_layout for a draft (or the saved case): thinnest / smallest /
 *                                    balanced, each with front and side views (outline + part rectangles per layer)
 *   POST /api/case/costs           → round 8b: what each choice in a draft (or the saved case) costs: pins, faces, dome,
 *                                    edges, a fixed size, wall; { base, costs: [{say, label, change, ...}], relax_all }
 *   GET  /api/case/advice          → round 8: { notes } "parts you may not need" in a person's words, with the mm they save
 *   POST /api/case/advice/apply    → round 8: { id } makes a note's simple change (swap / removal) with the agent ops
 *                                    (remove, place_part, connect) as one undoable step; { applied, result, notes }
 *   POST /api/case/assembly        → round 12: how to build it: { buy, print, consumables, tools, steps (each with its
 *                                    picture as image_url), mounts, checks, problems }; regenerates a stale case first
 *   GET  /api/case/mesh            → CaseMesh (positions / indices base64, case frame, explode per body)
 *   GET  /api/device/case          → the built case for the Device view: { case: null } or { case: { mesh, openings,
 *                                    stale, stale_reason, color, size_mm } }; never rebuilds case/ (a stale case comes as built)
 *   GET  /api/case/file?path=      → a file from <project>/case/ (download)
 *   POST /api/manufacturing        → export_manufacturing + url of the zip
 *   GET  /api/manufacturing/:file  → a zip from <project>/manufacturing/
 * Local-only like every route; changing routes need x-faber-token. Errors: { error: "<what>. Why: … Fix: …" }.
 */

const err = (what: string, why: string, fix: string) => ({ error: `${what}. Why: ${why}. Fix: ${fix}` });

function needToken(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (req.headers["x-faber-token"] === ctx.token) return true;
  ctx.json(res, 403, err("Missing or wrong x-faber-token", "changing the case needs the token from GET /api/connect, which only pages served by this Faber server can read", "open the Faber app from the faber serve URL and try again"));
  return false;
}

function cors(req: IncomingMessage): Record<string, string> {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  return origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
}

const TYPES: Record<string, string> = { stl: "model/stl", "3mf": "model/3mf", step: "model/step", png: "image/png", svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", md: "text/markdown; charset=utf-8", zip: "application/zip" };

function sendFile(res: ServerResponse, file: string, download: boolean): void {
  const ext = file.split(".").pop()!.toLowerCase();
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store", ...(download ? { "content-disposition": `attachment; filename="${basename(file)}"` } : {}) });
  res.end(readFileSync(file));
}

/** path inside root (no .., no absolute) or undefined */
function inside(root: string, p: string): string | undefined {
  if (!p || p.includes("\0")) return undefined;
  const abs = resolve(root, normalize(p));
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..") || resolve(root, rel) !== abs) return undefined;
  return abs;
}

/** Round 6 (lead): the shapes made with design_case {save: false}, from case/variants/<shape>/report.json. */
function variantsOf(dir: string): { shape: string; size_mm: unknown; pocket: unknown; ok: unknown; files: string[] }[] {
  const root = join(dir, "case", "variants");
  if (!existsSync(root)) return [];
  const out: { shape: string; size_mm: unknown; pocket: unknown; ok: unknown; files: string[] }[] = [];
  for (const name of readdirSync(root).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(root, name, "report.json"), "utf8")) as { shape?: string; size_mm?: unknown; pocket?: unknown; ok?: unknown; files?: (string | { path: string })[] };
      out.push({ shape: r.shape ?? name, size_mm: r.size_mm, pocket: r.pocket, ok: r.ok, files: (r.files ?? []).map((f) => `variants/${name}/${typeof f === "string" ? f : f.path}`) });
    } catch {
      // a variant folder without a readable report: skip it
    }
  }
  return out;
}

const noCase = (dir: string) => err("No case yet", `${projectFilePath(dir)} has no enclosure`, 'pick a shape in the Case view, or ask the agent: design_case {"shape": "pebble"}');

export const caseRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/case",
    label: "GET /api/case",
    async handle(req, res, ctx) {
      const s = ctx.session();
      s.sync();
      const enc = s.project.enclosure ?? null;
      const variants = variantsOf(s.dir);
      if (!enc) return ctx.json(res, 200, { enclosure: null, stale: false, variants }, cors(req));
      const stale = await caseIsStale(s);
      const file = join(s.dir, "case", "report.json");
      const report = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
      ctx.json(res, 200, { enclosure: enc, ...(report ? { report } : {}), stale, variants }, cors(req));
    },
  },
  {
    method: "POST",
    path: "/api/case",
    label: "POST /api/case",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try {
        body = await ctx.body(req);
      } catch (e) {
        return ctx.json(res, 400, err("The case request is not JSON", (e as Error).message, 'send {"shape": "pebble", "params": {...}}'));
      }
      const has = !!ctx.session().project.enclosure;
      // (the Case view asks for the costs on its own, POST /api/case/costs)
      const args: Record<string, unknown> = { images: false, costs: false };
      for (const k of ["shape", "outline", "size_mm", "params", "front", "placements", "exclude", "layout"]) if (body[k] !== undefined) args[k] = body[k];
      if (!has && !args.shape) return ctx.json(res, 400, err("No case yet", "a new case needs a shape", 'send {"shape": "pebble"} (rounded-box, pill, pebble, puck or keychain)'));
      try {
        const r = await ctx.call(has ? "update_case" : "design_case", args, { actor: "web" });
        ctx.hub.broadcast({ type: "case", hash: (r as { hash?: string }).hash ?? "", ok: !!(r as { ok?: boolean }).ok });
        ctx.json(res, 200, r);
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `${has ? "Updating" : "Designing"} the case failed. Why: ${m}. Fix: change the setting and try again` });
      }
    },
  },
  {
    method: "POST",
    path: "/api/case/fit",
    label: "POST /api/case/fit",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try {
        body = await ctx.body(req);
      } catch (e) {
        return ctx.json(res, 400, err("The fit request is not JSON", (e as Error).message, 'send {"shape": "custom", "outline": "M ... Z", "size_mm": {"w": 60, "h": 78}}'));
      }
      try {
        const s = ctx.session();
        s.sync();
        ctx.json(res, 200, await previewFit(s, body));
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `Testing the fit failed. Why: ${m}. Fix: change the outline or the size and try again` });
      }
    },
  },
  {
    method: "POST",
    path: "/api/case/layouts",
    label: "POST /api/case/layouts",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try {
        body = await ctx.body(req);
      } catch (e) {
        return ctx.json(res, 400, err("The layouts request is not JSON", (e as Error).message, 'send {} for the saved case, or {"shape": "custom", "outline": "M ... Z"}'));
      }
      try {
        const s = ctx.session();
        s.sync();
        ctx.json(res, 200, await layoutProposals(s, body, { views: body.views !== false, costs: body.costs === true }));
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `Proposing layouts failed. Why: ${m}. Fix: change the outline or the parts and try again` });
      }
    },
  },
  {
    method: "POST",
    path: "/api/case/costs",
    label: "POST /api/case/costs",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try {
        body = await ctx.body(req);
      } catch (e) {
        return ctx.json(res, 400, err("The costs request is not JSON", (e as Error).message, 'send {} for the saved case, or the draft {"shape": "custom", "outline": "M ... Z", "params": {...}}'));
      }
      try {
        const s = ctx.session();
        s.sync();
        ctx.json(res, 200, await draftCosts(s, body));
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `Weighing the case choices failed. Why: ${m}. Fix: change the outline or the parts and try again` });
      }
    },
  },
  {
    method: "GET",
    path: "/api/case/advice",
    label: "GET /api/case/advice",
    handle(req, res, ctx) {
      const s = ctx.session();
      s.sync();
      ctx.json(res, 200, { notes: adviceNotes(s.project, s.registry) }, cors(req));
    },
  },
  {
    method: "POST",
    path: "/api/case/advice/apply",
    label: "POST /api/case/advice/apply",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try {
        body = await ctx.body(req);
      } catch (e) {
        return ctx.json(res, 400, err("The apply request is not JSON", (e as Error).message, 'send {"id": "smaller-speaker:spk"} (an id from GET /api/case/advice)'));
      }
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return ctx.json(res, 400, err("No advice id", "the request has no id", 'send {"id": "<id from GET /api/case/advice>"}'));
      const s = ctx.session();
      s.sync();
      try {
        const note = adviceNotes(s.project, s.registry).find((n) => n.id === id);
        const ops = opsForApply(s.project, s.registry, id);
        // one why, so the ops are one undoable step in the history
        const why = `${note?.apply?.label ?? "Apply"} (Case view: ${note?.title ?? id})`;
        for (const o of ops) await ctx.call(o.op, { ...o.args, why }, { actor: "web" });
        s.sync();
        ctx.json(res, 200, { applied: id, result: note?.apply?.result ?? "Done.", notes: adviceNotes(s.project, s.registry) });
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `Applying that change failed. Why: ${m}. Fix: undo the last step on the canvas and make the change there` });
      }
    },
  },
  {
    method: "POST",
    path: "/api/case/assembly",
    label: "POST /api/case/assembly",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      const s = ctx.session();
      s.sync();
      if (!s.project.enclosure) return ctx.json(res, 404, noCase(s.dir));
      try {
        const r = await assemblyPlanFor(s);
        if (r.stale_case_regenerated) ctx.hub.broadcast({ type: "case", hash: "", ok: true });
        // (the pictures are case files: the page loads them from GET /api/case/file)
        const steps = r.steps.map(({ image_file, ...st }) => ({ ...st, ...(image_file && st.image ? { image_url: `/api/case/file?path=${encodeURIComponent(st.image)}&inline=1` } : {}) }));
        ctx.json(res, 200, { ...r, steps, dir: undefined });
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `Working out the assembly failed. Why: ${m}. Fix: press Update case, then open Assembly again` });
      }
    },
  },
  {
    method: "GET",
    path: "/api/case/mesh",
    label: "GET /api/case/mesh",
    async handle(req, res, ctx) {
      const s = ctx.session();
      s.sync();
      if (!s.project.enclosure) return ctx.json(res, 404, noCase(s.dir), cors(req));
      try {
        const { mesh, regenerated, report } = await caseMesh(s);
        if (regenerated) ctx.hub.broadcast({ type: "case", hash: report.hash, ok: report.ok });
        ctx.json(res, 200, mesh, cors(req));
      } catch (e) {
        ctx.json(res, 500, err("Could not build the case meshes", (e as Error).message, "check get_case for errors, change the case and try again"), cors(req));
      }
    },
  },
  {
    method: "GET",
    path: "/api/device/case",
    label: "GET /api/device/case",
    async handle(req, res, ctx) {
      const s = ctx.session();
      s.sync();
      try {
        ctx.json(res, 200, { case: await deviceCase(s) }, cors(req));
      } catch (e) {
        ctx.json(res, 500, err("Could not load the case for the Device view", (e as Error).message, "open the Case view and press Update case, then open the Device view again"), cors(req));
      }
    },
  },
  {
    method: "GET",
    path: /^\/api\/case\/file$/,
    label: "GET /api/case/file?path=",
    handle(req, res, ctx) {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.searchParams.get("path") ?? "";
      const root = join(ctx.dir(), "case");
      const abs = inside(root, p);
      if (!abs) return ctx.json(res, 400, err(`Refused the path "${p}"`, "only files inside the project's case/ folder can be downloaded", 'pass a path from the case report, e.g. "stl/front.stl"'));
      if (!existsSync(abs)) return ctx.json(res, 404, err(`No case file ${p}`, "it was not generated (or the case changed since)", "open the Case view or call get_case to regenerate the files"));
      sendFile(res, abs, url.searchParams.get("inline") !== "1");
    },
  },
  {
    method: "POST",
    path: "/api/manufacturing",
    label: "POST /api/manufacturing",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      let body: Record<string, unknown> = {};
      try {
        body = await ctx.body(req);
      } catch {
        body = {};
      }
      try {
        const r = (await ctx.call("export_manufacturing", { ...(body.zh_cn === false ? { zh_cn: false } : {}) }, { actor: "web" })) as { zip?: string };
        ctx.json(res, 200, { ...r, ...(r.zip ? { url: `/api/manufacturing/${encodeURIComponent(basename(r.zip))}` } : {}) });
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `The factory pack failed. Why: ${m}. Fix: check get_case and build, then try again` });
      }
    },
  },
  {
    method: "GET",
    path: /^\/api\/manufacturing\/(?<file>[^/]+\.zip)$/,
    label: "GET /api/manufacturing/:file",
    handle(_req, res, ctx, params) {
      const root = join(ctx.dir(), "manufacturing");
      const abs = inside(root, decodeURIComponent(params.file ?? ""));
      if (!abs || !existsSync(abs)) return ctx.json(res, 404, err(`No pack ${params.file}`, "it is not in the project's manufacturing/ folder", "make it with the Factory pack button (POST /api/manufacturing) first"));
      sendFile(res, abs, true);
    },
  },
];

/** The case live event also follows agent (MCP) calls: after design_case / update_case / get_case regenerate files. */
export const caseHooks: ServerHook[] = [
  (ctx) => {
    let off: (() => void) | undefined;
    const watch = () => {
      off?.();
      off = ctx.session().onEvent((e) => {
        if (e.type !== "action" || !e.entry.ok || e.entry.actor === "web") return;
        if (!["design_case", "update_case", "get_case"].includes(e.entry.op)) return;
        const s = ctx.session();
        const file = join(s.dir, "case", "report.json");
        if (!existsSync(file)) return;
        try {
          const r = JSON.parse(readFileSync(file, "utf8")) as { hash: string; ok: boolean };
          ctx.hub.broadcast({ type: "case", hash: r.hash, ok: r.ok });
        } catch {
          // a half-written report: the next call sends it
        }
      });
    };
    watch();
    const unsub = ctx.projects?.onSessionChange(() => watch());
    return () => {
      off?.();
      unsub?.();
    };
  },
];
