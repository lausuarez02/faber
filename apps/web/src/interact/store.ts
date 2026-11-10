import { create } from "zustand";
import type { PropValue } from "@jumper/project-format";

/**
 * Live interaction state (round 5, live track; round 6, canvas track): whether the page's own
 * simulation exists (so parts take presses, knob turns and sensor values instead of drags), and the
 * values the person set while it runs. Values are simulation-only, like the agent's
 * set_sensor_value: jumper.json never changes.
 */
export interface InteractState {
  /** A local simulation exists (running or paused) and takes input. */
  active: boolean;
  /** part id → prop id → value the person set (re-applied when the simulation restarts). */
  values: Record<string, Record<string, PropValue>>;
  /** Parts held down right now (pushbuttons), including the short minimum press after a quick click. */
  held: Record<string, boolean>;
  /** Resting tilt of each IMU part (degrees), shared by the tilt pad and dragging the part itself. */
  tilt: Record<string, { pitch: number; roll: number }>;
  /** IMU motion playing right now (part id → motion). */
  motion: Record<string, "shake" | "drop" | "spin">;
  /**
   * Round 6: "Arrange" while the device runs. Off (default): a click on a button cap presses it, a
   * knob drag turns it, an IMU drag tilts it. On: every part selects and drags as when stopped.
   */
  arrange: boolean;
}

export const useInteract = create<InteractState>()(() => ({ active: false, values: {}, held: {}, tilt: {}, motion: {}, arrange: false }));

export function setHeld(part: string, on: boolean): void {
  const held = { ...useInteract.getState().held };
  if (on) held[part] = true;
  else delete held[part];
  useInteract.setState({ held });
}

export function setTiltState(part: string, t: { pitch: number; roll: number }): void {
  useInteract.setState({ tilt: { ...useInteract.getState().tilt, [part]: t } });
}

export function setMotionState(part: string, m: "shake" | "drop" | "spin" | undefined): void {
  const motion = { ...useInteract.getState().motion };
  if (m) motion[part] = m;
  else delete motion[part];
  useInteract.setState({ motion });
}

export function setArrange(on: boolean): void {
  useInteract.setState({ arrange: on });
}
