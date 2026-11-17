import { projectPartsWithSvg } from "@fabwright/session";
import type { ApiRoute, ServerHook } from "./types.ts";

/**
 * Round 5, track "agentparts" (owner). Decision 0003, C3.
 * Endpoints: GET /api/project-parts → { parts: { id, part: CustomPart, svg }[] }: the active
 * project's agent-made parts with their sanitized (or generated) SVG, so the web canvas can draw
 * and simulate them (apps/web/src/lib/projectParts.ts). Read-only.
 */
export const agentpartsRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/project-parts",
    label: "GET /api/project-parts",
    handle(req, res, ctx) {
      // Local pages on another port (Vite dev following this server) may read it too; serve.ts
      // already refused non-local hosts and origins.
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
      try {
        ctx.json(res, 200, { parts: projectPartsWithSvg(ctx.session()) }, cors);
      } catch (e) {
        ctx.json(res, 500, { error: `Could not read the project's agent-made parts. Why: ${(e as Error).message}. Fix: check ${ctx.dir()}/parts/<id>/part.json (list_project_parts names the broken one) and fix it with update_part.` }, cors);
      }
    },
  },
];

/** Started with the server, stopped on close. */
export const agentpartsHooks: ServerHook[] = [];
