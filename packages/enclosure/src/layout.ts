/**
 * Auto-pack a project's parts into a case (decision 0004, "Layout").
 *
 * Case frame: +x right, +y up, +z out of the front. During layout the cavity's front inner plane is
 * z = 0 and the parts go behind it (z < 0); `finish` moves everything so the OUTER bounding box is
 * centred on the origin (R3).
 *
 * 1. Each part gets an orientation: the front part's screen faces +z; a part with an exposed feature
 *    (USB, button, grille, sensor window) turns so that feature faces its case face; others lie flat.
 * 2. Parts are packed front to back (screen first, soft cells last, at the back) with `gap_mm`
 *    around each for wires, trying a few plan rectangles and keeping the smallest case.
 * 3. The cavity plan (rounded rect, stadium, circle, oval) is sized around the parts, allowing for
 *    the rounded front / back edges; connectors get a flat wall.
 * 4. Openings, button plungers, light pipes, screen ribs, standoffs, the cell cradle and screw bosses
 *    are derived from the placed parts.
 */
import type { CasePlacement, CaseShape, Enclosure } from "@jumper/project-format";
import type { PartSpec } from "@jumper/sim-core";
import { apply, envelopeZ, FACE_DIR, faceAxes, I3, type LocalFeature, type Mat3, mul, type PartMech, resolveMech, ROTATIONS, rotAbout, eqv } from "./mech.ts";
import { contains, type Flat, type Need, type Plan, type PlanKind, planBounds, rayExit, sizePlan } from "./plan.ts";
import type { FitCheck, Vec3 } from "./types.ts";

export type CaseFaceName = keyof typeof FACE_DIR;

export interface ResolvedParams {
  wall_mm: number;
  corner_radius_mm: number;
  color: string;
  lanyard_hole: boolean;
  belt_clip: boolean;
  closure: "snap" | "screws";
  tolerance_mm: number;
  process: "fdm" | "resin" | "injection";
  gap_mm: number;
}

export function resolveParams(shape: CaseShape, p: Enclosure["params"] = {}): ResolvedParams {
  return {
    wall_mm: p.wall_mm ?? 1.6,
    corner_radius_mm: p.corner_radius_mm ?? 4,
    color: p.color ?? "#F2EDE4",
    lanyard_hole: p.lanyard_hole ?? shape === "keychain",
    belt_clip: p.belt_clip ?? false,
    closure: p.closure ?? "snap",
    tolerance_mm: p.tolerance_mm ?? (p.process === "resin" ? 0.1 : p.process === "injection" ? 0.05 : 0.2),
    process: p.process ?? "fdm",
    gap_mm: p.gap_mm ?? 1.5,
  };
}

export interface Placed {
  mech: PartMech;
  R: Mat3;
  T: Vec3;
  facing: CaseFaceName;
  rotation: 0 | 90 | 180 | 270;
  layer: number;
  /** Envelope (keep-outs, swell) AABB, case frame. */
  min: Vec3;
  max: Vec3;
  /** Body (dimensions_mm) AABB, case frame. */
  bodyMin: Vec3;
  bodyMax: Vec3;
  bound?: { face: CaseFaceName; feature: LocalFeature; offset: number };
}

export type OpeningKind = "window" | "button" | "connector" | "light-pipe" | "hole" | "grille" | "slot";

export interface Opening {
  part: string;
  feature: string;
  kind: OpeningKind;
  face: CaseFaceName;
  /** Outward normal (case frame). */
  n: Vec3;
  /** Centre on the cavity's inner surface. */
  at: Vec3;
  shape: "rect" | "round";
  /** Opening size (clearance included): u along `uAxis`, v along `vAxis` (round: u = v = d). */
  u: number;
  v: number;
  uAxis: Vec3;
  vAxis: Vec3;
  /** Rounded-slot corner radius for rect openings. */
  corner: number;
  /** Wall thickness along n at this point (outer surface = at + n * depth). */
  depth: number;
  /** Grille: hole centres (case frame) and hole diameter. */
  holes?: { at: Vec3; d: number }[];
  /** Button plunger / light pipe printed as its own body. */
  insert?: { kind: "cap" | "light-pipe"; d: number; flange_d: number; flange_mm: number; length: number; base: Vec3; travel: number; protrude: number };
  /** Distance from the feature to the inner wall surface along n (mm). */
  standoff: number;
}

export interface Rib {
  /** Box in the case frame (min / max), attached to the front ("front") or back ("back") inner wall. */
  min: Vec3;
  max: Vec3;
  shell: "front" | "back";
  why: string;
}

export interface Post {
  x: number;
  y: number;
  /** z range of the post (case frame). */
  z0: number;
  z1: number;
  d: number;
  /** Pin on top that goes into a mounting hole. */
  pin_d?: number;
  shell: "front" | "back";
  why: string;
}

export interface Boss {
  x: number;
  y: number;
  od: number;
}

export interface Layout {
  shape: CaseShape;
  params: ResolvedParams;
  placed: Placed[];
  /** Parts not inside the case: excluded by the person or not physical (chassis). */
  outside: { id: string; why: string }[];
  /** Small passives that live in the wiring (heat-shrink), not packed. */
  inline: string[];
  front?: string;
  plan: Plan;
  kind: PlanKind;
  /** Cavity z range (front inner plane / back inner plane) and outer faces. */
  zFront: number;
  zBack: number;
  /** Outer front / back edge fillet and the cavity's (concentric) one. */
  rf: number;
  ri: number;
  split: number;
  lip: { t: number; h: number; bead: number; groove: number } | null;
  openings: Opening[];
  ribs: Rib[];
  posts: Post[];
  bosses: Boss[];
  cradles: { part: string; min: Vec3; max: Vec3; wall: number; h: number }[];
  /** Keychain / lanyard tab: centre, size, hole. */
  tab?: { x: number; y: number; w: number; h: number; t: number; hole: number; z0: number };
  outer: { w: number; h: number; d: number; min: Vec3; max: Vec3 };
  inner: { w: number; h: number; d: number };
  issues: FitCheck[];
}

const SIDE_FACES: CaseFaceName[] = ["right", "left", "top", "bottom"];

