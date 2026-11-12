import type { ComponentType } from "react";
import { BuildKitView } from "../views/kit/BuildKitView.tsx";
import { useKit } from "./store.ts";

/** Round 12, track kit (owner): the Build it panel, opened from the Case view and the project menu. */
function KitOverlay() {
  const open = useKit((s) => s.open);
  return open ? <BuildKitView onClose={() => useKit.getState().setOpen(false)} /> : null;
}

export const kitStage: ComponentType[] = [];
export const kitChrome: ComponentType[] = [KitOverlay];
