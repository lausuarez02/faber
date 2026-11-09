import { create } from "zustand";
import type { PropValue } from "@jumper/project-format";

/**
 * Live interaction state (round 5, live track): whether the page's own simulation exists (so parts
 * take presses, knob turns and sensor values instead of drags), and the values the person set while
 * it runs. Values are simulation-only, like the agent's set_sensor_value: jumper.json never changes.
 */
export interface InteractState {
  /** A local simulation exists (running or paused) and takes input. */
  active: boolean;
  /** part id → prop id → value the person set (re-applied when the simulation restarts). */
  values: Record<string, Record<string, PropValue>>;
  /** Parts held down right now (pushbuttons). */
  held: Record<string, boolean>;
}

export const useInteract = create<InteractState>()(() => ({ active: false, values: {}, held: {} }));

export function setHeld(part: string, on: boolean): void {
  const held = { ...useInteract.getState().held };
  if (on) held[part] = true;
  else delete held[part];
  useInteract.setState({ held });
}