function priority(f: LocalFeature, isFront: boolean): number {
  if (!f.expose) return -1;
  if (f.kind === "screen") return isFront ? 100 : 40;
  return { connector: 90, button: 80, switch: 75, knob: 70, "sensor-window": 60, grille: 50, led: 30, vent: 0, antenna: 0, screen: 40 }[f.kind] ?? 0;
}

/** Distance kept between a feature's tip and the inner wall surface, by kind. */
function tipOffset(f: LocalFeature, tol: number): number {
  switch (f.kind) {
    case "button":
      return 1.0 + tol; // plunger flange + clearance
    case "led":
      return f.passThrough ? 0 : 0.5;
    case "screen":
      return 0;
    case "connector":
      return tol;
    default:
      return f.passThrough ? 0 : tol;
  }
}

interface Box {
  min: Vec3;
  max: Vec3;
}

function overlap(a: Box, b: Box, g: number): boolean {
  return a.min[0] < b.max[0] + g - 1e-9 && b.min[0] < a.max[0] + g - 1e-9 && a.min[1] < b.max[1] + g - 1e-9 && b.min[1] < a.max[1] + g - 1e-9 && a.min[2] < b.max[2] + g - 1e-9 && b.min[2] < a.max[2] + g - 1e-9;
}

/** AABB of the part's local envelope (or body) under R. */
function rotatedBox(m: PartMech, R: Mat3, body = false): Box {
  const [z0, z1] = body ? [0, m.d] : envelopeZ(m);
  const zs = m.soft && !body ? [z0, z1 + m.d * 0.1] : [z0, z1];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [-m.w / 2, m.w / 2])
    for (const y of [-m.h / 2, m.h / 2])
      for (const z of zs) {
        const p = apply(R, [x, y, z]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, p[k]!);
          max[k] = Math.max(max[k]!, p[k]!);
        }
      }
  return { min, max };
}

function rotationDeg(R: Mat3): 0 | 90 | 180 | 270 {
  // angle of local x projected on the case plane / face
  const x = apply(R, [1, 0, 0]);
  if (Math.abs(x[0]) > 0.5) return x[0] > 0 ? 0 : 180;
  if (Math.abs(x[1]) > 0.5) return x[1] > 0 ? 90 : 270;
  return 0;
}

function facingOf(R: Mat3): CaseFaceName {
  const z = apply(R, [0, 0, 1]);
  for (const [k, d] of Object.entries(FACE_DIR)) if (eqv(d, z)) return k as CaseFaceName;
  return "front";
}

interface Plan0 {
  mech: PartMech;
  placement?: CasePlacement;
  bound?: { face: CaseFaceName; feature: LocalFeature; offset: number };
  /** Allowed orientations (packer tries each). */
  Rs: Mat3[];
  isFront: boolean;
}

export interface LayoutInput {
  parts: { id: string; type: string; spec: PartSpec }[];
  enclosure: Enclosure;
}

