import { engine } from "../lib/app.ts";
import { tiltToAccel } from "./controls.ts";

/**
 * Motions for IMU parts (MPU6050 and any part with accelX/Y/Z + gyroX/Y/Z props), played as a
 * short sequence of values on wall-clock time while the device runs. Approximate on purpose: the
 * shapes (a shake, a free fall then an impact, a spin) are what firmware usually detects, not a
 * physical model of a hand. Simulation-only, like set_sensor_value.
 */

export type ImuMotion = "shake" | "drop" | "spin";

const timers = new Map<string, ReturnType<typeof setInterval>>();

function setAxes(part: string, v: Partial<Record<"accelX" | "accelY" | "accelZ" | "gyroX" | "gyroY" | "gyroZ", number>>): void {
  for (const [k, val] of Object.entries(v)) engine.setLiveValue(part, k, Math.round(val * 1000) / 1000);
}

export function tilt(part: string, pitch: number, roll: number): void {
  const a = tiltToAccel(pitch, roll);
  setAxes(part, { accelX: a.x, accelY: a.y, accelZ: a.z });
}

/** Play a motion, then return to the resting tilt. */
export function playMotion(part: string, motion: ImuMotion, rest: { pitch: number; roll: number }): void {
  clearInterval(timers.get(part));
  const base = tiltToAccel(rest.pitch, rest.roll);
  const t0 = performance.now();
  const len = motion === "shake" ? 800 : motion === "drop" ? 520 : 1000;
  const tick = () => {
    const t = performance.now() - t0;
    if (t >= len) {
      clearInterval(timers.get(part));
      timers.delete(part);
      setAxes(part, { accelX: base.x, accelY: base.y, accelZ: base.z, gyroX: 0, gyroY: 0, gyroZ: 0 });
      return;
    }
    if (motion === "shake") {
      const w = Math.sin((t / 1000) * 2 * Math.PI * 7);
      setAxes(part, { accelX: base.x + 2.2 * w, accelY: base.y + 0.6 * Math.cos((t / 1000) * 2 * Math.PI * 5), accelZ: base.z, gyroZ: 250 * w });
    } else if (motion === "drop") {
      // ~0.4 s of free fall (all axes near 0 g), then a short impact spike.
      if (t < 400) setAxes(part, { accelX: 0, accelY: 0, accelZ: 0, gyroX: 0, gyroY: 0, gyroZ: 0 });
      else setAxes(part, { accelX: base.x * 0.5, accelY: base.y * 0.5, accelZ: 6, gyroX: 120, gyroY: -80 });
    } else {
      setAxes(part, { accelX: base.x, accelY: base.y, accelZ: base.z, gyroZ: 360 });
    }
  };
  tick();
  timers.set(part, setInterval(tick, 30));
}
