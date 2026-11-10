import type { PartDefinition, PropSpec } from "@jumper/sim-core";

/**
 * What a running part responds to (round 5, live track). Derived from the part's spec, so new parts
 * (and agent-made ones) get controls without code here:
 *   button  a "pressed" binding (pushbutton, keypad key, digital-input custom parts): pointer down/up
 *   toggle  a 0..1 "position" with step 1 (slide switch): click flips it
 *   knob    a continuous 0..1 "position" (potentiometer): drag turns it, the part does not move
 * IMU parts (accelX/Y/Z) get the tilt / shake / drop / spin pad; sensors get value sliders.
 */
export type ControlKind = "button" | "toggle" | "knob";

const IMU_AXES = ["accelX", "accelY", "accelZ"];

function positionProp(def: PartDefinition): PropSpec | undefined {
  return def.spec.props?.find((p) => p.id === "position" && p.type === "number" && (p.min ?? 0) === 0 && (p.max ?? 1) === 1);
}

export function controlOf(def: PartDefinition | undefined): ControlKind | undefined {
  if (!def || def.spec.mcu) return undefined;
  const pos = positionProp(def);
  if (pos) return pos.step === 1 ? "toggle" : "knob";
  if (def.spec.bindings?.some((b) => b.key === "pressed")) return "button";
  if (def.spec.category === "input" && /button|switch|key/i.test(def.spec.id)) return "button";
  return undefined;
}

export function isImu(def: PartDefinition | undefined): boolean {
  const ids = new Set(def?.spec.props?.map((p) => p.id));
  return IMU_AXES.every((a) => ids.has(a));
}

/** Units that describe how a part is built, not what it measures (no live slider for those). */
const CONFIG_UNITS = new Set(["Ω", "V", "A", "ms", "µs", "us", "rpm", "s/60°"]);
const CONFIG_IDS = /^(resistance|address|preset|baud|internalResistance|min|max|initial|rated|wheel|track|mass|length|width|sensorOffset|startTime)/i;

/**
 * Number props a person may set while the device runs: what a sensor measures (distance, lux,
 * temperature, humidity, pressure, soil moisture…). IMU axes are left to the IMU pad; a knob's
 * position to the knob itself.
 */
export function sensorProps(def: PartDefinition | undefined): PropSpec[] {
  if (!def || def.spec.mcu) return [];
  const cat = def.spec.category;
  if (cat !== "sensor" && cat !== "input") return [];
  const imu = isImu(def);
  return (def.spec.props ?? []).filter((p) => {
    if (p.type !== "number") return false;
    if (p.id === "position" && controlOf(def)) return false;
    if (imu && /^(accel|gyro)[XYZ]$/.test(p.id)) return false;
    if (p.unit && CONFIG_UNITS.has(p.unit)) return false;
    if (CONFIG_IDS.test(p.id)) return false;
    return p.min !== undefined && p.max !== undefined;
  });
}

/** Knob drag: right / up turns it up. 160 px of travel is the full range. */
export function knobValue(start: number, dx: number, dy: number, px = 160): number {
  return Math.min(1, Math.max(0, start + (dx - dy) / px));
}

/**
 * Gravity in g on the sensor axes for a board tilted by `pitch` (nose up, about X) and `roll`
 * (right side down, about Y), in degrees. Flat = (0, 0, 1).
 */
