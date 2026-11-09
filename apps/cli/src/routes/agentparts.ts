import type { ApiRoute, ServerHook } from "./types.ts";

/**
 * Round 5, track "agentparts" (owner). Decision 0003, C3.
 * Endpoints: GET /api/project-parts.
 */
export const agentpartsRoutes: ApiRoute[] = [];

/** Started with the server, stopped on close. */
export const agentpartsHooks: ServerHook[] = [];
