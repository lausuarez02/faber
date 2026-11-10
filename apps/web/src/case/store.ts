import { create } from "zustand";
import { onProjectSwitch } from "../lib/projectSwitch.ts";

/** Round 6, case track: is the Case view open, and a counter that makes it reload (project switch). */
export interface CaseUi {
  open: boolean;
  /** Bumped on project switch so the view drops the old project's case and reloads. */
  epoch: number;
  setOpen(open: boolean): void;
}

export const useCase = create<CaseUi>((set) => ({
  open: false,
  epoch: 0,
  setOpen: (open) => set({ open }),
}));

// R8: a different project → the Case view shows that project's case (or none); same project re-read → reload.
onProjectSwitch(() => useCase.setState((s) => ({ epoch: s.epoch + 1 })));