export function tiltToAccel(pitchDeg: number, rollDeg: number): { x: number; y: number; z: number } {
  const p = (pitchDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { x: round(-Math.sin(r) * Math.cos(p)), y: round(Math.sin(p)), z: round(Math.cos(r) * Math.cos(p)) };
}

// ---- round 6, canvas track ----------------------------------------------------------------------

/** A quick click still holds a button this long (virtual ms and wall ms), so firmware debouncing sees it and the cap is seen pressed. */
export const MIN_PRESS_MS = 120;

/** IMU axes a motion writes. */
export type ImuAxes = Partial<Record<"accelX" | "accelY" | "accelZ" | "gyroX" | "gyroY" | "gyroZ", number>>;
export type ImuMotionKind = "shake" | "drop" | "spin";

/** Length of a motion played by a click (virtual ms). Shake takes the person's duration setting. */
export const MOTION_MS: Record<ImuMotionKind, number> = { shake: 1000, drop: 520, spin: 1000 };
export const SHAKE_DURATIONS_MS = [500, 1000, 2000, 5000] as const;

/**
 * IMU values `t` virtual ms into a motion, around a resting gravity vector `base` (from the tilt).
 * Approximate on purpose: the shapes firmware usually detects (a 7 Hz ±2.2 g looping shake,
 * 0.4 s of free fall then a 6 g bump, a 360 °/s spin around Z), not a model of a hand.
 */
export function motionSample(kind: ImuMotionKind, t: number, base: { x: number; y: number; z: number }): ImuAxes {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  if (kind === "shake") {
    // A hand shakes in a loop, not a straight line: ±2.2 g side to side with ±1.6 g back and forth a
    // quarter turn later, and the wrist turning at 250 °/s. So |a| stays ≥ 1.8 g and the rotation
    // stays at 250 °/s the whole time, as firmware that counts "shaking for 1.2 s" expects (round
    // 6b: the old straight-line swing crossed 1 g and 0 °/s 14 times a second, and the Muse never
    // got dizzy).
    const ph = (t / 1000) * 2 * Math.PI * 7;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    return { accelX: r(base.x + 2.2 * s), accelY: r(base.y + 1.6 * c), accelZ: r(base.z), gyroX: r(250 * c), gyroY: 0, gyroZ: r(250 * s) };
  }
  if (kind === "drop") {
    if (t < 400) return { accelX: 0, accelY: 0, accelZ: 0, gyroX: 0, gyroY: 0, gyroZ: 0 };
    return { accelX: r(base.x * 0.5), accelY: r(base.y * 0.5), accelZ: 6, gyroX: 120, gyroY: -80, gyroZ: 0 };
  }
  return { accelX: r(base.x), accelY: r(base.y), accelZ: r(base.z), gyroX: 0, gyroY: 0, gyroZ: 360 };
}

/** The resting values after a motion: gravity from the tilt, no rotation. */
export function restAxes(base: { x: number; y: number; z: number }): ImuAxes {
  return { accelX: base.x, accelY: base.y, accelZ: base.z, gyroX: 0, gyroY: 0, gyroZ: 0 };
}

export const MAX_TILT = 60;

/** Dragging an IMU part tilts it: right rolls right, up pitches the nose up; 2 px per degree. */
export function tiltFromDrag(start: { pitch: number; roll: number }, dx: number, dy: number): { pitch: number; roll: number } {
  const clamp = (v: number) => Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.round(v)));
  return { pitch: clamp(start.pitch - dy / 2), roll: clamp(start.roll + dx / 2) };
}

/**
 * Where on a part's drawing the control is (the cap, the lever, the knob, the touch pad), found by
 * the SVG bindings that move it. Parts can mark it explicitly with `data-control` on any element.
 * Anything else on the part (its body, its label) selects and drags the part as usual.
 */
export const CONTROL_SELECTORS: Record<ControlKind, string> = {
  button: '[data-control], [data-bind*="transform:capTransform"], [data-bind*="transform:leverTransform"], [data-bind*="opacity:padOpacity"], [data-bind*="visible:pressed"]',
  toggle: '[data-control], [data-bind*="transform:knobTransform"], [data-bind*="transform:slider"]',
  knob: '[data-control], [data-bind*="transform:knobTransform"]',
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The hit area for a control: the element's box grown by `pad` and at least `min` square (a finger
 * or a quick mouse click must land on it), kept inside the part. Falls back to the middle of the
 * part when the drawing has no recognisable control.
 */
export function controlHitRect(found: Rect | undefined, box: { w: number; h: number }, pad = 6, min = 30): Rect {
  const r = found ?? { x: box.w * 0.2 + pad, y: box.h * 0.2 + pad, w: box.w * 0.6 - 2 * pad, h: box.h * 0.6 - 2 * pad };
  let w = Math.max(min, r.w + 2 * pad);
  let h = Math.max(min, r.h + 2 * pad);
  w = Math.min(w, box.w);
  h = Math.min(h, box.h);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x = Math.max(0, Math.min(box.w - w, cx - w / 2));
  const y = Math.max(0, Math.min(box.h - h, cy - h / 2));
  const round = (v: number) => Math.round(v * 10) / 10;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}
