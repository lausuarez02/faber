import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiRoute, RouteContext } from "./types.ts";

/**
 * Round 11, native builds: where builds and emulators run on this computer, and `fabwright setup` from
 * the app with the same progress lines the CLI prints.
 *   GET  /api/runtime          {setting, summary, docker: {ok, why?}, native: [{id, label, installed, path}], families}
 *   POST /api/runtime/setup    {target: "all" | "esp32" | ...} → newline-delimited JSON:
 *                              {line} per progress line, then {done: true, steps} or {error} (what / why / fix)
 * Local-only like every route; setup needs x-fabwright-token.
 */
let running: string | undefined;

function needToken(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (req.headers["x-fabwright-token"] === ctx.token) return true;
  ctx.json(res, 403, { error: "Missing or wrong x-fabwright-token. Why: installing toolchains needs the token from GET /api/connect, which only pages served by this Fabwright server can read. Fix: open the Fabwright app from the fabwright serve URL, or run `fabwright setup` in a terminal." });
  return false;
}

export const runtimeRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/runtime",
    label: "GET /api/runtime",
    async handle(_req, res, ctx) {
      const r = await import("@fabwright/runner");
      const docker = r.probeDocker();
      ctx.json(res, 200, {
        setting: r.runtimeSetting(),
        summary: r.runtimeSummary(),
        docker: docker.ok ? { ok: true } : { ok: false, why: docker.why },
        native: r.nativeStatus(),
        families: Object.fromEntries(Object.entries(r.SETUP_TARGETS).map(([k, v]) => [k, v.label])),
        ...(running ? { installing: running } : {}),
      });
    },
  },
  {
    method: "POST",
    path: "/api/runtime/setup",
    label: "POST /api/runtime/setup",
    async handle(req, res, ctx) {
      if (!needToken(req, res, ctx)) return;
      const r = await import("@fabwright/runner");
      const { target = "all" } = await ctx.body<{ target?: string }>(req);
      if (target !== "all" && !r.setupTargetOf(target)) {
        return ctx.json(res, 400, { error: `No board family '${target}'. Why: setup knows ${Object.keys(r.SETUP_TARGETS).join(", ")} and all. Fix: pick one of those.` });
      }
      if (running) return ctx.json(res, 409, { error: `Setup is already running (${running}). Why: one install at a time keeps the downloads consistent. Fix: wait for it to finish, then try again.` });
      running = target;
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      const send = (o: unknown) => res.write(JSON.stringify(o) + "\n");
      try {
        send({ line: r.runtimeSummary() });
        const steps = await r.setupNative(target, (line) => send({ line }));
        send({ done: true, steps });
      } catch (e) {
        send({ error: (e as Error).message });
      } finally {
        running = undefined;
        res.end();
      }
    },
  },
];