export function layoutCase(input: LayoutInput): Layout {
  const enc = input.enclosure;
  const shape = enc.shape;
  const params = resolveParams(shape, enc.params);
  const g = params.gap_mm;
  const tol = params.tolerance_mm;
  const t = params.wall_mm;
  const issues: FitCheck[] = [];
  const exclude = new Set(enc.exclude ?? []);
  const outside: Layout["outside"] = [];
  const inline: string[] = [];
  const mechs: PartMech[] = [];
  for (const p of input.parts) {
    if (exclude.has(p.id)) {
      outside.push({ id: p.id, why: "excluded in enclosure.exclude" });
      continue;
    }
    if (p.spec.category === "misc" && !p.spec.pins.length) {
      outside.push({ id: p.id, why: `${p.spec.name} is a frame, not something that goes inside a case` });
      continue;
    }
    if (p.spec.category === "passive" && !p.spec.mechanical) {
      inline.push(p.id);
      continue;
    }
    mechs.push(resolveMech(p.id, p.spec));
  }
  for (const m of mechs)
    if (!m.hasData)
      issues.push({ id: "mechanical-data", ok: true, severity: "warning", message: `${m.id} (${m.type}) has no mechanical data, so the case treats it as a plain ${m.w} × ${m.h} × ${m.d} mm box with nothing exposed. Why: its part.json has no "mechanical" block. Fix: add one (docs/part-spec.md, "Mechanical") or measure the part and pass its features with update_part.`, parts: [m.id] });

  // ---- 1. bindings and orientations
  const frontId = enc.front ?? mechs.find((m) => m.features.some((f) => f.kind === "screen" && f.expose))?.id;
  if (enc.front && !mechs.some((m) => m.id === enc.front)) issues.push({ id: "front", ok: false, severity: "error", message: `The front part "${enc.front}" is not in the case. Why: there is no such part, or it is excluded. Fix: pass front with the id of the display (get_project lists ids).`, parts: [enc.front] });
  const sideCycle: CaseFaceName[] = ["right", "left", "top"];
  let buttonN = 0;
  const plans: Plan0[] = mechs.map((m) => {
    const placement = enc.placements?.[m.id];
    const isFront = m.id === frontId;
    const exposed = m.features.filter((f) => f.expose).sort((a, b) => priority(b, isFront) - priority(a, isFront));
    let primary = exposed[0];
    let face: CaseFaceName | "inside" | undefined = placement?.face;
    if (isFront) {
      primary = m.features.find((f) => f.kind === "screen") ?? primary;
      face = face ?? "front";
    }
    if (face === "inside") primary = undefined;
    else if (primary && !face) {
      switch (primary.kind) {
        case "connector":
          face = "bottom";
          break;
        case "button":
          face = sideCycle[buttonN++ % sideCycle.length];
          break;
        case "switch":
        case "sensor-window":
          face = "top";
          break;
        case "knob":
          face = "right";
          break;
        case "grille":
          face = "back";
          break;
        default:
          face = "front";
      }
    } else if (!primary && face) {
      // a face for a part with nothing exposed: put its top face against that wall
      primary = { id: "top", kind: "vent", n: [0, 0, 1], tip: [0, 0, m.d], shape: "rect", u: m.w, v: m.h, uAxis: [1, 0, 0], vAxis: [0, 1, 0], protrude: 0, bezel: 0, travel: 0, plugClearance: 0, expose: false, passThrough: false };
    }
    if (!primary || !face || face === "inside") return { mech: m, ...(placement ? { placement } : {}), Rs: flatRotations(), isFront };
    const target = FACE_DIR[face];
    let cands = ROTATIONS.filter((R) => eqv(apply(R, primary!.n), target));
    const score = (R: Mat3) => {
      const z = apply(R, [0, 0, 1]);
      const y = apply(R, [0, 1, 0]);
      const x = apply(R, [1, 0, 0]);
      let s = 0;
      if (Math.abs(z[2]) > 0.5) s += 100; // lying flat
      if (z[2] > 0.5) s += 10; // component side to the front
      if (y[1] > 0.5) s += 5; // upright
      if (x[0] > 0.5) s += 2;
      return s;
    };
    cands = cands.sort((a, b) => score(b) - score(a));
    let R = cands[0] ?? I3;
    if (placement?.rotation) R = mul(rotAbout(target, placement.rotation), R);
    return { mech: m, ...(placement ? { placement } : {}), bound: { face, feature: primary, offset: tipOffset(primary, tol) }, Rs: [R], isFront };
  });

  // ---- 2. packing
  const order = [...plans].sort((a, b) => rank(a) - rank(b) || vol(b.mech) - vol(a.mech));
  const front = plans.find((p) => p.isFront);
  const dims = plans.map((p) => {
    const bx = rotatedBox(p.mech, p.Rs[0]!);
    const ex = p.Rs.length > 1 ? Math.min(bx.max[0] - bx.min[0], bx.max[1] - bx.min[1]) : bx.max[0] - bx.min[0];
    const ey = p.Rs.length > 1 ? Math.min(bx.max[0] - bx.min[0], bx.max[1] - bx.min[1]) : bx.max[1] - bx.min[1];
    return [ex, ey] as const;
  });
  const W0 = Math.max(10, ...dims.map((d) => d[0])) + 2 * g;
  const H0 = Math.max(10, ...dims.map((d) => d[1])) + 2 * g;
  type Packed = { placed: Placed[]; score: number; failed: string[] };
  let best: Packed | undefined;
  for (let dw = 0; dw <= 24; dw += 3)
    for (let dh = 0; dh <= 24; dh += 3) {
      const r = pack(order, W0 + dw, H0 + dh, g, front, shape);
      const s = r.failed.length * 1e9 + r.score;
      if (!best || s < best.score) best = { ...r, score: s };
    }
  const placed = best!.placed;
  for (const id of best!.failed) issues.push({ id: "fits", ok: false, severity: "error", message: `${id} could not be packed with the others. Why: its exposed feature is pinned to a face where another part already sits. Fix: move it with placements (e.g. {"${id}": {"face": "left"}}) or exclude it.`, parts: [id] });

  // ---- 3. depth, soft and back-bound parts to the back
  let zBack = Math.min(...placed.map((p) => p.min[2])) - 0.5;
  for (const p of placed) {
    const toBack = p.bound?.face === "back" || (p.mech.soft && !p.bound);
    if (!toBack) continue;
    const want = p.bound ? zBack + p.bound.offset - tipCase(p)[2] : zBack + 0.3 - p.min[2];
    if (want >= 0) continue;
    const moved = shift(p, [0, 0, want]);
    if (!placed.some((q) => q !== p && overlap(q, moved, g - 1e-6))) Object.assign(p, moved);
    else if (p.bound) issues.push({ id: "fits", ok: false, severity: "warning", message: `${p.mech.id}'s ${p.bound.feature.kind} cannot reach the back wall. Why: another part sits behind it. Fix: put it on another face (placements {"${p.mech.id}": {"face": "top"}}).`, parts: [p.mech.id] });
  }
  zBack = Math.min(...placed.map((p) => p.min[2])) - (placed.some((p) => p.bound?.face === "back") ? 0 : 0.3);
  for (const p of placed) if (p.bound?.face === "back") zBack = Math.min(zBack, tipCase(p)[2] - p.bound.offset);
  zBack = Math.min(zBack, -6);
  const zFront = 0;
  const depth = zFront - zBack;

  // layers: order of distinct front z
  const zs = [...new Set(placed.map((p) => Math.round(p.max[2] * 10) / 10))].sort((a, b) => b - a);
  for (const p of placed) p.layer = Math.min(9, zs.indexOf(Math.round(p.max[2] * 10) / 10));

  // ---- 4. split plane and lip
  const lipH = 2.0;
  const lip = { t: Math.max(0.8, Math.min(1.2, t * 0.6)), h: lipH, bead: 0.3, groove: Math.max(0, Math.min(0.4, t - 1.2)) };
  const crossing = (z: number) => placed.filter((p) => p.max[2] > z - lipH && p.min[2] < z).length;
  let split = zBack + depth / 2;
  {
    let bestS = Infinity;
    for (let z = zFront - lipH - 0.5; z >= zBack + 1.5; z -= 0.25) {
      const s = crossing(z) * 10 + Math.abs(z - (zFront + zBack) / 2) * 0.2;
      if (s < bestS) {
        bestS = s;
        split = z;
      }
    }
  }

  // ---- 5. front / back edge fillets
  const D = depth + 2 * t;
  let rf = shape === "pebble" ? 0.42 * D : shape === "pill" ? 0.3 * D : shape === "puck" ? Math.min(2.5, 0.2 * D) : 1.2;
  // straight side band must hold the split lip and every side opening (± 0.6)
  let bandTop = split + 0.6;
  let bandBot = split - lipH - 0.6;
  for (const p of placed)
    if (p.bound && SIDE_FACES.includes(p.bound.face) && p.bound.feature.kind === "connector") {
      const tip = tipCase(p);
      const half = (p.bound.feature.kind === "connector" ? p.bound.feature.v + 2 * p.bound.feature.plugClearance : p.bound.feature.v) / 2;
      bandTop = Math.max(bandTop, tip[2] + half + 0.6);
      bandBot = Math.min(bandBot, tip[2] - half - 0.6);
    }
  rf = Math.max(0.6, Math.min(rf, zFront + t - bandTop, bandBot - (zBack - t)));
  const ri = Math.max(0, rf - t);

  // ---- 6. plan sizing
  const kind: PlanKind = shape === "puck" ? "circle" : shape === "pebble" ? "ellipse" : shape === "pill" ? "stadium" : "rrect";
  const intrusion = (z0: number, z1: number) => {
    if (ri <= 0) return 0;
    const delta = Math.max(0, Math.min(zFront - z1, z0 - zBack));
    if (delta >= ri) return 0;
    return ri - Math.sqrt(ri * ri - (ri - delta) ** 2);
  };
  const lipIntr = Math.max(0, lip.t + tol - g);
  const needs: Need[] = [];
  const flats: Flat[] = [];
  for (const p of placed) {
    const z0 = p.min[2];
    const z1 = p.max[2];
    // + 0.1: the shrunk-outline test is an approximation of the true inward offset the wall is built with
    const inset = intrusion(z0, z1) + (z1 > split - lipH && z0 < split ? lipIntr : 0) + 0.1;
    const side = p.bound && SIDE_FACES.includes(p.bound.face) ? p.bound.face : undefined;
    const pad = (dir: CaseFaceName) => (side === dir ? p.bound!.offset : g);
    const flat = Math.abs(apply(p.R, [0, 0, 1])[2]) > 0.5;
    if (flat) {
      for (const fp of p.mech.footprint) {
        const c = apply(p.R, [fp.cx, fp.cy, 0]);
        const cx = c[0] + p.T[0];
        const cy = c[1] + p.T[1];
        if (fp.shape === "round") {
          for (let i = 0; i < 32; i++) {
            const a = (i / 32) * Math.PI * 2;
            needs.push({ x: cx + Math.cos(a) * (fp.r + g), y: cy + Math.sin(a) * (fp.r + g), inset });
          }
        } else {
          const e = apply(p.R, [fp.hw, fp.hh, 0]);
          const hx = Math.abs(e[0]);
          const hy = Math.abs(e[1]);
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) needs.push({ x: cx + sx * hx + sx * (sx > 0 ? pad("right") : pad("left")), y: cy + sy * hy + sy * (sy > 0 ? pad("top") : pad("bottom")), inset });
        }
      }
    } else {
      for (const sx of [0, 1]) for (const sy of [0, 1]) needs.push({ x: sx ? p.max[0] + pad("right") : p.min[0] - pad("left"), y: sy ? p.max[1] + pad("top") : p.min[1] - pad("bottom"), inset });
    }
    if (side) {
      const tip = tipCase(p);
      const o = p.bound!.offset;
      if (p.bound!.feature.kind === "connector") {
        if (side === "right") flats.push({ axis: "x", sign: 1, at: tip[0] + o });
        if (side === "left") flats.push({ axis: "x", sign: -1, at: tip[0] - o });
        if (side === "top") flats.push({ axis: "y", sign: 1, at: tip[1] + o });
        if (side === "bottom") flats.push({ axis: "y", sign: -1, at: tip[1] - o });
      }
      // the feature itself must reach the wall (curved walls: shifted outward below)
      needs.push({ x: tip[0] + FACE_DIR[side][0] * o, y: tip[1] + FACE_DIR[side][1] * o, inset: 0 });
    }
  }
  // The flats are the wall there: points on a flat's line must not push the curve past it.
  let center: [number, number] | undefined;
  if (kind === "circle" && front) {
    const fp = placed.find((p) => p.mech.id === front.mech.id);
    const scr = fp?.mech.features.find((f) => f.kind === "screen");
    if (fp && scr) {
      const c = toCase(fp, scr.tip);
      center = [c[0], c[1]];
    }
  }
  const cornerCavity = Math.max(0.5, params.corner_radius_mm - t);
  let centerX: number | undefined;
  if (kind === "ellipse" && front) {
    const fp = placed.find((p) => p.mech.id === front.mech.id);
    const scr = fp?.mech.features.find((f) => f.kind === "screen");
    if (fp && scr) centerX = toCase(fp, scr.tip)[0];
  }
  let plan = sizePlan(kind, needs, { ...(center ? { center } : {}), ...(centerX !== undefined ? { centerX } : {}), cornerRadius: cornerCavity });
  plan = { ...plan, flats: mergeFlats(flats) };
  // A flat that is outside the curve does nothing; one that cuts too deep is impossible (the parts are inside it by construction).

  // ---- 7. side-bound non-connector parts move out until the body (not just the cap) meets the wall
  for (const p of placed) {
    if (!p.bound || !SIDE_FACES.includes(p.bound.face) || p.bound.feature.kind === "connector") continue;
    const tip = tipCase(p);
    const n = FACE_DIR[p.bound.face];
    const room = rayExit(plan, tip[0], tip[1], n[0], n[1]) - p.bound.offset;
    const fits = (s: number) => {
      const moved = shift(p, [n[0] * s, n[1] * s, 0]);
      const inset = intrusion(moved.bodyMin[2], moved.bodyMax[2]) + 0.15;
      const t2 = tipCase(moved);
      if (!contains(plan, t2[0] + n[0] * p.bound!.offset, t2[1] + n[1] * p.bound!.offset, 0)) return false;
      for (const x of [moved.bodyMin[0], moved.bodyMax[0]]) for (const y of [moved.bodyMin[1], moved.bodyMax[1]]) if (!contains(plan, x, y, inset)) return false;
      return !placed.some((q) => q !== p && overlap(q, moved, g - 1e-6));
    };
    let lo = 0;
    let hi = Math.max(0, room);
    if (fits(hi)) lo = hi;
    else for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    if (lo > 0.01) Object.assign(p, shift(p, [n[0] * lo, n[1] * lo, 0]));
  }

  // ---- 8. openings
  const openings: Opening[] = [];
  const grown = (off: number): Plan => ({ ...plan, a: plan.a + off, b: plan.b + off, rc: plan.rc + off, flats: plan.flats.map((f) => ({ ...f, at: f.at + f.sign * off })) });
  const outerPlan = grown(t);
  for (const p of placed) {
    for (const f of p.mech.features) {
      if (!f.expose) continue;
      const n = apply(p.R, f.n);
      const face = (Object.entries(FACE_DIR).find(([, d]) => eqv(d, n))?.[0] ?? undefined) as CaseFaceName | undefined;
      const tip = toCase(p, f.tip);
      if (!face) continue;
      // where the inner wall is along n from the tip
      let wallDist: number;
      let at: Vec3;
      if (face === "front") {
        wallDist = zFront - tip[2];
        at = [tip[0], tip[1], zFront];
      } else if (face === "back") {
        wallDist = tip[2] - zBack;
        at = [tip[0], tip[1], zBack];
      } else {
        wallDist = rayExit(plan, tip[0], tip[1], n[0], n[1]);
        at = [tip[0] + n[0] * wallDist, tip[1] + n[1] * wallDist, tip[2]];
      }
      const baseDist = f.passThrough ? wallDist + f.protrude : wallDist;
      const reach = f.kind === "button" ? 8 : f.kind === "led" ? 6 : f.kind === "grille" ? 3 : 1.5;
      if (baseDist < -0.05 - (f.passThrough ? f.protrude : 0) || baseDist > reach + tipOffset(f, tol)) {
        issues.push({ id: f.kind === "connector" ? "connector-access" : f.kind === "button" ? "buttons-reachable" : f.kind === "screen" ? "screen-window" : "exposed", ok: false, severity: f.kind === "connector" || f.kind === "button" || f.kind === "screen" ? "error" : "warning", message: `${p.mech.id}'s ${f.kind} "${f.id}" faces the ${face} but is ${baseDist.toFixed(1)} mm from that wall, so the case cannot expose it. Why: ${baseDist > 0 ? "the curved wall or another part keeps it away from the wall" : "it would poke through the wall"}. Fix: put it on another face with placements ({"${p.mech.id}": {"face": "${face === "right" ? "left" : face === "top" ? "right" : "top"}"}}), try the rounded-box shape, or set "expose": false for that feature if it does not need to be reached.`, parts: [p.mech.id] });
        continue;
      }
      const uAxis = apply(p.R, f.uAxis);
      const vAxis = apply(p.R, f.vAxis);
      const depthAlong = face === "front" || face === "back" ? t : Math.max(t, rayExit(outerPlan, at[0], at[1], n[0], n[1]) + 1e-6);
      const o: Opening = { part: p.mech.id, feature: f.id, kind: "hole", face, n, at, shape: f.shape, u: f.u, v: f.v, uAxis, vAxis, corner: 0, depth: depthAlong, standoff: wallDist };
      switch (f.kind) {
        case "screen": {
          const grow = 2 * Math.min(0.3, f.bezel);
          o.kind = "window";
          o.u = f.u + grow;
          o.v = f.v + grow;
          o.corner = f.shape === "rect" ? 0.5 : 0;
          break;
        }
        case "button": {
          const stem = Math.max(3, Math.min(6, f.u));
          o.kind = "button";
          o.shape = "round";
          o.u = o.v = stem + 2 * tol;
          const protrude = Math.max(1.0, f.travel + 0.6);
          o.insert = { kind: "cap", d: stem, flange_d: stem + 3, flange_mm: 1.0, length: wallDist + depthAlong + protrude, base: tip, travel: f.travel, protrude };
          break;
        }
        case "connector":
          o.kind = "connector";
          o.u = f.u + 2 * f.plugClearance;
          o.v = f.v + 2 * f.plugClearance;
          o.corner = Math.min(o.v / 2 - 0.01, f.connector?.startsWith("usb") ? o.v / 2 - 0.01 : 0.8);
          break;
        case "led":
          if (f.passThrough) {
            o.u = o.v = f.u + 2 * tol;
            o.shape = "round";
          } else {
            o.kind = "light-pipe";
            o.shape = "round";
            o.u = o.v = 3 + 2 * tol;
            o.insert = { kind: "light-pipe", d: 3, flange_d: 4.6, flange_mm: 0.8, length: wallDist + depthAlong - 0.3, base: tip, travel: 0, protrude: 0 };
          }
          break;
        case "grille": {
          o.kind = "grille";
          const gd = Math.max(8, f.u);
          const holes: { at: Vec3; d: number }[] = [{ at, d: 1.5 }];
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const r = gd / 2 - 1.2;
            holes.push({ at: [at[0] + (uAxis[0] * Math.cos(a) + vAxis[0] * Math.sin(a)) * r, at[1] + (uAxis[1] * Math.cos(a) + vAxis[1] * Math.sin(a)) * r, at[2] + (uAxis[2] * Math.cos(a) + vAxis[2] * Math.sin(a)) * r], d: 1.5 });
          }
          o.holes = holes;
          o.u = o.v = gd;
          o.shape = "round";
          break;
        }
        case "switch":
          o.kind = "slot";
          o.u = f.u + f.travel + 2 * tol;
          o.v = f.v + 2 * tol;
          o.corner = 0.5;
          break;
        default:
          o.u = f.u + 2 * tol;
          o.v = f.v + 2 * tol;
      }
      openings.push(o);
    }
  }

  // ---- 9. retention: screen ribs, standoffs, cradle
  const ribs: Rib[] = [];
  const posts: Post[] = [];
  const cradles: Layout["cradles"] = [];
  const boxes: Box[] = placed.map((p) => ({ min: p.min, max: p.max }));
  const freeBox = (b: Box, ignore?: Placed) => !placed.some((p) => p !== ignore && overlap(p, b, 0.3)) && insidePlan(plan, b, intrusion);
  for (const p of placed) {
    const facingZ = apply(p.R, [0, 0, 1])[2];
    const againstFront = p.max[2] >= zFront - 0.5;
    const againstBack = p.min[2] <= zBack + 0.8;
    if (p.mech.soft) {
      if (againstBack) {
        const h = Math.max(1.5, (p.bodyMax[2] - p.bodyMin[2]) * 0.6);
        const c = { min: [p.bodyMin[0] - 0.6, p.bodyMin[1] - 0.6, zBack] as Vec3, max: [p.bodyMax[0] + 0.6, p.bodyMax[1] + 0.6, zBack + h] as Vec3 };
        const ring: Box = { min: [c.min[0] - 1.2, c.min[1] - 1.2, zBack], max: [c.max[0] + 1.2, c.max[1] + 1.2, zBack + h] };
        if (!placed.some((q) => q !== p && overlap(q, ring, 0)) && insidePlan(plan, ring, intrusion)) cradles.push({ part: p.mech.id, min: c.min, max: c.max, wall: 1.2, h });
      }
      continue;
    }
    if (Math.abs(facingZ) < 0.5) continue;
    // Mounting holes: pins from the nearest wall when the column is free.
    if (p.mech.holes.length) {
      for (const hole of p.mech.holes) {
        const c = toCase(p, [hole.x, hole.y, 0]);
        const top = toCase(p, [hole.x, hole.y, p.mech.d]);
        const near = Math.max(c[2], top[2]);
        const far = Math.min(c[2], top[2]);
        const back: Post = { x: c[0], y: c[1], z0: zBack, z1: far, d: hole.d + 2.4, pin_d: hole.d - 0.3, shell: "back", why: `standoff + pin for ${p.mech.id}` };
        const frontP: Post = { x: c[0], y: c[1], z0: near, z1: zFront, d: hole.d + 2.4, pin_d: hole.d - 0.3, shell: "front", why: `standoff + pin for ${p.mech.id}` };
        for (const post of [back, frontP]) {
          if (post.z1 - post.z0 < 0.4) continue;
          const b: Box = { min: [post.x - post.d / 2, post.y - post.d / 2, post.z0], max: [post.x + post.d / 2, post.y + post.d / 2, post.z1] };
          if (!placed.some((q) => q !== p && overlap(q, b, 0.2)) && insidePlan(plan, b, intrusion)) {
            posts.push(post);
            break;
          }
        }
      }
      continue;
    }
    // Locating ribs around parts that sit against the front or back wall (the screen module).
    if (againstFront || againstBack) {
      const shell: "front" | "back" = againstFront ? "front" : "back";
      const z0 = againstFront ? Math.max(p.bodyMin[2], p.bodyMax[2] - 3) : zBack;
      const z1 = againstFront ? zFront : Math.min(p.bodyMax[2], zBack + 3);
      const cx = (p.bodyMin[0] + p.bodyMax[0]) / 2;
      const cy = (p.bodyMin[1] + p.bodyMax[1]) / 2;
      const round = p.mech.footprint.some((f) => f.shape === "round");
      const ribL = 6;
      const cand: Box[] = [];
      const rw = 1.2;
      const c0 = tol;
      if (round) {
        // ribs tangent to the disc at 45° / 135° / 225° / 315° from its centre
        const disc = p.mech.footprint.find((f) => f.shape === "round")!;
        const dc = toCase(p, [disc.cx, disc.cy, 0]);
        for (const a of [45, 135, 225, 315]) {
          const ux = Math.cos((a * Math.PI) / 180);
          const uy = Math.sin((a * Math.PI) / 180);
          const r = disc.r + c0 + (rw / 2) * Math.SQRT2 + 0.05;
          const x = dc[0] + ux * r;
          const y = dc[1] + uy * r;
          cand.push({ min: [x - rw / 2, y - rw / 2, z0], max: [x + rw / 2, y + rw / 2, z1] });
        }
      } else {
        cand.push({ min: [p.bodyMin[0] - c0 - rw, cy - ribL / 2, z0], max: [p.bodyMin[0] - c0, cy + ribL / 2, z1] });
        cand.push({ min: [p.bodyMax[0] + c0, cy - ribL / 2, z0], max: [p.bodyMax[0] + c0 + rw, cy + ribL / 2, z1] });
        cand.push({ min: [cx - ribL / 2, p.bodyMin[1] - c0 - rw, z0], max: [cx + ribL / 2, p.bodyMin[1] - c0, z1] });
        cand.push({ min: [cx - ribL / 2, p.bodyMax[1] + c0, z0], max: [cx + ribL / 2, p.bodyMax[1] + c0 + rw, z1] });
      }
      for (const b of cand) if (freeBox(b, p)) ribs.push({ min: b.min, max: b.max, shell, why: `locates ${p.mech.id}` });
    }
  }
  void boxes;

  // ---- 10. screw bosses
  const bosses: Boss[] = [];
  let closure = params.closure;
  if (closure === "screws") {
    const od = 5.2;
    const cands: Boss[] = [];
    for (let a = 0; a < 360; a += 7.5) {
      const ux = Math.cos((a * Math.PI) / 180);
      const uy = Math.sin((a * Math.PI) / 180);
      const d = rayExit(plan, plan.cx, plan.cy, ux, uy) - od / 2 - 0.2;
      if (d <= 0) continue;
      const b: Boss = { x: plan.cx + ux * d, y: plan.cy + uy * d, od };
      const col: Box = { min: [b.x - od / 2, b.y - od / 2, zBack], max: [b.x + od / 2, b.y + od / 2, zFront] };
      if (!placed.some((q) => overlap(q, col, 0.3)) && ![...openings].some((o) => Math.hypot(o.at[0] - b.x, o.at[1] - b.y) < Math.max(o.u, o.v) / 2 + od / 2 + 0.5)) cands.push(b);
    }
    // up to 4, spread out
    while (bosses.length < 4 && cands.length) {
      let bi = -1;
      let bd = -1;
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i]!;
        const md = bosses.length ? Math.min(...bosses.map((b) => Math.hypot(b.x - c.x, b.y - c.y))) : Math.hypot(c.x - plan.cx, c.y - plan.cy) + (c.x < plan.cx && c.y > plan.cy ? 1 : 0);
        if (md > bd) {
          bd = md;
          bi = i;
        }
      }
      if (bd < 10) break;
      bosses.push(cands.splice(bi, 1)[0]!);
    }
    if (bosses.length < 2) {
      issues.push({ id: "closure", ok: false, severity: "warning", message: `Only ${bosses.length} place${bosses.length === 1 ? "" : "s"} for M2 screw bosses, so the case closes with a snap lip instead. Why: the parts fill the room along the wall where the bosses would go. Fix: use closure "snap", or a larger gap_mm (e.g. 3) so the bosses fit.`, parts: [] });
      bosses.length = 0;
      closure = "snap";
    }
  }

  // ---- 11. tab (keychain / lanyard)
  const ob = planBounds(plan, t);
  let tab: Layout["tab"];
  if (params.lanyard_hole) {
    const tw = shape === "keychain" ? 14 : 10;
    const th = shape === "keychain" ? 12 : 8;
    const tt = Math.min(3.2, Math.max(2.4, (split - zBack) * 0.9));
    tab = { x: plan.cx, y: ob.maxY + th / 2 - 2, w: tw, h: th, t: tt, hole: shape === "keychain" ? 5 : 3.5, z0: zBack - t };
  }

  // ---- 12. finish: centre the outer box on the origin
  const outerMin: Vec3 = [ob.minX, ob.minY, zBack - t];
  const outerMax: Vec3 = [ob.maxX, tab ? Math.max(ob.maxY, tab.y + tab.h / 2) : ob.maxY, zFront + t];
  const c: Vec3 = [(outerMin[0] + outerMax[0]) / 2, (outerMin[1] + outerMax[1]) / 2, (outerMin[2] + outerMax[2]) / 2];
  const mv = (v: Vec3): Vec3 => [v[0] - c[0], v[1] - c[1], v[2] - c[2]];
  for (const p of placed) Object.assign(p, shift(p, [-c[0], -c[1], -c[2]]));
  for (const o of openings) {
    o.at = mv(o.at);
    if (o.holes) for (const h of o.holes) h.at = mv(h.at);
    if (o.insert) o.insert.base = mv(o.insert.base);
  }
  for (const r of ribs) {
    r.min = mv(r.min);
    r.max = mv(r.max);
  }
  for (const p of posts) {
    p.x -= c[0];
    p.y -= c[1];
    p.z0 -= c[2];
    p.z1 -= c[2];
  }
  for (const b of bosses) {
    b.x -= c[0];
    b.y -= c[1];
  }
  for (const cr of cradles) {
    cr.min = mv(cr.min);
    cr.max = mv(cr.max);
  }
  if (tab) {
    tab.x -= c[0];
    tab.y -= c[1];
    tab.z0 -= c[2];
  }
  const finalPlan: Plan = { ...plan, cx: plan.cx - c[0], cy: plan.cy - c[1], flats: plan.flats.map((f) => ({ ...f, at: f.at - (f.axis === "x" ? c[0] : c[1]) })) };
  const ib = planBounds(finalPlan, 0);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    shape,
    params: { ...params, closure },
    placed,
    outside,
    inline,
    ...(frontId ? { front: frontId } : {}),
    plan: finalPlan,
    kind,
    zFront: zFront - c[2],
    zBack: zBack - c[2],
    rf,
    ri,
    split: split - c[2],
    lip: closure === "snap" ? lip : null,
    openings,
    ribs,
    posts,
    bosses,
    cradles,
    ...(tab ? { tab } : {}),
    outer: { w: r1(outerMax[0] - outerMin[0]), h: r1(outerMax[1] - outerMin[1]), d: r1(outerMax[2] - outerMin[2]), min: mv(outerMin), max: mv(outerMax) },
    inner: { w: r1(ib.maxX - ib.minX), h: r1(ib.maxY - ib.minY), d: r1(zFront - zBack) },
    issues,
  };
}

