import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectDirById, projectId, setServerBase, startPetGateway, type PetGateway } from "@faber/session";
import type { ApiRoute, ServerHook } from "./types.ts";
import { stateDirPath } from "@faber/project-format/node";

/**
 * Round 5, track "agent" (owner). Decision 0003, C3.
 *   GET /v/:id             the shareable local viewer: 302 to the follow page with autorun
 *   GET /api/media/:file   recordings (record tool) from <project>/.faber/media/ only
 *   GET /api/ai-gateway    where the pet AI gateway serve started listens (the Network panel's Live mode)
 */

let gateway: PetGateway | undefined;
let gatewayProblem: string | undefined;

const MEDIA_TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", png: "image/png", gif: "image/gif" };

function page(status: number, title: string, body: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return { status, html: `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px/1.5 system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1 style="font-size:20px">${esc(title)}</h1><p>${esc(body)}</p></body>` };
}

export const agentRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: /^\/v\/(?<id>[0-9a-f]{12})\/?$/,
    label: "GET /v/:id",
    handle(req, res, ctx, params) {
      const id = params.id!;
      const active = ctx.dir();
      if (projectId(active) !== id) {
        const known = projectDirById(id);
        const p = known
          ? page(409, "That project is not open right now", `This link is for ${known}, but Faber has ${active} open. Why: one Faber server shows one project at a time. Fix: open it from the Projects gallery, or restart with faber serve --project ${known}, then open the link again.`)
          : page(404, "No such project here", `No project with id ${id} on this Faber server. Why: the link is from another computer or the folder was removed. Fix: ask for a new link (viewer_url) from the agent working on it.`);
        res.writeHead(p.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(p.html);
        return;
      }
      const host = req.headers.host ?? new URL(ctx.base()).host;
      res.writeHead(302, { location: `/?follow=${encodeURIComponent(`ws://${host}/live`)}&project=${id}&autorun=1`, "cache-control": "no-store" });
      res.end();
    },
  },
  {
    method: "GET",
    path: /^\/api\/media\/(?<file>[^/]+)$/,
    label: "GET /api/media/:file",
    handle(req, res, ctx, params) {
      const file = decodeURIComponent(params.file!);
      const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || !MEDIA_TYPES[ext]) {
        return ctx.json(res, 400, { error: `Bad media name '${file}'. Why: only recordings in the project's .faber/media folder (mp4, webm, png, gif; letters, digits, . _ -) are served. Fix: use the url the record tool returned.` });
      }
      const abs = join(stateDirPath(ctx.dir()), "media", file);
      if (!existsSync(abs)) return ctx.json(res, 404, { error: `No recording ${file}. Why: it is not in ${join(stateDirPath(ctx.dir()), "media")} (another project is open, or it was deleted). Fix: ask the agent to call record again.` });
      const size = statSync(abs).size;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
      const headers = { "content-type": MEDIA_TYPES[ext]!, "accept-ranges": "bytes", "cache-control": "no-store" };
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
        createReadStream(abs, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, "content-length": String(size) });
      createReadStream(abs).pipe(res);
    },
  },
  {
    method: "GET",
    path: "/api/ai-gateway",
    label: "GET /api/ai-gateway",
    handle(_req, res, ctx) {
      if (!gateway) return ctx.json(res, 404, { error: `The AI gateway is not running. Why: ${gatewayProblem ?? "faber serve did not start it"}. Fix: set FABER_AI_GATEWAY_PORT to a free port and restart faber serve, or run node services/ai-gateway/bin/ai-gateway.mjs.` });
      return ctx.json(res, 200, { url: gateway.url, port: gateway.port, provider: gateway.provider, reason: gateway.reason });
    },
  },
];

/** Started with the server, stopped on close. */
export const agentHooks: ServerHook[] = [
  // Viewer links (viewer_url, record, new_project {folder}) point at this server.
  (ctx) => {
    setServerBase(ctx.base());
    return () => setServerBase(undefined);
  },
  // The pet AI gateway (C3): FABER_AI_GATEWAY_PORT, default 8787, next free port, never fails serve.
  async () => {
    gatewayProblem = undefined;
    gateway = await startPetGateway({ log: (line) => ((gatewayProblem = line), process.stderr.write(`faber serve: ${line}\n`)) });
    const g = gateway;
    return async () => {
      if (gateway === g) gateway = undefined;
      await g?.close();
    };
  },
];
