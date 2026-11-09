import { agentTools } from "./agent.ts";
import { agentPartsTools } from "./agentparts.ts";
import { projectsTools } from "./projects.ts";
import type { ExtOp, ToolModule } from "./types.ts";

export type { ExtOp, ExtOpContext, ToolModule } from "./types.ts";

/** Every round-5 tool module. Append-only: one line per track. */
export const TOOL_MODULES: ToolModule[] = [
  agentPartsTools,
  agentTools,
  projectsTools,
];

/** tool name → handler for the module tools (ProjectSession.call routes here after OP_METHODS). */
export const EXT_OPS: Record<string, ExtOp> = Object.fromEntries(TOOL_MODULES.flatMap((m) => Object.entries(m.ops)));
