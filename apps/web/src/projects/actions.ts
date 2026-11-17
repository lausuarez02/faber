import { serializeProject } from "@faber/project-format";
import { initialExample, useFaber } from "../lib/app.ts";
import { useLive } from "../live/liveStore.ts";
import { newProject as newLocalProject } from "../shell/actions.ts";
import { ApiError, api, serverConnection, type ProjectCard } from "./api.ts";
import { useProjectsUi } from "./store.ts";
import { markOpened } from "./firstRun.ts";

/**
 * Opening, creating and switching projects. With the local server the server's active project
 * changes and the canvas (following it) reloads; without one the app opens examples by URL and
 * never replaces a circuit someone made: it opens a new tab instead.
 */

function toastError(title: string, e: unknown): void {
  useFaber.getState().toast({ kind: "error", title, detail: (e as Error).message });
}

/** The canvas follows the server: after a switch its hello reloads the canvas. Elsewhere, go to the server's root (it redirects to follow). */
function afterSwitch(_name: string): void {
  markOpened();
  useProjectsUi.setState({ home: false, history: false, code: { open: false } });
  // Following: the server's hello for the new folder switches the canvas (projects/switch.ts), which
  // resets the old project's state and says "Opened <name>".
  if (useLive.getState().mode !== "follow") location.href = "/";
}

/**
 * Open a card from the gallery: projects switch; an example opens the person's copy of it, made on
 * first open (C3). `newCopy` makes another copy ("Pocket Muse (2)") when the person asks for one.
 */
export async function openCard(card: ProjectCard, newCopy = false): Promise<void> {
  try {
    if (card.readOnly) await api.create({ from: card.id, name: card.name, ...(newCopy ? { copy: true } : {}) });
    else await api.open(card.id);
    afterSwitch(card.name);
  } catch (e) {
    toastError(`Could not open ${card.name}`, e);
  }
}

/** True when the local canvas has work that loading another project would replace. */
export function hasLocalWork(): boolean {
  const p = useFaber.getState().project;
  if (!p.parts.length && !p.wires.length) return false;
  if (useLive.getState().mode !== "off") return false;
  const lone = p.parts.length === 1 && !p.wires.length && p.name === "Untitled";
  if (lone) return false;
  try {
    return serializeProject(p) !== serializeProject(initialExample.project);
  } catch {
    return true;
  }
}

/** Without a server: open a bundled example; in a new tab when the canvas has someone's work. */
export function openLocalExample(example: string): void {
  const url = `${location.pathname}?example=${encodeURIComponent(example)}`;
  if (hasLocalWork()) {
    window.open(url, "_blank", "noopener");
    useFaber.getState().toast({ kind: "info", title: "Opened in a new tab", detail: "Your circuit stays here. Export it from the project menu to keep it." });
    return;
  }
  location.href = url;
}

/** A new blank project: a folder on the server, or a fresh canvas (new tab if this one has work). */
export async function newProjectAnywhere(name = "Untitled device"): Promise<void> {
  if (await serverConnection()) {
    try {
      await api.create({ name });
      afterSwitch(name);
    } catch (e) {
      toastError("Could not create the project", e);
    }
    return;
  }
  if (hasLocalWork()) {
    window.open(`${location.pathname}?new=1`, "_blank", "noopener");
    useFaber.getState().toast({ kind: "info", title: "New project opened in a new tab", detail: "Your circuit stays here." });
    return;
  }
  useProjectsUi.setState({ home: false });
  newLocalProject();
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Open a bundled example by folder name: a copy on the server, or by URL (new tab if needed) without one. */
export async function openExampleByName(example: string): Promise<void> {
  if (await serverConnection()) {
    try {
      const l = await api.projects();
      const card = l.examples.find((c) => c.dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() === example);
      if (card) return openCard(card);
    } catch (e) {
      toastError(`Could not open the example ${example}`, e);
      return;
    }
  }
  openLocalExample(example);
}
