import type { ToolModule } from "./types.ts";

/**
 * Track "agent" (owner): plan_device, record, viewer_url, delete_file.
 * Contract: docs/decisions/0003-round5-see-it-work.md, C5.
 */
export const agentTools: ToolModule = { name: "agent", tools: [], ops: {} };
