import type { Project } from "@jumper/project-format";
import { engine, useJumper } from "../lib/app.ts";
import { emitProjectSwitch, onProjectSwitch, type ProjectSwitch } from "../lib/projectSwitch.ts";
import { forgetFirmware } from "../live/followRun.ts";
import { useLive } from "../live/liveStore.ts";
import { api } from "./api.ts";
import { landOnProjects } from "./firstRun.ts";
import { useProjectsUi } from "./store.ts";

/**
 * Round 6, switch track (decision 0004, R8): opening a project resets everything that belonged to
 * the old one. The followed page calls switchProject() for every hello from the server (a project
 * opened from the gallery, an agent's new_project {folder}, a reconnect); the other tracks register
 * their own resets with onProjectSwitch().
 */

/** The dir the page last showed (from the server's hello), to tell "open" from "reload". */
let shownDir: string | undefined;

/** The project id the server gave a folder: the gallery's id (sha256 of the dir, 12 hex), when known. */
let shownId: string | undefined;

export function switchReason(prevDir: string | undefined, nextDir: string): ProjectSwitch["reason"] {
  return prevDir !== undefined && prevDir === nextDir ? "reload" : "open";
}

/**
 * Load a project that came from the server. On "open": stop and throw away the simulation and the
 * old firmware BEFORE the new circuit lands (otherwise the engine rebuilds the new circuit with the
 * old hex: an Uno hex in an RP2040 says "built for another board"), load it, then tell every track.
 */
export function switchProject(project: Project, dir: string, load: (p: Project) => void): ProjectSwitch["reason"] {
  const reason = switchReason(shownDir, dir);
  const first = shownDir === undefined;
  shownDir = dir;
  if (reason === "open") {
    engine.stop();
    forgetFirmware();
    const s = useJumper.getState();
    s.setFirmware({ status: project.firmware ? "loading" : "none" });
    s.setSimError(undefined);
  }
  load(project);
  emitProjectSwitch({ id: shownId, reason });
  // Someone new starts on the Projects page (pitch + cards), not on a canvas they did not ask for.
  if (first && landOnProjects(project, dir)) useProjectsUi.getState().setHome(true);
  if (reason === "open" && !first) useJumper.getState().toast({ kind: "info", title: `Opened ${project.name}` });
  return reason;
}

/** The server's `{type: "project", id}` event (sent before the new hello), so the switch event carries the id. */
export function expectProject(id: string | undefined): void {
  shownId = id;
}

/** Test hook: forget what was shown. */
export function resetSwitchState(): void {
  shownDir = undefined;
  shownId = undefined;
}

/**
 * The floating code card shows the new project's main sketch (or nothing), never the old one's.
 * Called after a switch when the hello carried no file the agent wrote.
 */
export async function loadMainSketch(dir: string): Promise<void> {
  try {
    const list = await api.files();
    const path = list.main ?? list.files.find((f) => /\.(ino|cpp|c|h)$/.test(f.path))?.path;
    if (!path) return;
    const f = await api.file(path);
    // Still the same project, and nothing newer arrived meanwhile.
    if (shownDir === dir && !useLive.getState().code) useLive.getState().set({ code: { path: f.path, content: f.content } });
  } catch {
    // no server files (an empty project, an old server): the card stays hidden
  }
}

/**
 * After an op that rewrote files without logging their content (restore_version, undo, redo,
 * reject_step), re-read the file the code card shows so it never shows the code from before.
 */
export async function refreshCodeCard(): Promise<void> {
  const shown = useLive.getState().code;
  const dir = shownDir;
  try {
    let path = shown?.path;
    if (!path) {
      const list = await api.files();
      path = list.main ?? undefined;
    }
    if (!path) return;
    const f = await api.file(path);
    if (shownDir === dir && f.content !== useLive.getState().code?.content) useLive.getState().set({ code: { path: f.path, content: f.content } });
  } catch {
    // the file is gone after the restore: keep the card as it is
  }
}

// ----------------------------------------------------------------------- switch track's resets

onProjectSwitch(({ reason }) => {
  if (reason !== "open") return;
  // Messages about the old project: toasts, the live caption, test results, the code card.
  const s = useJumper.getState();
  for (const t of s.toasts) s.dismissToast(t.id);
  useLive.getState().set({
    code: undefined,
    caption: undefined,
    tests: undefined,
    fidelity: undefined,
    error: undefined,
    cursor: undefined,
    firmwareHash: undefined,
    firmwareStale: false,
    stepActors: {},
  });
  // History, the code editor and its read-only snapshot belonged to the old project.
  useProjectsUi.setState({ history: false, code: { open: false } });
  useProjectsUi.getState().bump();
});
