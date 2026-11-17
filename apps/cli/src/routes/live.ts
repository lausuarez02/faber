import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { ApiRoute, RouteContext, ServerHook } from "./types.ts";

/**
 * Round 5, track "live" (owner). Decision 0003, C3.
 * Endpoints: GET /api/agent-state, GET /api/firmware.
 *
 * Both are read by the followed page (`/?follow=ws://…/live`), which may be served by another local
 * origin (Vite on its own port in development), so they answer with CORS for local origins (serve
 * has already refused any non-local Host / Origin before a route runs).
 */

function cors(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  return origin && origin !== "null" ? { "access-control-allow-origin": origin, vary: "origin" } : {};
}

export interface FirmwareInfo {
  hash: string;
  hex: string;
  artifact: string;
  /** Board part type ("arduino-uno"). */
  board: string;
  /** Simulator backend of that board ("avr8js", "rp2040js"). */
  backend: string;
  builtAt: string;
  /** The sketch changed after this hex was built (the page still runs this one until the next build). */
  stale: boolean;
}

/** The active project's built firmware, or why there is none (status + error text with why and fix). */
export function firmwareFor(ctx: RouteContext): { ok: true; info: FirmwareInfo } | { ok: false; status: number; error: string } {
  const session = ctx.session();
  const dir = ctx.dir();
  try {
    session.sync();
  } catch (err) {
    return { ok: false, status: 500, error: `Could not read the project in ${dir}: ${(err as Error).message}. Why: fabwright.json is not valid. Fix: run \`fabwright check -p ${dir}\` and fix what it reports.` };
  }
  const p = session.project;
  const boardPart = p.parts.find((x) => x.id === p.firmware?.board) ?? p.parts.find((x) => session.registry.get(x.type)?.spec.mcu);
  if (!boardPart) {
    return { ok: false, status: 404, error: `Nothing to run: the project has no board. Why: firmware needs a microcontroller board (Arduino Uno, Nano, Pico…) and ${p.parts.length ? "none of the parts is one" : "the project is empty"}. Fix: ask your agent to build something (it places the board), or open an example.` };
  }
  const backend = session.registry.get(boardPart.type)?.spec.mcu?.backend ?? "";
  if (!p.firmware?.sketch || !existsSync(join(dir, "firmware", p.firmware.sketch))) {
    return { ok: false, status: 404, error: `Nothing to run on ${boardPart.id}: there is no sketch yet. Why: the board has no firmware (firmware/main.ino). Fix: ask your agent to write and build the firmware, or open an example.` };
  }
  const artifact = p.firmware.artifact;
  const abs = join(dir, artifact);
  if (!existsSync(abs)) {
    return { ok: false, status: 404, error: `The firmware is not built yet: ${artifact} is missing. Why: the sketch ${p.firmware.sketch} has never been compiled. Fix: ask your agent to run it (run builds first), or run \`fabwright build -p ${dir}\`.` };
  }
  const hex = readFileSync(abs, "utf8");
  const builtMs = statSync(abs).mtimeMs;
  // The session's own answer (source hash against the last build record), the same one `run` uses to
  // decide whether to rebuild, so the page and the agent never disagree.
  let stale = false;
  try {
    stale = session.firmwareState() === "stale";
  } catch {
    // unreadable sketch folder: nothing newer than the hex
  }
  return {
    ok: true,
    info: { hash: createHash("sha256").update(hex).digest("hex"), hex, artifact, board: boardPart.type, backend, builtAt: new Date(builtMs).toISOString(), stale },
  };
}

export const liveRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/agent-state",
    label: "GET /api/agent-state",
    handle(req, res, ctx) {
      ctx.json(res, 200, ctx.hub.agentState(), cors(req));
    },
  },
  {
    method: "GET",
    path: "/api/firmware",
    label: "GET /api/firmware",
    handle(req, res, ctx) {
      const r = firmwareFor(ctx);
      if (!r.ok) return ctx.json(res, r.status, { error: r.error }, cors(req));
      ctx.json(res, 200, r.info, cors(req));
    },
  },
];

/** Started with the server, stopped on close. */
export const liveHooks: ServerHook[] = [];
