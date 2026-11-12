import { agentTools } from "./agent.ts";
import { caseTools } from "./case.ts"; // round 6 case
import { agentPartsTools } from "./agentparts.ts";
import { projectsTools } from "./projects.ts";
import { powerTools } from "./power.ts";
import { voiceTools } from "./voice.ts"; // round 7 voice
import { networkTools } from "./network.ts"; // round 10 network
import { kitTools } from "./kit.ts"; // round 12 kit
import { cameraTools } from "./camera.ts"; // round 13 camera
import type { ExtOp, ToolModule } from "./types.ts";

export type { ExtOp, ExtOpContext, ToolModule } from "./types.ts";

/** Every round-5 tool module. Append-only: one line per track. */
export const TOOL_MODULES: ToolModule[] = [
  agentPartsTools,
  agentTools,
  projectsTools,
  powerTools,
  caseTools, // round 6 case
  voiceTools, // round 7 voice
  networkTools, // round 10 network
  kitTools, // round 12 kit
  cameraTools, // round 13 camera
];

/** tool name → handler for the module tools (ProjectSession.call routes here after OP_METHODS). */
export const EXT_OPS: Record<string, ExtOp> = Object.fromEntries(TOOL_MODULES.flatMap((m) => Object.entries(m.ops)));
