import type { ApiRoute, ServerHook } from "./types.ts";

/**
 * Round 5, track "projects" (owner). Decision 0003, C3.
 * Endpoints: GET /api/projects, GET /api/projects/:id, GET /api/projects/:id/thumbnail.png, POST /api/projects, POST /api/projects/:id/open, GET /api/history, GET /api/history/:version, POST /api/history/:version/restore, GET /api/files, GET /api/file, PUT /api/file, POST /api/build.
 */
export const projectsRoutes: ApiRoute[] = [];

/** Started with the server, stopped on close. */
export const projectsHooks: ServerHook[] = [];
