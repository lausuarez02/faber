import { engine } from "../lib/app.ts";
import { MOTION_MS, motionSample, restAxes, tiltToAccel, type ImuAxes, type ImuMotionKind } from "./controls.ts";
import { setMotionState, setTiltState, useInteract } from "./store.ts";

/**
 * Motions for IMU parts (MPU6050 and any part with accelX/Y/Z + gyroX/Y/Z props). Round 6: they
 * play on the simulation's virtual clock (engine.addSimTicker), so a 1 s shake is 1 s for the
 * firmware at any speed, and nothing moves while the simulation is paused. Approximate on purpose
 * (see motionSample). Simulation-only, like set_sensor_value.
 */

export type ImuMotion = ImuMotionKind;

interface Playing {
  stop(): void;
  release(): void;
}

const playing = new Map<string, Playing>();

function restOf(part: string): { pitch: number; roll: number } {
  return useInteract.getState().tilt[part] ?? { pitch: 0, roll: 0 };
}

function setAxes(part: string, v: ImuAxes): void {
  for (const [k, val] of Object.entries(v)) engine.setLiveValue(part, k, Math.round(val * 1000) / 1000);
}

/** Set the resting tilt (degrees); a motion that is playing keeps going around the new rest. */
export function tilt(part: string, pitch: number, roll: number): void {
  setTiltState(part, { pitch, roll });
  if (playing.has(part)) return;
  const a = tiltToAccel(pitch, roll);
  setAxes(part, { accelX: a.x, accelY: a.y, accelZ: a.z });
}

/**
 * Play a motion on the virtual clock. `hold: true` (a held Shake button) keeps it going until
 * release(); a short press plays `durationMs`. Returns the handle (release / stop).
 */
export function playMotion(part: string, kind: ImuMotion, opts: { durationMs?: number; hold?: boolean } = {}): Playing {
  playing.get(part)?.stop();
  const length = Math.max(50, opts.durationMs ?? MOTION_MS[kind]);
  let end = opts.hold ? Infinity : length;
  let start: number | undefined;
  let elapsed = 0;
  let done = false;
  const pressedAt = performance.now();
  const finish = () => {
    if (done) return;
    done = true;
    off();
    playing.delete(part);
    setMotionState(part, undefined);
    const r = restOf(part);
    const base = tiltToAccel(r.pitch, r.roll);
    if (useInteract.getState().active) setAxes(part, restAxes(base));
  };
  const off = engine.addSimTicker((t) => {
    start ??= t;
    elapsed = t - start;
    if (elapsed >= end) {
      finish();
      return false;
    }
    const r = restOf(part);
    engine.setSimValues(part, motionSample(kind, elapsed, tiltToAccel(r.pitch, r.roll)) as Record<string, number>);
    return true;
  });
  setMotionState(part, kind);
  const handle: Playing = {
    stop: finish,
    release() {
      if (done || end !== Infinity) return;
      // A tap plays the set duration; a hold shook for as long as it was held.
      end = performance.now() - pressedAt < 300 ? length : Math.max(elapsed, 1);
    },
  };
  playing.set(part, handle);
  return handle;
}

export function stopMotions(): void {
  for (const p of [...playing.values()]) p.stop();
}
