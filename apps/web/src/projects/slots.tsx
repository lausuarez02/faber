import type { ComponentType } from "react";

/**
 * Round 5, track "projects" (owner): components the app shell mounts (decision 0003, C8).
 * stage  = inside <main class="stage"> above the canvas (Projects home, history scrubber, code editor)
 * chrome = top level, above the floating chrome (dialogs, sheets)
 */
export const projectsStage: ComponentType[] = [];
export const projectsChrome: ComponentType[] = [];
