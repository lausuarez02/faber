import type { ApiRoute, ServerHook } from "./types.ts";

/**
 * Round 5, track "live" (owner). Decision 0003, C3.
 * Endpoints: GET /api/agent-state, GET /api/firmware.
 */
export const liveRoutes: ApiRoute[] = [];

/** Started with the server, stopped on close. */
export const liveHooks: ServerHook[] = [];
