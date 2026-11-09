import type { ApiRoute, ServerHook } from "./types.ts";

/**
 * Round 5, track "agent" (owner). Decision 0003, C3.
 * Endpoints: GET /v/:id (shareable local viewer), GET /api/media/:file (recordings).
 */
export const agentRoutes: ApiRoute[] = [];

/** Started with the server, stopped on close. */
export const agentHooks: ServerHook[] = [];
