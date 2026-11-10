import { create } from "zustand";
import type { VersionDetail } from "./api.ts";

/** UI state of the projects track: the Projects home, the History view and the code editor. */
export interface ProjectsUi {
  /** The Projects home (gallery) is open. */
  home: boolean;
  /** The History view (timeline scrubber) is open. */
  history: boolean;
  /** The code editor drawer: open, the file to show, and an optional read-only version snapshot. */
  code: { open: boolean; path?: string; snapshot?: { version: number; files: Record<string, string> } };
  /** Bumped whenever the project may have changed on the server (refetch history / files). */
  tick: number;
  setHome(v: boolean): void;
  setHistory(v: boolean): void;
  openCode(path?: string, snapshot?: { version: number; files: Record<string, string> }): void;
  closeCode(): void;
  bump(): void;
}

export const useProjectsUi = create<ProjectsUi>()((set, get) => ({
  home: false,
  history: false,
  code: { open: false },
  tick: 0,
  setHome: (home) => set({ home, ...(home ? { history: false } : {}) }),
  setHistory: (history) => set({ history, ...(history ? { home: false } : {}) }),
  openCode: (path, snapshot) => set({ code: { open: true, ...(path ? { path } : {}), ...(snapshot ? { snapshot } : {}) } }),
  closeCode: () => set({ code: { open: false } }),
  bump: () => set({ tick: get().tick + 1 }),
}));

export type { VersionDetail };
