import { readFile } from "node:fs/promises";
import { runAudioFile } from "@faber/session";
import type { ApiRoute } from "./types.ts";

/**
 * Round 13 (audio): GET /api/audio/<file>: the WAV a `run` recorded from the board's I2S output
 * (.faber/audio/run-<seq>.wav, named in the run's log entry). The page plays it with the run's
 * frames. Only run-<n>.wav names are served, from the active project's folder.
 */
export const audioRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: /^\/api\/audio\/(?<file>[^/]+)$/,
    label: "GET /api/audio/<file>",
    async handle(req, res, ctx, params) {
      // Same rule as GET /api/firmware: a page following this server from another local origin may read it.
      const origin = req.headers.origin;
      const cors: Record<string, string> = origin && origin !== "null" ? { "access-control-allow-origin": origin, vary: "origin" } : {};
      const file = runAudioFile(ctx.dir(), params.file ?? "");
      if (!file) return ctx.json(res, 400, { error: `'${params.file}' is not a run recording. Why: only the run-<n>.wav files a run writes are served. Fix: use the file named in the run's audio field.` }, cors);
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": "audio/wav", "content-length": String(body.length), "cache-control": "no-store", ...cors });
        res.end(body);
      } catch {
        ctx.json(res, 404, { error: `${params.file} is gone. Why: Faber keeps the last 20 run recordings, or the project changed. Fix: run again.` }, cors);
      }
    },
  },
];