function rank(p: Plan0): number {
  if (p.isFront) return 0;
  if (p.bound && p.bound.face !== "back") return 1;
  if (p.mech.soft) return 4;
  if (p.bound) return 3;
  return 2;
}

function vol(m: PartMech): number {
  return m.w * m.h * (m.d + m.keepTop + m.keepBottom);
}

function flatRotations(): Mat3[] {
  const rz = (deg: number) => rotAbout([0, 0, 1], deg);
  const back = rotAbout([0, 1, 0], 180);
  return [rz(0), rz(90), mul(back, rz(0)), mul(back, rz(90))];
}

export function toCase(p: { R: Mat3; T: Vec3 }, local: Vec3): Vec3 {
  const v = apply(p.R, local);
  return [v[0] + p.T[0], v[1] + p.T[1], v[2] + p.T[2]];
}

function tipCase(p: Placed): Vec3 {
  return toCase(p, p.bound!.feature.tip);
}

function shift(p: Placed, d: Vec3): Placed {
  const add = (v: Vec3): Vec3 => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
  return { ...p, T: add(p.T), min: add(p.min), max: add(p.max), bodyMin: add(p.bodyMin), bodyMax: add(p.bodyMax) };
}

function mergeFlats(fl: Flat[]): Flat[] {
  const out: Flat[] = [];
  for (const f of fl) {
    const same = out.find((o) => o.axis === f.axis && o.sign === f.sign);
    if (!same) out.push({ ...f });
    else same.at = f.sign > 0 ? Math.max(same.at, f.at) : Math.min(same.at, f.at);
  }
  return out;
}

