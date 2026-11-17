// Round 15: a permanent magnet near a magnetic switch (reed switch, Hall-effect switch). A lid with a
// magnet, a door, a tool in its holder: the sensor sees the flux density of the magnet at its
// distance. Axially magnetised disc magnet, on its axis (the usual "magnet faces the sensor"
// mounting): B(z) = Br/2 * ((z + T) / sqrt(R^2 + (z + T)^2) - z / sqrt(R^2 + z^2)), z from the
// magnet's face. Off-axis and through steel it is weaker: the parts say so in fidelity.json.
import type { PropSpec } from "@fabwright/sim-core";
import type { PropValue } from "@fabwright/project-format";
import { num, str } from "./props.ts";

/** Remanence (T) of common NdFeB grades (typical, from the grade tables of magnet makers). */
export const MAGNET_GRADES: Record<string, number> = { N35: 1.19, N42: 1.3, N52: 1.44, ferrite: 0.39 };

/** Flux density (mT) on the axis of a disc magnet, `z` mm from its face. */
export function discFieldMt(z: number, diameter: number, thickness: number, br: number): number {
  const R = diameter / 2;
  const zz = Math.max(0, z);
  const b = (br / 2) * ((zz + thickness) / Math.hypot(R, zz + thickness) - zz / Math.hypot(R, zz));
  return b * 1000;
}

/** The magnet as the part's props describe it, and its field at `magnet_mm`. */
export function magnetOf(props: Readonly<Record<string, PropValue>>): { distance: number; d: number; t: number; grade: string; mT: number } {
  const distance = num(props.magnet_mm, 40);
  const d = num(props.magnet_d_mm, 6);
  const t = num(props.magnet_t_mm, 3);
  const grade = str(props.magnet_grade, "N35");
  const br = MAGNET_GRADES[grade] ?? MAGNET_GRADES.N35!;
  return { distance, d, t, grade, mT: discFieldMt(distance, d, t, br) };
}

/** The distance (mm) at which the field drops to `mT` (bisection; 0 when it never reaches it). */
export function distanceForField(mT: number, d: number, t: number, br: number): number {
  if (discFieldMt(0, d, t, br) < mT) return 0;
  let lo = 0;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (discFieldMt(mid, d, t, br) >= mT) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The magnet props every magnetic switch part shares (magnet_mm is the live control). */
export const MAGNET_PROP_IDS = ["magnet_mm", "magnet_d_mm", "magnet_t_mm", "magnet_grade"] as const;

/** set {key: "magnet", value: "near" | "away" | true | false | mm}: the lid closes / opens in tests and the UI. */
export function magnetInteraction(e: { kind: string; key?: string; value?: unknown }, near: number, away: number): number | undefined {
  if (e.kind === "press") return near;
  if (e.kind === "release") return away;
  if (e.kind !== "set") return undefined;
  if (e.key !== undefined && e.key !== "magnet" && e.key !== "magnet_mm" && e.key !== "near") return undefined;
  const v = e.value;
  if (typeof v === "number") return e.key === "near" ? (v ? near : away) : v;
  if (v === true || v === "near" || v === "closed" || v === "on") return near;
  if (v === false || v === "away" || v === "open" || v === "off") return away;
  return undefined;
}

export type { PropSpec };
