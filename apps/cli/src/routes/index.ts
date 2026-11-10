import { agentHooks, agentRoutes } from "./agent.ts";
import { agentpartsHooks, agentpartsRoutes } from "./agentparts.ts";
import { caseHooks, caseRoutes } from "./case.ts"; // round 6 case
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
