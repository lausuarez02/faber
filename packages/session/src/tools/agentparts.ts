import type { ToolModule } from "./types.ts";

/**
 * Track "agentparts" (owner): create_part, update_part, list_project_parts.
 * Contract: docs/decisions/0003-round5-see-it-work.md, C4 and C5.
 */
export const agentPartsTools: ToolModule = { name: "agentparts", tools: [], ops: {} };
