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