function insidePlan(plan: Plan, b: Box, intrusion: (z0: number, z1: number) => number): boolean {
  const inset = intrusion(b.min[2], b.max[2]) + 0.05;
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) if (!contains(plan, x, y, inset)) return false;
  return true;
}

/** Front-to-back packing in a W × H plan rectangle. */
function isBackGroup(p: Plan0): boolean {
  return p.bound?.face === "back" || (p.mech.soft && !p.bound);
}

/** Best spot for one part. mode "front": stacks back from the front plane z = 0; "back": stacks up from the back plane zB. */
function placeOne(pl: Plan0, placed: Placed[], hw: number, hh: number, g: number, mode: "front" | "back", zB = 0): Placed | undefined {
  let bestP: Placed | undefined;
  let bestS = Infinity;
  for (const R of pl.Rs) {
    const bx = rotatedBox(pl.mech, R);
    const body = rotatedBox(pl.mech, R, true);
    const sx = bx.max[0] - bx.min[0];
    const sy = bx.max[1] - bx.min[1];
    const sz = bx.max[2] - bx.min[2];
    // free coordinates keep a gap to the plan rectangle (the wall, or a connector's flat)
    let xs: number[] = [-hw + g, hw - g - sx, -sx / 2];
    let ys: number[] = [-hh + g, hh - g - sy, -sy / 2];
    // z candidates are the TOP of the box (front mode) or its BOTTOM (back mode)
    let zs: number[] = mode === "front" ? [0] : [zB + 0.3];
    for (const q of placed) {
      xs.push(q.max[0] + g, q.min[0] - g - sx);
      ys.push(q.max[1] + g, q.min[1] - g - sy);
      if (mode === "front") zs.push(q.min[2] - g);
      else if (q.min[2] < zB + sz + g) zs.push(q.max[2] + g);
    }
    const bound = pl.bound;
    const pinned: { x?: number; y?: number; z?: number } = {};
    if (bound) {
      const tip = apply(R, bound.feature.tip);
      const o = bound.offset;
      const face = bound.face;
      const pa = pl.placement;
      const ax = faceAxes(face);
      if (face === "front") pinned.z = 0 - o - (tip[2] - bx.max[2]);
      if (face === "back") pinned.z = zB + o - (tip[2] - bx.min[2]);
      if (face === "right") pinned.x = hw - o - (tip[0] - bx.min[0]);
      if (face === "left") pinned.x = -hw + o - (tip[0] - bx.min[0]);
      if (face === "top") pinned.y = hh - o - (tip[1] - bx.min[1]);
      if (face === "bottom") pinned.y = -hh + o - (tip[1] - bx.min[1]);
      // position along the face: front / back use x_mm / y_mm; sides use the in-plan coordinate
      const offX = pa?.x_mm;
      const offY = pa?.y_mm;
      const along = (k: 0 | 1, v: number) => v - (tip[k] - bx.min[k]);
      if (face === "front" || face === "back") {
        if (pl.isFront || offX !== undefined) pinned.x = along(0, (offX ?? 0) * ax.right[0]);
        if (pl.isFront || offY !== undefined) pinned.y = along(1, offY ?? 0);
      } else if (face === "left" || face === "right") {
        if (offY !== undefined) pinned.y = along(1, offY);
      } else if (offX !== undefined) pinned.x = along(0, offX);
    }
    if (pinned.x !== undefined) xs = [pinned.x];
    if (pinned.y !== undefined) ys = [pinned.y];
    if (pinned.z !== undefined) zs = [pinned.z];
    for (const x0 of xs)
      for (const y0 of ys)
        for (const z of zs) {
          if (pinned.x === undefined && (x0 < -hw + g - 1e-6 || x0 + sx > hw - g + 1e-6)) continue;
          if (pinned.y === undefined && (y0 < -hh + g - 1e-6 || y0 + sy > hh - g + 1e-6)) continue;
          const min: Vec3 = mode === "front" ? [x0, y0, z - sz] : [x0, y0, z];
          const max: Vec3 = mode === "front" ? [x0 + sx, y0 + sy, z] : [x0 + sx, y0 + sy, z + sz];
          if (mode === "back" && max[2] > 0) continue;
          const cand: Box = { min, max };
          if (placed.some((q) => overlap(q, cand, g - 1e-6))) continue;
          const s = mode === "front" ? -Math.min(min[2], ...placed.map((q) => q.min[2])) * 1000 - max[2] * 10 + Math.abs(x0 + sx / 2) * 0.1 + Math.abs(y0 + sy / 2) * 0.1 : max[2] * 100 + Math.abs(x0 + sx / 2) * 0.1 + Math.abs(y0 + sy / 2) * 0.1;
          if (s < bestS) {
            bestS = s;
            const T: Vec3 = [min[0] - bx.min[0], min[1] - bx.min[1], min[2] - bx.min[2]];
            const add = (v: Vec3): Vec3 => [v[0] + T[0], v[1] + T[1], v[2] + T[2]];
            bestP = { mech: pl.mech, R, T, facing: facingOf(R), rotation: rotationDeg(R), layer: 0, min, max, bodyMin: add(body.min), bodyMax: add(body.max), ...(bound ? { bound } : {}) };
          }
        }
  }
  return bestP;
}

