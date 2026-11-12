import { create } from "zustand";
import { onProjectSwitch } from "../lib/projectSwitch.ts";

/** Round 12, kit track: is the Build it panel open, and a counter that makes it reload (project switch). */
export interface KitUi {
  open: boolean;
  epoch: number;
  setOpen(open: boolean): void;
}

export const useKit = create<KitUi>((set) => ({
  open: false,
  epoch: 0,
  setOpen: (open) => set({ open }),
}));

onProjectSwitch(() => useKit.setState((s) => ({ epoch: s.epoch + 1 })));
