import type { ComponentType } from "react";
import { CaseView } from "../views/case/CaseView.tsx";
import { useCase } from "./store.ts";

/** Round 6, track "case" (owner): the Case view overlay, opened by the Case button in the top bar. */
function CaseOverlay() {
  const open = useCase((s) => s.open);
  return open ? <CaseView onClose={() => useCase.getState().setOpen(false)} /> : null;
}

export const caseStage: ComponentType[] = [];
export const caseChrome: ComponentType[] = [CaseOverlay];
