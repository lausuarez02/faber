import type { Server } from "node:http";
import { listRegisteredProjects, projectId } from "./projects-registry.ts";

/**
 * Round 5, track "agent" (decision 0003, C3/C5): what the agent tools need to know about the host
 * they run in. `jumper serve` tells us its URL when it starts (routes/agent.ts), so viewer_url,
 * record and new_project {folder} can hand the person a link; a stdio MCP server or the CLI has no
 * server, and the tools say how to get one.
 */
let base: string | undefined;

/** Set by jumper serve once it listens ("http://localhost:7780"); undefined when it closes. */
export function setServerBase(url: string | undefined): void {
  base = url?.replace(/\/+$/, "");
}

export function serverBase(): string | undefined {
  return base;
}

/** The shareable local viewer for a project folder (GET /v/:id on jumper serve), or undefined without a server. */
export function viewerUrlFor(dir: string): string | undefined {
  return base ? `${base}/v/${projectId(dir)}` : undefined;
}

/** A project folder by its id, among the given folders and the registry ($JUMPER_HOME/projects.json). */
export function projectDirById(id: string, known: string[] = []): string | undefined {
  for (const d of known) if (projectId(d) === id) return d;
  return listRegisteredProjects().find((p) => projectId(p.dir) === id)?.dir;
}

export interface PetGateway {
  url: string;
  port: number;
  provider: string;
  reason: string;
  close(): Promise<void>;
}

/**
 * Start the pet AI gateway for `jumper serve` (decision 0003, C3): port from JUMPER_AI_GATEWAY_PORT
 * (default 8787; 0 under tests), the next free port when it is taken, bound to 127.0.0.1. Never
 * throws: a gateway that cannot start is reported through `log` and serve keeps going.
 * JUMPER_AI_GATEWAY=off skips it.
 */
export async function startPetGateway(opts: { env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): Promise<PetGateway | undefined> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  if (/^(off|0|false|no)$/i.test(env.JUMPER_AI_GATEWAY ?? "")) return undefined;
  const raw = env.JUMPER_AI_GATEWAY_PORT ?? (env.VITEST ? "0" : "8787");
  const want = Number(raw);
  if (!Number.isInteger(want) || want < 0 || want > 65535) {
    log(`AI gateway not started: JUMPER_AI_GATEWAY_PORT=${raw} is not a port number. Fix: set it to a free port such as 8787 (or 0 for any).`);
    return undefined;
  }
  try {
    const { chooseProvider, startGatewayServer } = await import("@jumper/ai-gateway/node");
    const choice = chooseProvider({ env });
    let lastErr: Error | undefined;
    for (let port = want, tries = 0; tries < (want === 0 ? 1 : 20); port++, tries++) {
      try {
        const g = await startGatewayServer({ port, host: "127.0.0.1", ...(choice.provider ? { live: choice.provider } : {}) });
        const server: Server = g.server;
        const actual = Number(new URL(g.url).port);
        return {
          url: g.url,
          port: actual,
          provider: choice.provider?.label ?? "Mock",
          reason: choice.reason,
          close: () =>
            new Promise<void>((r) => {
              server.closeAllConnections?.();
              server.close(() => r());
            }),
        };
      } catch (err) {
        lastErr = err as Error;
        if (!/already in use/.test(lastErr.message)) break;
      }
    }
    log(`AI gateway not started: ${lastErr?.message ?? "unknown error"}. Why: ports ${want}..${want + 19} are taken or unusable. Fix: set JUMPER_AI_GATEWAY_PORT to a free port; the pet's Live mode needs it, everything else works without it.`);
  } catch (err) {
    log(`AI gateway not started: ${(err as Error).message}. Fix: run pnpm install; the pet's Live mode needs it, everything else works without it.`);
  }
  return undefined;
}
