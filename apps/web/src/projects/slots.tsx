import type { ComponentType } from "react";
import { useEffect } from "react";
import { CodeEditor } from "../code/CodeEditor.tsx";
import { newProject } from "../shell/actions.ts";
import { useChangeTicker } from "./data.ts";
import { HistoryView } from "./HistoryView.tsx";
import { ProjectsHome } from "./ProjectsHome.tsx";

/** Refetch triggers and `?new=1` (a new blank project opened in its own tab, so no circuit is replaced). */
function ProjectsEffects() {
  useChangeTicker();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.has("new") && !q.has("example") && !q.has("follow") && !q.has("replay")) requestAnimationFrame(() => newProject());
  }, []);
  return null;
}

/**
 * Round 5, track "projects" (owner): components the app shell mounts (decision 0003, C8).
 * stage  = inside <main class="stage"> above the canvas (Projects home, history scrubber, code editor)
 * chrome = top level, above the floating chrome (dialogs, sheets)
 */
export const projectsStage: ComponentType[] = [ProjectsEffects];
export const projectsChrome: ComponentType[] = [ProjectsHome, HistoryView, CodeEditor];