/** Front stack (screen, boards, side parts) from the front plane, then the back group (cells, back grilles) from the back wall, as shallow as both allow. */
function pack(order: Plan0[], W: number, H: number, g: number, front: Plan0 | undefined, shape: CaseShape): { placed: Placed[]; score: number; failed: string[] } {
  const placed: Placed[] = [];
  const failed: string[] = [];
  const hw = W / 2;
  const hh = H / 2;
  for (const pl of order.filter((p) => !isBackGroup(p))) {
    const p = placeOne(pl, placed, hw, hh, g, "front");
    if (p) placed.push(p);
    else failed.push(pl.mech.id);
  }
  const back = order.filter(isBackGroup);
  if (back.length) {
    const depthA = placed.length ? -Math.min(...placed.map((q) => q.min[2])) : 0;
    let done = false;
    for (let D = Math.max(depthA, 4); D <= depthA + 60 && !done; D += 0.5) {
      const trial: Placed[] = [];
      let ok = true;
      for (const pl of back) {
        const p = placeOne(pl, [...placed, ...trial], hw, hh, g, "back", -D);
        if (!p) {
          ok = false;
          break;
        }
        trial.push(p);
      }
      if (ok) {
        placed.push(...trial);
        done = true;
      }
    }
    if (!done) failed.push(...back.map((p) => p.mech.id));
  }
  void front;
  // score: the case's rough volume (plan area of the shape around the contents × depth)
  const minV: Vec3 = [Infinity, Infinity, Infinity];
  const maxV: Vec3 = [-Infinity, -Infinity, -Infinity];
  let rMax = 0;
  for (const p of placed) {
    for (let k = 0; k < 3; k++) {
      minV[k] = Math.min(minV[k]!, p.min[k]!);
      maxV[k] = Math.max(maxV[k]!, p.max[k]!);
    }
    for (const x of [p.min[0] - g, p.max[0] + g]) for (const y of [p.min[1] - g, p.max[1] + g]) rMax = Math.max(rMax, Math.hypot(x, y));
  }
  const w = maxV[0] - minV[0] + 2 * g;
  const h = maxV[1] - minV[1] + 2 * g;
  const d = maxV[2] - minV[2] + 2;
  const hx = Math.max(Math.abs(minV[0]), Math.abs(maxV[0])) + g;
  const area = shape === "puck" ? Math.PI * rMax * rMax : shape === "pebble" ? 2 * Math.PI * hx * (h / 2) * 0.8 : shape === "pill" ? w * h * 0.95 : w * h;
  // estimated outer size, to prefer layouts that fit a pocket (110 x 70 x 30 mm)
  const ow = (shape === "puck" ? 2 * rMax : shape === "pebble" ? 2 * hx * 1.2 : w) + 3.2;
  const oh = (shape === "puck" ? 2 * rMax : shape === "pebble" ? h * 1.2 : h) + 3.2;
  const od = d + 3.2;
  const pocket = Math.max(Math.min(ow, oh) / 70, Math.max(ow, oh) / 110, od / 30);
  const score = area * d * (pocket > 1 ? pocket : 1) + Math.max(w, h) * 5;
  return { placed, score, failed };
}
