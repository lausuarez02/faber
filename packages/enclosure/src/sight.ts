/**
 * Round 8b: what you see through the screen window.
 *
 * Round 8's screen-window check compared only sizes (window vs active area), so a window cut where
 * the display is not, or another part sitting between the window and the display, still passed.
 * This test looks through the window: rays straight in through a grid of points over the window
 * (where it overlaps the active area's size) must hit the front part first, inside its active area.
 */
import { apply } from "./mech.ts";
import type { Layout } from "./layout.ts";
import type { Vec3 } from "./types.ts";

export interface WindowSight {
  ok: boolean;
  /** Points looked through. */
  samples: number;
  /** Points that see the display's active area. */
  seen: number;
  /** What the other points see first (part id, or "nothing" = the empty inside / the other shell). */
  blocked: { by: string; count: number }[];
  /** Window centre minus the active area's centre, in the window plane (mm). */
  offset_mm: number;
  message: string;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** Entry distance of the ray o + t d into the box, or undefined. */
function rayBox(o: Vec3, d: Vec3, lo: Vec3, hi: Vec3): number | undefined {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) {
      if (o[k]! < lo[k]! - 1e-9 || o[k]! > hi[k]! + 1e-9) return undefined;
      continue;
    }
    let a = (lo[k]! - o[k]!) / d[k]!;
    let b = (hi[k]! - o[k]!) / d[k]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return undefined;
  }
  return t1 < 0 ? undefined : Math.max(0, t0);
}

/** Look through the front part's screen window (undefined when the case has no window or no screen). */
export function windowSight(L: Pick<Layout, "front" | "placed" | "openings">, grid: [number, number] = [7, 5]): WindowSight | undefined {
  const fp = L.front ? L.placed.find((p) => p.mech.id === L.front) : undefined;
  const win = L.openings.find((o) => o.kind === "window" && o.part === L.front);
  const scr = fp?.mech.features.find((f) => f.kind === "screen");
  if (!fp || !win || !scr) return undefined;
  const at = (v: Vec3): Vec3 => {
    const r = apply(fp.R, v);
    return [r[0] + fp.T[0], r[1] + fp.T[1], r[2] + fp.T[2]];
  };
  const c = at(scr.tip);
  const uA = apply(fp.R, scr.uAxis);
  const vA = apply(fp.R, scr.vAxis);
  const n = win.n;
  // the window's centre against the active area's, in the window plane
  const dc = sub(win.at, c);
  const offU = dot(dc, win.uAxis);
  const offV = dot(dc, win.vAxis);
  const offset_mm = Math.hypot(offU, offV);
  // the active area's extent along the window's axes (it may be turned 90° in the case)
  const extU = Math.abs(dot(uA, win.uAxis)) * scr.u + Math.abs(dot(vA, win.uAxis)) * scr.v;
  const extV = Math.abs(dot(uA, win.vAxis)) * scr.u + Math.abs(dot(vA, win.vAxis)) * scr.v;
  const hu = (Math.min(win.u, extU) / 2) * 0.9;
  const hv = (Math.min(win.v, extV) / 2) * 0.9;
  const round = win.shape === "round" || scr.shape === "round";
  const blocked = new Map<string, number>();
  let samples = 0;
  let seen = 0;
  for (let i = 0; i < grid[0]; i++)
    for (let j = 0; j < grid[1]; j++) {
      const a = grid[0] > 1 ? -1 + (2 * i) / (grid[0] - 1) : 0;
      const b = grid[1] > 1 ? -1 + (2 * j) / (grid[1] - 1) : 0;
      if (round && a * a + b * b > 1) continue;
      samples++;
      // from just outside the wall, straight in
      const p0 = add(add(add(win.at, win.uAxis, a * hu), win.vAxis, b * hv), n, win.depth + 2);
      const d: Vec3 = [-n[0], -n[1], -n[2]];
      let best: { id: string; t: number } | undefined;
      for (const q of L.placed) {
        const t = rayBox(p0, d, q.bodyMin, q.bodyMax);
        if (t !== undefined && (!best || t < best.t - 1e-9)) best = { id: q.mech.id, t };
      }
      if (best?.id === fp.mech.id) {
        const hit = add(p0, d, best.t);
        const r = sub(hit, c);
        const du = dot(r, uA);
        const dv = dot(r, vA);
        const inside = scr.shape === "round" ? Math.hypot(du, dv) <= scr.u / 2 + 0.05 : Math.abs(du) <= scr.u / 2 + 0.05 && Math.abs(dv) <= scr.v / 2 + 0.05;
        if (inside) {
          seen++;
          continue;
        }
        blocked.set(`${fp.mech.id}'s border (outside its active area)`, (blocked.get(`${fp.mech.id}'s border (outside its active area)`) ?? 0) + 1);
        continue;
      }
      const by = best?.id ?? "nothing";
      blocked.set(by, (blocked.get(by) ?? 0) + 1);
    }
  const ok = seen === samples && offset_mm <= 0.5;
  const list = [...blocked.entries()].sort((x, y) => y[1] - x[1]).map(([by, count]) => ({ by, count }));
  const message = ok
    ? `${fp.mech.id}'s active area is behind the window: ${seen} of ${samples} lines of sight through it land on the screen, window centred within ${offset_mm.toFixed(2)} mm.`
    : `The screen window does not show ${fp.mech.id}'s active area: ${samples - seen} of ${samples} lines of sight through it land on ${list.map((b) => (b.by === "nothing" ? "nothing (the empty inside)" : b.by)).join(", ")}${offset_mm > 0.5 ? `, and the window is ${offset_mm.toFixed(1)} mm off the screen's centre` : ""}. Why: ${list.some((b) => b.by !== "nothing" && !b.by.includes("border")) ? "another part sits between the window and the screen" : "the window is not cut where the screen is"}. Fix: design the case again; if it persists, pin the screen with placements {"${fp.mech.id}": {"face": "front"}} and report it.`;
  return { ok, samples, seen, blocked: list, offset_mm: Math.round(offset_mm * 100) / 100, message };
}
