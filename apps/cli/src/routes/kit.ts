import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, normalize, relative, resolve, sep } from "node:path";
import { buildKit } from "@fabwright/session";
import type { ApiRoute, RouteContext } from "./types.ts";

/**
 * Round 12, track kit (owner): the web "Build it" panel.
 *   GET  /api/kit?region=&prefer=   → the build kit (BuildKit) for the open project; read-only, print
 *                                     estimates from earlier slices or the meshes (never slices here)
 *   POST /api/kit/files             → { region?, prefer? } writes build-kit/<name>-kit/ + zip (get_build_kit,
 *                                     actor web); { zip_url, html_url, pdf_url?, missing }
 *   GET  /api/kit/file?path=        → a file from <project>/build-kit/ (kit.html inline, the rest as downloads)
 * Local-only like every route; POST needs x-fabwright-token. Errors: { error: "<what>. Why: … Fix: …" }.
 */

const err = (what: string, why: string, fix: string) => ({ error: `${what}. Why: ${why}. Fix: ${fix}` });
const REGIONS = new Set(["global", "us", "eu", "uk"]);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", pdf: "application/pdf", zip: "application/zip", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", stl: "model/stl", "3mf": "model/3mf", png: "image/png", hex: "text/plain; charset=utf-8", uf2: "application/octet-stream", bin: "application/octet-stream" };

function inside(root: string, p: string): string | undefined {
  if (!p || p.includes("\0")) return undefined;
  const abs = resolve(root, normalize(p));
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..") || resolve(root, rel) !== abs) return undefined;
  return abs;
}

function opts(q: URLSearchParams | Record<string, unknown>) {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : typeof q[k] === "string" ? (q[k] as string) : null);
  const region = get("region");
  const prefer = get("prefer");
  return { ...(region && REGIONS.has(region) ? { region: region as "global" } : {}), ...(prefer ? { prefer } : {}) };
}

const fileUrl = (dir: string, abs: string) => `/api/kit/file?path=${encodeURIComponent(relative(join(dir, "build-kit"), abs).split(sep).join("/"))}`;

export const kitRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/kit",
    label: "GET /api/kit",
    async handle(req: IncomingMessage, res: ServerResponse, ctx: RouteContext) {
      const s = ctx.session();
      if (!s.project.parts.length) return ctx.json(res, 404, err("Nothing to build yet", "the project has no parts", "place the parts (or ask your agent to plan the device), then open Build it again"));
      try {
        const kit = await buildKit(s, { ...opts(new URL(req.url ?? "/", "http://x").searchParams), slicer: "cached" });
        ctx.json(res, 200, kit);
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 500, { error: m.includes("Why:") ? m : `The build kit could not be made. Why: ${m}. Fix: open the Case view (it rebuilds the case files) and try again` });
      }
    },
  },
  {
    method: "POST",
    path: "/api/kit/files",
    label: "POST /api/kit/files",
    async handle(req, res, ctx) {
      if (req.headers["x-fabwright-token"] !== ctx.token) return ctx.json(res, 403, err("Missing or wrong x-fabwright-token", "making the kit's files needs the token from GET /api/connect, which only pages served by this Fabwright server can read", "open the Fabwright app from the fabwright serve URL and try again"));
      let body: Record<string, unknown> = {};
      try {
        body = await ctx.body(req);
      } catch {
        body = {};
      }
      try {
        const r = (await ctx.call("get_build_kit", { ...opts(body), slicer: "cached", ...(body.pdf === false ? { pdf: false } : {}) }, { actor: "web" })) as { kit: { missing: unknown[] }; files: { dir: string; zip?: string; html: string; pdf?: string } };
        const dir = ctx.dir();
        ctx.json(res, 200, { missing: r.kit.missing, ...(r.files.zip ? { zip_url: fileUrl(dir, r.files.zip) } : {}), html_url: fileUrl(dir, r.files.html), ...(r.files.pdf ? { pdf_url: fileUrl(dir, r.files.pdf) } : {}) });
      } catch (e) {
        const m = (e as Error).message;
        ctx.json(res, 400, { error: m.includes("Why:") ? m : `The kit's files could not be written. Why: ${m}. Fix: check the project folder is writable and try again` });
      }
    },
  },
  {
    method: "GET",
    path: "/api/kit/file",
    label: "GET /api/kit/file?path=",
    handle(req, res, ctx) {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.searchParams.get("path") ?? "";
      const root = join(ctx.dir(), "build-kit");
      const abs = inside(root, p);
      if (!abs) return ctx.json(res, 400, err(`Refused the path "${p}"`, "only files inside the project's build-kit/ folder can be downloaded", "use the links the Build it panel gives"));
      if (!existsSync(abs)) return ctx.json(res, 404, err(`No kit file ${p}`, "the kit's files were not written yet (or were written for another project)", "press Download in the Build it panel first"));
      const ext = abs.split(".").pop()!.toLowerCase();
      const inline = ext === "html" || url.searchParams.get("inline") === "1";
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store", ...(inline ? {} : { "content-disposition": `attachment; filename="${basename(abs)}"` }), ...(ext === "html" ? { "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } : {}) });
      res.end(readFileSync(abs));
    },
  },
];
