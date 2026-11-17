import type { IncomingMessage, ServerResponse } from "node:http";
import { networkSnapshot } from "@fabwright/session";
import type { ApiRoute, RouteContext } from "./types.ts";

/**
 * Round 10, track "net": the device network for the web app's Network panel.
 *   GET  /api/network?since=N      read_network (requests, frames, Wi-Fi, blocked with why / fix; secrets as names).
 *                                  {enabled: false} when the project has no network and none is running.
 *   POST /api/network/fault        {fault} → inject_network_fault (drop Wi-Fi, weak signal, clear, ...)
 *   POST /api/network/try          {url, method?, headers?, body?} → try_request
 * Local-only like every route; changing routes need x-fabwright-token.
 */
const err = (what: string, why: string, fix: string) => ({ error: `${what}. Why: ${why}. Fix: ${fix}` });

function needToken(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (req.headers["x-fabwright-token"] === ctx.token) return true;
  ctx.json(res, 403, err("Missing or wrong x-fabwright-token", "changing the device network needs the token from GET /api/connect, which only pages served by this Fabwright server can read", "open the Fabwright app from the fabwright serve URL and try again"));
  return false;
}

function failed(res: ServerResponse, ctx: RouteContext, e: unknown, what: string): void {
  const m = (e as Error).message;
  ctx.json(res, 400, { error: m.includes("Why:") || m.includes("Fix:") ? m : `${what}. Why: ${m}. Fix: read the message, change the request and try again` });
}

export const networkRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/network",
    label: "GET /api/network",
    async handle(req, res, ctx) {
      const s = ctx.session();
      s.sync();
      if (!s.project.network && !s.deviceNetwork.running) return ctx.json(res, 200, { enabled: false, hint: 'this project has no device network yet: set_network {"mode": "mock"} (or add_mock_api) turns it on' });
      const since = Number(new URL(req.url ?? "/", "http://x").searchParams.get("since") ?? 0) || 0;
      try {
        // Read directly (not through ctx.call): the panel polls, and polls must not fill the action log.
        ctx.json(res, 200, { enabled: true, ...(await networkSnapshot(s, { since, limit: 200 })) });
      } catch (e) {
        failed(res, ctx, e, "Reading the device network failed");
      }
    },
  },
  {
    method: "POST",
    path: "/api/network/fault",
    label: "POST /api/network/fault",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      try {
        const body = await ctx.body<{ fault?: unknown }>(req);
        ctx.json(res, 200, await ctx.call("inject_network_fault", { fault: body.fault }, { actor: "web" }));
      } catch (e) {
        failed(res, ctx, e, "The network fault was not applied");
      }
    },
  },
  {
    method: "POST",
    path: "/api/network/try",
    label: "POST /api/network/try",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      try {
        const body = await ctx.body(req);
        ctx.json(res, 200, await ctx.call("try_request", body, { actor: "web" }));
      } catch (e) {
        failed(res, ctx, e, "The request was not made");
      }
    },
  },
];
