import { agentHooks, agentRoutes } from "./agent.ts";
import { agentpartsHooks, agentpartsRoutes } from "./agentparts.ts";
import { caseHooks, caseRoutes } from "./case.ts"; // round 6 case
import { networkRoutes } from "./network.ts"; // round 10 net
import { runtimeRoutes } from "./runtime.ts"; // round 11 native builds
import { kitRoutes } from "./kit.ts"; // round 12 kit
import { audioRoutes } from "./audio.ts"; // round 13 audio
import { liveHooks, liveRoutes } from "./live.ts";
import { projectsHooks, projectsRoutes } from "./projects.ts";
import type { ApiRoute, ServerHook } from "./types.ts";

export type { ApiRoute, RouteContext, ServerHook } from "./types.ts";

/** Every round-5 route. Append-only: one line per track. */
export const ROUTES: ApiRoute[] = [
  ...projectsRoutes,
  ...liveRoutes,
  ...agentRoutes,
  ...agentpartsRoutes,
  ...caseRoutes, // round 6 case
  ...networkRoutes, // round 10 net
  ...runtimeRoutes, // round 11 native builds
  ...kitRoutes, // round 12 kit
  ...audioRoutes, // round 13 audio
];

/** Every round-5 server hook. Append-only: one line per track. */
export const HOOKS: ServerHook[] = [
  ...projectsHooks,
  ...liveHooks,
  ...agentHooks,
  ...agentpartsHooks,
  ...caseHooks, // round 6 case
];

/** The route for this request, with its named groups, or undefined. */
export function matchRoute(method: string, path: string): { route: ApiRoute; params: Record<string, string> } | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (typeof route.path === "string") {
      if (route.path === path) return { route, params: {} };
    } else {
      const m = route.path.exec(path);
      if (m) return { route, params: { ...(m.groups ?? {}) } };
    }
  }
  return undefined;
}
