import { useSyncExternalStore } from "react";
import { create } from "zustand";

/** UI-only state of the v2 shell: the active tool, which floating panels are open, which popover. */

export type Tool = "select" | "hand" | "wire";

/** Floating panels (right column on desktop, bottom sheet on phones), in their stacking order. */
export const PANEL_ORDER = ["agent", "inspector", "serial", "tests", "network", "firmware", "instruments", "help", "learn"] as const;
export type PanelId = (typeof PANEL_ORDER)[number];

export type PopoverId = "parts" | "jump" | "more" | "project" | "mcp" | "agent-menu" | "phone-menu" | null;

export const PHONE_QUERY = "(max-width: 820px)";
export const isPhone = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

export interface UiState {
  tool: Tool;
  panels: PanelId[];
  popover: PopoverId;
  railExpanded: boolean;
  device: boolean;
  /** The inspector was opened by a selection (closes again when the selection clears). */
  inspectorAuto: boolean;
  setTool(t: Tool): void;
  openPanel(id: PanelId, opts?: { auto?: boolean }): void;
  closePanel(id: PanelId): void;
  togglePanel(id: PanelId): void;
  setPopover(p: PopoverId): void;
  togglePopover(p: Exclude<PopoverId, null>): void;
  setRailExpanded(v: boolean): void;
  setDevice(v: boolean): void;
}

export const useUi = create<UiState>()((set, get) => ({
  tool: "select",
  panels: [],
  popover: null,
  railExpanded: false,
  device: false,
  inspectorAuto: false,
  setTool: (tool) => set({ tool }),
  openPanel(id, opts) {
    const { panels } = get();
    const auto = id === "inspector" ? !!opts?.auto : get().inspectorAuto;
    if (panels.includes(id)) {
      if (id === "inspector" && !opts?.auto) set({ inspectorAuto: false });
      return;
    }
    // Phones show one sheet at a time.
    set({ panels: isPhone() ? [id] : [...panels, id], inspectorAuto: auto, popover: isPhone() ? null : get().popover });
  },
  closePanel(id) {
    set({ panels: get().panels.filter((p) => p !== id), ...(id === "inspector" ? { inspectorAuto: false } : {}) });
  },
  togglePanel(id) {
    if (get().panels.includes(id)) get().closePanel(id);
    else get().openPanel(id);
  },
  setPopover: (popover) => set({ popover }),
  togglePopover: (p) => set({ popover: get().popover === p ? null : p }),
  setRailExpanded: (railExpanded) => set({ railExpanded }),
  setDevice: (device) => set({ device, popover: null }),
}));

/** True on phone-width viewports; re-renders when crossing the breakpoint. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (fn) => {
      if (typeof matchMedia !== "function") return () => {};
      const mq = matchMedia(PHONE_QUERY);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    isPhone,
    () => false,
  );
}
