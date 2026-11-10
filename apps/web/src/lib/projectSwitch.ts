/**
 * Round 6 (decision 0004, R8): one place that says "the open project changed". Every store that
 * holds per-project UI state (code panel, firmware, toasts, selection, inspector, live controls,
 * serial, case view, view port) registers a reset here; the switch track calls
 * emitProjectSwitch() after it loaded the new project and before it renders it. Tracks add their
 * own onProjectSwitch() call in their own files; nobody edits this file except the switch track.
 */
export interface ProjectSwitch {
  /** projectId of the project now open (undefined for a local / example canvas). */
  id: string | undefined;
  /** "open" = a different project; "reload" = the same project re-read from disk (restore, new hex). */
  reason: "open" | "reload";
}

type Listener = (s: ProjectSwitch) => void;
const listeners = new Set<Listener>();

/** Register a reset; returns the unregister function. Listeners must be synchronous and never throw. */
export function onProjectSwitch(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitProjectSwitch(s: ProjectSwitch): void {
  for (const cb of [...listeners]) {
    try {
      cb(s);
    } catch (e) {
      console.error("project switch reset failed", e);
    }
  }
}
