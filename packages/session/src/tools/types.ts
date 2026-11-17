import type { Project } from "@fabwright/project-format";
import type { ToolDef } from "../catalog.ts";
import type { Step } from "../history.ts";
import type { ProjectSession } from "../session.ts";

/**
 * Round 5 (docs/decisions/0003-round5-see-it-work.md, "Shared contracts" C5): tools added by a
 * track live in their own module under src/tools/ instead of growing session.ts and catalog.ts, so
 * parallel branches do not edit the same lines. A module exports its tool definitions and one
 * handler per tool; ProjectSession.call() routes to them with the same validation, logging, undo
 * and error shaping as the built-in ops.
 */
export interface ExtOpContext {
  session: ProjectSession;
  /** The caller's "why", when given. */
  why: string | undefined;
  /** Apply a project change (+ file writes, null deletes) as one recorded, undoable edit. */
  commit(label: string, next: Project, files?: Record<string, string | null>): Step;
  /** One-line summary for the action log and the live captions. */
  summary(text: string): void;
  /** The part / pin being edited (agent cursor on the canvas). */
  target(part: string, pin?: string): void;
}

export type ExtOp = (args: Record<string, unknown>, x: ExtOpContext) => unknown | Promise<unknown>;

export interface ToolModule {
  /** Track name, for error messages. */
  name: string;
  tools: ToolDef[];
  /** tool name → handler; every tool in `tools` needs one (a test checks it). */
  ops: Record<string, ExtOp>;
}
