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
import type { CasePlacement, CaseShape, Enclosure } from "@faber/project-format";
import type { PartSpec } from "@faber/sim-core";
import { apply, envelopeZ, FACE_DIR, faceAxes, I3, type LocalFeature, type Mat3, mul, type PartMech, resolveMech, ROTATIONS, rotAbout, eqv } from "./mech.ts";
import { contains, type Flat, growPlan, withFastOutline, type Need, outline, type Plan, type PlanKind, planBounds, polyDistance, polyOuter, rayExit, sizePlan, sizePoly } from "./plan.ts";
import { outlineFeatureIssues, parseOutline, presetOutline, presetPoints, type ParsedOutline } from "./outline.ts";
import type { FitCheck, Vec3 } from "./types.ts";
import { designMounts } from "./mounts.ts";
import { isHeldMech, isHeldType, SLEEVE_WALL_MM, type HeldReport } from "./held.ts";
import { sleeveFor, withHeld } from "./held-layout.ts";
import { depthCandidates, hashSeed, type OEnv, type OItem, type OVariant, radialOf, searchAtDepth, type ZMode } from "./optimize.ts";

/** Round 8: the optimizer's settings for one layout run. */
export interface OptimizeOptions {
  /** Annealing steps per depth (deterministic). */
  iters?: number;
  /** How many depths to try (thinnest first). */
  depths?: number;
  /** Safety stop for the whole search, ms. */
  timeMs?: number;
  /** Round 8b: at a fixed outline, stop after this many depths that fit (default 2). */
  fitStop?: number;
}

/** One finished layout the optimizer made at a cavity depth. */
export interface AutoCandidate {
  layout: Layout;
  /** Cavity depth tried, mm. */
  D: number;
  /** What the search minimised (outline scale or plan area). */
  size: number;
  failed: string[];
  iters: number;
  /** The container the search packed into (the outline, or a preset at an aspect). */
  container: string;
}

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
  // round 7: 3D finish ("auto" = the shape's default)
  edge_radius_front_mm: number | "auto";
  edge_radius_back_mm: number | "auto";
  dome_mm: number | "auto";
  dome_back_mm: number | "auto";
  depth_mm: number | "auto";
}

export function resolveParams(shape: CaseShape, p: Enclosure["params"] = {}): ResolvedParams {
  return {
    wall_mm: p.wall_mm ?? 1.6,
    corner_radius_mm: p.corner_radius_mm ?? (shape === "keychain" ? 7 : 4),
    color: p.color ?? "#F2EDE4",
    lanyard_hole: p.lanyard_hole ?? shape === "keychain",
    belt_clip: p.belt_clip ?? false,
    closure: p.closure ?? "snap",
    tolerance_mm: p.tolerance_mm ?? (p.process === "resin" ? 0.1 : p.process === "injection" ? 0.05 : 0.2),
    process: p.process ?? "fdm",
    gap_mm: p.gap_mm ?? 1.5,
    edge_radius_front_mm: p.edge_radius_front_mm ?? "auto",
    edge_radius_back_mm: p.edge_radius_back_mm ?? "auto",
    dome_mm: p.dome_mm ?? "auto",
    dome_back_mm: p.dome_back_mm ?? p.dome_mm ?? "auto",
    depth_mm: p.depth_mm ?? "auto",
  };
}

/**
 * Common 1S LiPo pouch cells by capacity (typical sizes; the case packs the cell the project asks
 * for with the part's `capacity` prop). code = thickness·width·length (e.g. 503035 = 5 x 30 x 35 mm).
 */
export const LIPO_CELLS = [
  { mAh: 100, code: "401730", w: 30, h: 17, d: 4 },
  { mAh: 150, code: "402030", w: 30, h: 20, d: 4 },
  { mAh: 250, code: "502030", w: 30, h: 20, d: 5 },
  { mAh: 500, code: "503035", w: 35, h: 30, d: 5 },
  { mAh: 1000, code: "523450", w: 50, h: 34, d: 5.2 },
] as const;

/** The spec with the cell size of its capacity (LiPo pouch cells only; anything else unchanged). */
export function specWithProps(spec: PartSpec, props?: Record<string, unknown>): PartSpec {
  const cap = typeof props?.capacity === "number" ? props.capacity : undefined;
  if (cap === undefined || !spec.mechanical?.soft || !(spec.tags ?? []).includes("lipo")) return spec;
  const cell = LIPO_CELLS.find((c) => c.mAh >= cap);
  if (!cell) return spec;
  return { ...spec, dimensions_mm: { w: cell.w, h: cell.h, d: cell.d }, mechanical: { ...spec.mechanical, source: `${cell.code} pouch cell (${cell.w} x ${cell.h} x ${cell.d} mm, ${cell.mAh} mAh, typical); allow 10 % swell` } };
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

export type OpeningKind = "window" | "button" | "connector" | "light-pipe" | "hole" | "grille" | "slot" | "lens" | "access";

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
  /** Spot face: a flat recess this deep (mm) cut into the outer surface round a connector on a curved wall, so the plug reaches. */
  spot?: number;
}

export interface Rib {
  /** Box in the case frame (min / max), attached to the front ("front") or back ("back") inner wall. */
  min: Vec3;
  max: Vec3;
  shell: "front" | "back";
  why: string;
  /** Round 12: the part it holds and what it does (locator round the part, backstop behind a side part, guide beside one, corner of a cell). */
  part?: string;
  kind?: "locator" | "backstop" | "guide" | "corner";
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
  /** Round 12: the part it holds; standoff (a pin in a mounting hole), seat (the part rests on it) or hold-down (stops it lifting, from the other shell). */
  part?: string;
  kind?: "standoff" | "seat" | "hold-down";
}

export interface Collar {
  part: string;
  min: Vec3;
  max: Vec3;
  round: boolean;
  shell: "front" | "back";
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
  /** Outer front edge fillet and the cavity's (concentric) one; the back edge's. */
  rf: number;
  ri: number;
  rfBack: number;
  riBack: number;
  split: number;
  lip: { t: number; h: number; bead: number; groove: number } | null;
  openings: Opening[];
  ribs: Rib[];
  posts: Post[];
  bosses: Boss[];
  cradles: { part: string; min: Vec3; max: Vec3; wall: number; h: number; slots?: { min: Vec3; max: Vec3 }[] }[];
  /** Round 12: how each part is held, which shell it goes into and how it goes in (the assembly plan reads it). */
  mounts: Mount[];
  /**
   * Domed front / back faces (pebble): each face rises by up to `crown` mm above its flat wall plane
   * along a sphere that meets the plane at the rim, with a flat plateau of radius `plateau` around
   * (x, y) (the window land on the front, the print bed contact on both).
   */
  dome: { front: Dome; back: Dome } | null;
  /** Keychain / lanyard tab: centre, size, hole. */
  tab?: { x: number; y: number; w: number; h: number; t: number; hole: number; z0: number };
  outer: { w: number; h: number; d: number; min: Vec3; max: Vec3 };
  /** Where the packing frame's origin ended up after the case was centred (placements x_mm / y_mm are in the packing frame). */
  origin?: Vec3;
  inner: { w: number; h: number; d: number };
  issues: FitCheck[];
  /** Round 7: how the parts fit a fixed size (custom outlines and size_mm). */
  fit?: LayoutFit;
  /** What parsing the outline changed (corners rounded). */
  outlineNotes?: string[];
  /** Round 8: the distribution proposal this layout is (layoutCase sets it). */
  /** Round 15: the held objects (a tin, a card deck): their room, opening, walls and sleeve. */
  held?: HeldReport[];
  /** Round 17: the collar round a socket in a case that follows the held object: the cavity minus the room over these z (the room's box; round = a cylinder room). */
  collars?: Collar[];
  /** Round 17: this shell prints standing on the seam face (the socket's floor plate), not on its outer face. */
  printFlip?: "front" | "back";
  proposal?: { id: string; label: string; fill_ratio: number; layers: { index: number; z_mm: [number, number]; parts: string[] }[]; why: string[]; source: string; asked: string };
}

const SIDE_FACES: CaseFaceName[] = ["right", "left", "top", "bottom"];

export type { Mount, MountHow } from "./mounts.ts";
import type { Mount } from "./mounts.ts";

/** One domed face: sphere of radius R about the axis (x, y), flat plateau of radius `plateau` at `crown` above the wall plane, meeting the plane at distance S. */
export interface Dome {
  x: number;
  y: number;
  R: number;
  S: number;
  plateau: number;
  crown: number;
}

/** Height of a domed face above its flat wall plane at (x, y) (0 outside the dome). */
export function domeHeight(d: Dome | undefined, x: number, y: number): number {
  if (!d || d.crown <= 0) return 0;
  const rho = Math.hypot(x - d.x, y - d.y);
  if (rho <= d.plateau) return d.crown;
  if (rho >= d.S) return 0;
  return Math.max(0, Math.min(d.crown, Math.sqrt(d.R * d.R - rho * rho) - Math.sqrt(d.R * d.R - d.S * d.S)));
}

/** Sphere radius through the rim (distance S, height 0) and the plateau edge (distance rp, height crown). */
function domeRadius(S: number, rp: number, crown: number): number {
  const f = (R: number) => Math.sqrt(R * R - rp * rp) - Math.sqrt(R * R - S * S) - crown;
  let lo = S + 1e-6;
  let hi = 1e6;
  if (f(lo) < 0) return lo; // crown too large for the span: steepest sphere
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Rounded front / back edge radius as a share of the outer depth, per shape (a pebble and a pill are round all over, a puck has soft edges). */
export const EDGE_SHARE: Record<CaseShape, number> = { pebble: 0.44, pill: 0.44, puck: 0.34, keychain: 0.38, "rounded-box": 0, custom: 0.44 };

/** Round 8b: a dome over this (mm, per face) is called out with what it costs in thickness. */
export const DOME_WARN_MM = 3;

/** Default dome per shape (mm): pebble and custom bulge ~2 % of their span (0.5 to 1 mm), the others are flat. */
function autoCrown(shape: CaseShape, S: number): number {
  return shape === "pebble" || shape === "custom" ? Math.max(0.5, Math.min(1.0, 0.02 * S)) : 0;
}

function priority(f: LocalFeature, isFront: boolean): number {
  if (!f.expose) return -1;
  if (f.kind === "screen") return isFront ? 100 : 40;
  return { access: 95, connector: 90, camera: 85, button: 80, switch: 75, knob: 70, "sensor-window": 60, grille: 50, led: 30, vent: 0, antenna: 0, screen: 40 }[f.kind] ?? 0;
}

/** Distance kept between a feature's tip and the inner wall surface, by kind. */
function tipOffset(f: LocalFeature, tol: number): number {
  // pass-through features (slide lever, pot shaft, LED / PIR dome): the body sits tol behind the
  // inner wall and the feature pokes through its opening, so the tip is past the wall (negative).
  if (f.passThrough) return tol - f.protrude;
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
  parts: { id: string; type: string; spec: PartSpec; props?: Record<string, unknown> }[];
  enclosure: Enclosure;
}

export interface LayoutOptions {
  /** A quicker, coarser search (check_fit / dry runs: well under a second). */
  quick?: boolean;
}

/** How the parts fit a fixed size (and what an auto size came to). */
export interface LayoutFit {
  /** Every part inside the outline and the depth. */
  fits: boolean;
  /** The size was given (size_mm / depth_mm): w / h / d each fixed or not. */
  fixed: { w: boolean; h: boolean; d: boolean };
  /** Overall size the parts need (mm, before a lanyard tab). */
  needed_mm: { w: number; h: number; d: number };
  /** The asked size (fixed values only). */
  asked_mm?: { w?: number; h?: number; d?: number };
  /** How much the outline must grow for the parts (1 = as asked; custom outlines). */
  scale: number;
  /** Parts that stick out of the outline, with how far (mm) and where. */
  outlineMisses: { part: string; short_mm: number; side: string }[];
  /** The stack is deeper than the asked depth. */
  depthMiss?: { needed_mm: number; available_mm: number; parts: string[] };
}

/**
 * Round 7's packer (kept as one of the candidates the proposals compare): parts stacked front to
 * back. A curved shape gives each connector its own side; which connector gets which side is tried
 * both ways (up to 4 orders) and the smallest case kept.
 */
export function stackLayout(input: LayoutInput, opts: LayoutOptions = {}): Layout {
  // A custom outline (or a preset at a fixed size) always gets the same search, so check_fit's
  // quick answer is the answer design_case builds; the presets keep their larger round-6 search.
  const sz = input.enclosure.size_mm;
  if (input.enclosure.shape === "custom" || sz?.w !== undefined || sz?.h !== undefined) opts = { ...opts, quick: true };
  const first = layoutOnce(input, undefined, opts);
  const ids = first.connOrder;
  const polyBad = first.plan.kind === "poly" && ids.length > 0 && first.issues.some((i) => i.severity === "error" && i.id !== "fits");
  if ((input.enclosure.shape === "rounded-box" || input.enclosure.shape === "keychain" || ids.length < 2) && !polyBad) return first;
  const perms: string[][] = [];
  const permute = (rest: string[], acc: string[]) => {
    if (perms.length >= 4) return;
    if (!rest.length) return void perms.push(acc);
    for (const x of rest) permute(rest.filter((y) => y !== x), [...acc, x]);
  };
  permute(ids, []);
  let best = first;
  const cost = (L: Layout) => L.issues.filter((i) => i.severity === "error").length * 1e12 + overflow(L) + caseCost(L);
  // a quick search tries the other port-to-side orders only when the first one has a problem (a port on the tip of a heart)
  const firstBad = first.issues.some((i) => i.severity === "error" && i.id !== "fits");
  for (const perm of perms.slice(1, opts.quick && !firstBad ? 1 : undefined)) {
    const L = layoutOnce(input, perm, opts);
    if (cost(L) < cost(best)) best = L;
  }
  // a custom outline whose bottom is a point (a heart) or a notch: the ports may start on another side
  if (best.plan.kind === "poly" && best.issues.some((i) => i.severity === "error" && i.id !== "fits"))
    for (const cyc of [["left", "right", "bottom", "top"], ["right", "left", "bottom", "top"], ["top", "left", "right", "bottom"]] as CaseFaceName[][])
      for (const perm of perms.length ? perms : [ids]) {
        const L = layoutOnce(input, perm, opts, cyc);
        if (cost(L) < cost(best)) best = L;
        if (!best.issues.some((i) => i.severity === "error" && i.id !== "fits")) return best;
      }
  return best;
}

/** Round 17: the exact CAD outline of a preset shape at a fixed size (half sizes A x B, mm), or undefined (an ellipse: its offsets are not ellipses). */
function exactPreset(shape: CaseShape, A: number, B: number, corner: number): Plan["exact"] {
  if (shape === "pebble" || shape === "puck") return Math.abs(A - B) < 1e-6 ? { shape: "circle", r: 0 } : undefined;
  const r = shape === "pill" ? Math.min(A, B) - 1e-3 : Math.max(0.5, Math.min(corner, A - 0.01, B - 0.01));
  return { shape: "rrect", r: r / Math.min(A, B) };
}

/** How far a fixed size is from holding the parts (0 = fits): the packer keeps the layout closest to fitting. */
function overflow(L: Layout): number {
  const f = L.fit;
  if (!f) return 0;
  return (f.fixed.w || f.fixed.h ? Math.max(0, f.scale - 1) * 1e10 : 0) + (f.depthMiss ? (f.depthMiss.needed_mm - f.depthMiss.available_mm) * 1e9 : 0);
}

function layoutOnce(input0: LayoutInput, connPerm?: string[], opts: LayoutOptions & { optimize?: OptimizeOptions } = {}, connCycle?: CaseFaceName[]): Layout & { connOrder: string[]; candidates?: AutoCandidate[] } {
  // round 15: held objects (a tin, a card deck) are packed as parts with no pins, against the side they go in through
  const params = resolveParams(input0.enclosure.shape, input0.enclosure.params);
  const input = withHeld(input0, { wall: params.wall_mm, tol: params.tolerance_mm });
  const enc = input.enclosure;
  const shape = enc.shape;
  const g = params.gap_mm;
  const tol = params.tolerance_mm;
  const t = params.wall_mm;
  const quick = !!opts.quick;
  // ---- round 7: the outline (custom, or a preset at a fixed size) and the fixed size
  const sz = enc.size_mm ?? {};
  const depthFixed = sz.d ?? (typeof params.depth_mm === "number" ? params.depth_mm : undefined);
  const fixedWH = sz.w !== undefined || sz.h !== undefined;
  let po: ParsedOutline | undefined;
  if (shape === "custom") po = parseOutline(enc.outline);
  else if (fixedWH) po = presetOutline(shape, sz.w ?? sz.h!, sz.h ?? sz.w!, params.corner_radius_mm);
  let A0 = 0;
  let B0 = 0;
  if (po) {
    if (sz.w !== undefined && sz.h !== undefined) [A0, B0] = [sz.w / 2, sz.h / 2];
    else if (sz.w !== undefined) [A0, B0] = [sz.w / 2, (sz.w / 2) * (po.h / po.w)];
    else if (sz.h !== undefined) [A0, B0] = [(sz.h / 2) * (po.w / po.h), sz.h / 2];
    else [A0, B0] = [po.w / 2, po.h / 2];
  }
  const polySpec = po ? { poly: po.poly, ctrl: po.ctrl, w0: t, A0, B0, fixed: fixedWH, quick } : undefined;
  // round 17: a preset at a fixed size is drawn exactly in CAD (a circle, a rounded rectangle)
  const exact: Plan["exact"] = shape !== "custom" && po ? exactPreset(shape, A0, B0, params.corner_radius_mm) : undefined;
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
    if (p.spec.category === "misc" && !p.spec.pins.length && !isHeldType(p.type)) {
      outside.push({ id: p.id, why: `${p.spec.name} is a frame, not something that goes inside a case` });
      continue;
    }
    if (p.spec.category === "passive" && !p.spec.mechanical) {
      inline.push(p.id);
      continue;
    }
    mechs.push(resolveMech(p.id, specWithProps(p.spec, p.props)));
  }
  for (const m of mechs)
    if (!m.hasData)
      issues.push({ id: "mechanical-data", ok: true, severity: "warning", message: `${m.id} (${m.type}) has no mechanical data, so the case treats it as a plain ${m.w} × ${m.h} × ${m.d} mm box with nothing exposed. Why: its part.json has no "mechanical" block. Fix: add one (docs/part-spec.md, "Mechanical") or measure the part and pass its features with update_part.`, parts: [m.id] });

  // ---- 1. bindings and orientations
  const frontId = enc.front ?? mechs.find((m) => m.features.some((f) => f.kind === "screen" && f.expose))?.id;
  if (enc.front && !mechs.some((m) => m.id === enc.front)) issues.push({ id: "front", ok: false, severity: "error", message: `The front part "${enc.front}" is not in the case. Why: there is no such part, or it is excluded. Fix: pass front with the id of the display (get_project lists ids).`, parts: [enc.front] });
  const sideCycle: CaseFaceName[] = ["right", "left", "top"];
  let buttonN = 0;
  // A box or a key fob takes every connector on its bottom wall (one flat); a curved shape gives each its own
  // side (charging port at the bottom, the next on the left, ...) so no wall needs to be cut flat.
  const connFace = new Map<string, CaseFaceName>();
  const connOrder: string[] = [];
  {
    const conn = mechs.filter((m) => !enc.placements?.[m.id]?.face && m.id !== frontId && m.features.filter((f) => f.expose).sort((x, y) => priority(y, false) - priority(x, false))[0]?.kind === "connector");
    conn.sort((x, y) => (connPerm ? connPerm.indexOf(x.id) - connPerm.indexOf(y.id) : Number(y.category === "power") - Number(x.category === "power")));
    connOrder.push(...conn.map((m) => m.id));
    const cycle: CaseFaceName[] = connCycle ?? (shape === "rounded-box" || shape === "keychain" ? ["bottom"] : ["bottom", "left", "right", "top"]);
    conn.forEach((m, i) => connFace.set(m.id, cycle[i % cycle.length]!));
  }
  // one part's orientation and binding; round 8: the optimizer also asks for another face or the part on its edge
  const planOf = (m: PartMech, faceOver?: CaseFaceName, edgeOver?: boolean): Plan0 => {
    const placement = enc.placements?.[m.id];
    const isFront = m.id === frontId;
    const exposed = m.features.filter((f) => f.expose).sort((a, b) => priority(b, isFront) - priority(a, isFront));
    let primary = exposed[0];
    let face: CaseFaceName | "inside" | undefined = faceOver ?? placement?.face;
    if (isFront) {
      primary = m.features.find((f) => f.kind === "screen") ?? primary;
      face = face ?? "front";
    }
    if (face === "inside") primary = undefined;
    else if (primary && !face) {
      switch (primary.kind) {
        case "connector":
          face = connFace.get(m.id) ?? "bottom";
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
    if (!primary || !face || face === "inside") return { mech: m, ...(placement ? { placement } : {}), Rs: placement?.on_edge ? edgeRotations(m) : flatRotations(), isFront };
    const target = FACE_DIR[face];
    let cands = ROTATIONS.filter((R) => eqv(apply(R, primary!.n), target));
    if (placement?.on_edge || edgeOver) {
      const edge = cands.filter((R) => Math.abs(apply(R, [0, 0, 1])[2]) < 0.5);
      if (edge.length) cands = edge;
    }
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
  };
  const plans: Plan0[] = mechs.map((m) => planOf(m));

  // ---- 2. packing
  const order = [...plans].sort((a, b) => rank(a) - rank(b) || vol(b.mech) - vol(a.mech));
  const front = plans.find((p) => p.isFront);
  // ---- round 8: the distribution optimizer (flat first, then stacked), each result finished into a real layout
  if (opts.optimize) {
    const baseIss = issues.splice(0);
    const items: OItem[] = [];
    const vdata: { R: Mat3; bound?: Plan0["bound"]; bx: Box; body: Box; mech: PartMech }[][] = [];
    const curvedShape = !(shape === "rounded-box" || shape === "keychain") || !!polySpec;
    for (const pl of plans) {
      const m = pl.mech;
      const placement = pl.placement;
      const vs: Plan0[] = [];
      const pk = pl.bound?.feature.kind;
      if (pl.bound && !placement?.face && !pl.isFront && SIDE_FACES.includes(pl.bound.face)) {
        // a port, button or switch may go on another side; the one the round-7 rules pick comes first
        // (buttons, switches and knobs keep the side the rules give them: people expect them there)
        const faces: CaseFaceName[] = pk === "connector" ? (curvedShape ? ["bottom", "left", "right", "top"] : ["bottom"]) : [pl.bound.face];
        for (const f of [pl.bound.face, ...faces.filter((f) => f !== pl.bound!.face)]) vs.push(planOf(m, f));
        // stood on its edge, port still on its side (a board standing behind the wall)
        if (!placement?.on_edge && !m.soft) for (const f of [pl.bound.face]) {
          const e = planOf(m, f, true);
          if (Math.abs(apply(e.Rs[0]!, [0, 0, 1])[2]) < 0.5) vs.push(e);
        }
      } else vs.push(pl);
      const variants: OVariant[] = [];
      const data: (typeof vdata)[number] = [];
      const seen = new Set<string>();
      for (const v of vs) {
        let Rs = v.Rs;
        // a free part: turned 0 / 90 (the same box either way up), then on its edge where allowed (never a cell)
        if (!v.bound) {
          Rs = placement?.on_edge ? Rs : [...Rs.filter((R) => Math.abs(apply(R, [0, 0, 1])[2]) > 0.5), ...(m.soft || placement?.face === "inside" ? [] : edgeRotations(m))];
        }
        for (const R of Rs) {
          const bx = rotatedBox(m, R);
          const body = rotatedBox(m, R, true);
          const sx = bx.max[0] - bx.min[0];
          const sy = bx.max[1] - bx.min[1];
          const szz = bx.max[2] - bx.min[2];
          const key = `${v.bound?.face ?? "-"}:${sx.toFixed(2)},${sy.toFixed(2)},${szz.toFixed(2)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const V: OVariant = { sx, sy, sz: szz, pts: footprintPts(m, R, bx, 9), onEdge: Math.abs(apply(R, [0, 0, 1])[2]) < 0.5 };
          const b = v.bound;
          if (b) {
            const tip = apply(R, b.feature.tip);
            const o = b.offset;
            // (a keep-out past the feature's face, e.g. a speaker's, just keeps the feature a little further from the wall)
            if (b.face === "front") V.zFix = { mode: "front", top: Math.max(0, o + tip[2] - bx.max[2]) };
            if (b.face === "back") V.zFix = { mode: "back", bottom: Math.max(0, o - (tip[2] - bx.min[2])) };
            if (SIDE_FACES.includes(b.face)) V.side = { face: b.face, n: [FACE_DIR[b.face][0], FACE_DIR[b.face][1]], tip: [tip[0] - bx.min[0], tip[1] - bx.min[1]], off: o, connector: b.feature.kind === "connector", poke: b.feature.passThrough ? b.feature.protrude : 0, reach: b.feature.kind === "button" ? 6 : b.feature.kind === "led" ? 4 : 1.2 };
            const ax = faceAxes(b.face);
            const offX = placement?.x_mm;
            const offY = placement?.y_mm;
            if (b.face === "front" || b.face === "back") {
              if (v.isFront || offX !== undefined) V.pinX = (offX ?? 0) * ax.right[0] - (tip[0] - bx.min[0]);
              if (offY !== undefined) V.pinY = offY - (tip[1] - bx.min[1]);
            } else if (b.face === "left" || b.face === "right") {
              if (offY !== undefined) V.pinY = offY - (tip[1] - bx.min[1]);
            } else if (offX !== undefined) V.pinX = offX - (tip[0] - bx.min[0]);
          } else {
            // a part with nothing on a wall can be pinned by its centre
            if (placement?.x_mm !== undefined) V.pinX = placement.x_mm - sx / 2;
            if (placement?.y_mm !== undefined) V.pinY = placement.y_mm - sy / 2;
          }
          variants.push(V);
          data.push({ R, ...(b ? { bound: b } : {}), bx, body, mech: m });
        }
      }
      const lay = placement?.layer;
      items.push({ id: m.id, variants, mass: m.w * m.h * m.d * (m.soft ? 2 : 1), soft: m.soft, ...(isHeldMech(m) ? { flush: true } : {}), ...(lay !== undefined && !pl.bound ? { zPin: (lay === 0 ? 0 : 1) as ZMode } : {}) });
      vdata.push(data);
    }
    const lipT = Math.max(0.8, Math.min(1.2, t * 0.6));
    // round 17: a case that follows a held object: its room is a whole layer against its wall
    let followLayer: { front: number; back: number } | undefined;
    if (enc.follow) {
      const fi = items.findIndex((it) => it.id === enc.follow!.held && it.flush);
      const V = fi >= 0 ? items[fi]!.variants[0] : undefined;
      if (V?.zFix) followLayer = V.zFix.mode === "back" ? { front: 0, back: V.zFix.bottom + V.sz + g } : { front: V.zFix.top + V.sz + g, back: 0 };
    }
    const kindO: OEnv["kind"] = polySpec ? "poly" : shape === "puck" ? "circle" : shape === "pebble" ? "ellipse" : shape === "pill" ? "stadium" : "rrect";
    // the straight band of the side wall that the openings on the sides (and the closure lip) need,
    // as half its height about the middle of the depth: the rims can only round over outside it (step 5)
    let band = 0.6;
    for (const it of vdata)
      for (const d of it) {
        const f = d.bound?.feature;
        if (!f || !SIDE_FACES.includes(d.bound!.face)) continue;
        const uz = Math.abs(apply(d.R, f.uAxis)[2]);
        const vz = Math.abs(apply(d.R, f.vAxis)[2]);
        const ext = f.kind === "button" ? Math.max(3, Math.min(6, f.u)) / 2 + 0.3 : (uz * (f.u + (f.kind === "switch" ? f.travel : 0)) + vz * f.v) / 2;
        band = Math.max(band, ext + (f.kind === "connector" ? Math.min(0.6, f.plugClearance) : 0.2) + 0.6);
      }
    const rimOf = (D: number, which: "front" | "back") => {
      const Dout = D + 2 * t + 0.3;
      const asked = which === "front" ? params.edge_radius_front_mm : params.edge_radius_back_mm;
      let e = typeof asked === "number" ? asked : shape === "rounded-box" ? 1.2 : EDGE_SHARE[shape] * Dout;
      if (shape === "keychain" && typeof asked !== "number") e = Math.min(e, params.corner_radius_mm - 3);
      // as step 5 clamps it: the band (front) or the lip below the split (back) stays straight
      e = Math.min(e, t + 0.3 + D / 2 - (which === "front" ? band : Math.max(band, 2.6)));
      return Math.max(0, e - t);
    };
    // the container the search packs into: the drawn outline (centred; fixed: at the asked size), or a
    // preset's outline at a few aspects (its real plan is then sized round the parts)
    const containers: { radial: OEnv["radial"]; fixed: boolean; label: string }[] = [];
    if (polySpec) containers.push({ radial: radialOf(polySpec.poly, polySpec.A0, polySpec.B0), fixed: polySpec.fixed, label: "outline" });
    else for (const asp of shape === "puck" ? [1] : [1, 0.75]) containers.push({ radial: radialOf(presetPoints(shape, 60, 60 * asp, params.corner_radius_mm), 1, 1), fixed: false, label: `aspect ${asp}` });
    const crownEst = (v: number | "auto") => (v === "auto" ? (shape === "pebble" || shape === "custom" ? 1 : 0) : v);
    const maxD = depthFixed !== undefined ? depthFixed - 2 * t - crownEst(params.dome_mm) - crownEst(params.dome_back_mm) : Infinity;
    // round 8b: at a fixed outline (size_mm w / h) the plan cannot grow, so the depth is what gives:
    // the search keeps going deeper (thinnest first) until a layout fits, then stops after one more
    const fixedPlan = !!polySpec?.fixed;
    let Ds = depthCandidates(items, g, Number.isFinite(maxD) ? maxD : 60, fixedPlan ? Math.max(10, opts.optimize.depths ?? 5) : (opts.optimize.depths ?? 5));
    if (Number.isFinite(maxD)) Ds = [...new Set([...Ds.filter((d) => d <= maxD + 1e-6), Math.max(4, Math.round(maxD * 10) / 10)])].sort((a, b) => a - b);
    const seed = hashSeed(items.map((it) => `${it.id}:${it.variants.length}`).join("|") + shape);
    const deadline = performance.now() + (opts.optimize.timeMs ?? 6000);
    const cands: AutoCandidate[] = [];
    const partsArea = items.reduce((a, it) => a + (it.variants[0]!.sx + g) * (it.variants[0]!.sy + g), 0);
    for (const ct of containers) {
      const env: OEnv = {
        kind: kindO,
        radial: ct.radial,
        g,
        t,
        lip: Math.max(0, lipT + tol - g),
        rims: (D) => [rimOf(D, "front"), rimOf(D, "back")],
        upright: !!polySpec && polySpec.B0 > 1.15 * polySpec.A0,
        B0: polySpec ? polySpec.B0 : 30,
        ...(followLayer ? { layer: followLayer } : {}),
      };
      // area of the container at scale 1 (mm²), for a first guess of the scale
      let a1 = 0;
      for (let k = 0; k < ct.radial.r.length; k++) a1 += 0.5 * ct.radial.r[k]! ** 2 * ((2 * Math.PI) / ct.radial.r.length);
      let fitting = 0;
      for (const D of Ds) {
        if (ct.fixed && fitting >= (opts.optimize.fitStop ?? 2)) break;
        const iters = Math.round((opts.optimize.iters ?? 600) / Math.sqrt(containers.length));
        let r = searchAtDepth(items, env, D, { iters, seed, deadline, ...(ct.fixed ? { minScale: 1, startScale: 1 } : { startScale: Math.sqrt(partsArea / Math.max(1, a1)) * 0.9 }) });
        let Lc = finishAt(D, r);
        // a fixed outline the search filled to the brim, where the finished case (real rims, wall
        // lip, spot faces) pokes out by a mm or two: search again in a slightly smaller outline
        for (const k of [0.97, 0.94, 0.91]) {
          if (!ct.fixed || !Lc || Lc.fit?.fits !== false || r.failed.length || r.size > 1 + 1e-6 || Lc.fit.depthMiss) break;
          const shrunk: OEnv = { ...env, radial: { r: ct.radial.r.map((v) => v * k), c: ct.radial.c } };
          const r2 = searchAtDepth(items, shrunk, D, { iters, seed, deadline, minScale: 1, startScale: 1 });
          if (r2.failed.length || r2.size > 1 + 1e-6) break;
          const L2 = finishAt(D, r2);
          if (!L2) break;
          r = r2;
          Lc = L2;
        }
        if (process.env.FABER_LAYOUT_DEBUG) console.log(`[layout] ${ct.label} D=${D.toFixed(1)} size=${r.size.toFixed(3)} failed=${r.failed.map((k) => items[k]!.id)} fits=${Lc?.fit?.fits} scale=${Lc?.fit?.scale}`);
        if (!Lc) continue;
        if (Lc.fit?.fits !== false && !Lc.issues.some((i) => i.severity === "error")) fitting++;
        cands.push({ layout: Lc, D, size: r.size, failed: r.failed.map((k) => items[k]!.id), iters: r.iters, container: ct.label });
      }
    }
    function finishAt(D: number, r: ReturnType<typeof searchAtDepth>): Layout | undefined {
      {
        const placedL: Placed[] = r.placed.map((q) => {
          const d = vdata[q.item]![q.v]!;
          const min: Vec3 = [q.x, q.y, q.z0];
          const T: Vec3 = [min[0] - d.bx.min[0], min[1] - d.bx.min[1], min[2] - d.bx.min[2]];
          const add = (v: Vec3): Vec3 => [v[0] + T[0], v[1] + T[1], v[2] + T[2]];
          return { mech: d.mech, R: d.R, T, facing: facingOf(d.R), rotation: rotationDeg(d.R), layer: 0, min, max: add(d.bx.max), bodyMin: add(d.body.min), bodyMax: add(d.body.max), ...(d.bound ? { bound: d.bound } : {}) };
        });
        const iss: FitCheck[] = baseIss.map((i) => ({ ...i }));
        for (const k of r.failed) {
          const id = items[k]!.id;
          iss.push({ id: "fits", ok: false, severity: "error", message: `${id} could not be placed with the others. Why: at ${D.toFixed(1)} mm of depth there is no spot where it fits, reaches its wall and keeps clear of the other parts. Fix: let the case be deeper (a larger size_mm.d or depth_mm), move it with placements, or exclude it.`, parts: [id] });
        }
        if (!placedL.length) return undefined;
        return finish(placedL, iss);
      }
    }
    if (!cands.length) {
      const first = layoutOnce(input, connPerm, { ...opts, optimize: undefined }, connCycle);
      return { ...first, candidates: [] };
    }
    return { ...cands[0]!.layout, connOrder: [], candidates: cands };
  }
  const dims = plans.map((p) => {
    const bx = rotatedBox(p.mech, p.Rs[0]!);
    const ex = p.Rs.length > 1 ? Math.min(bx.max[0] - bx.min[0], bx.max[1] - bx.min[1]) : bx.max[0] - bx.min[0];
    const ey = p.Rs.length > 1 ? Math.min(bx.max[0] - bx.min[0], bx.max[1] - bx.min[1]) : bx.max[1] - bx.min[1];
    return [ex, ey] as const;
  });
  const W0 = Math.max(10, ...dims.map((d) => d[0])) + 2 * g;
  const H0 = Math.max(10, ...dims.map((d) => d[1])) + 2 * g;
  type Packed = { placed: Placed[]; score: number; failed: string[]; key: string };
  // Many packings (plan rectangles x part orders), the cheapest few finished into real layouts,
  // the smallest case kept (volume, with thickness weighed for a pocket: <= 18 mm comfortable).
  const orders: Plan0[][] = [order];
  const mid0 = order.filter((p) => rank(p) === 1 || rank(p) === 2);
  // a custom outline scores each packing by the outline it needs (the narrow end of an egg holds less)
  const polyScore = polySpec ? (placed: Placed[]) => {
    const needs: Need[] = [];
    for (const q of placed) for (const x of [q.min[0] - g, q.max[0] + g]) for (const y of [q.min[1] - g, q.max[1] + g]) needs.push({ x, y, inset: 0 });
    if (!needs.length) return 1;
    return sizePoly(needs, { ...polySpec, quick: true }).scale;
  } : undefined;
  if (mid0.length > 1) {
    const head = order.filter((p) => rank(p) === 0);
    const tail = order.filter((p) => rank(p) > 2);
    orders.push([...head, ...[...mid0].reverse(), ...tail]);
    orders.push([...head, ...[...mid0].sort((a, b) => vol(b.mech) - vol(a.mech)), ...tail]);
    orders.push([...head, ...[...mid0].sort((a, b) => Number(!!b.bound) - Number(!!a.bound) || vol(a.mech) - vol(b.mech)), ...tail]);
  }
  const packs: Packed[] = [];
  withFastOutline(() => {
  // a custom outline also packs into the outline itself (below), so fewer rectangles
  const stepWH = polySpec ? (quick ? 7.5 : 6) : quick ? 6 : 3;
  for (const ord of orders.slice(0, quick ? 2 : undefined))
    for (let dw = 0; dw <= 30; dw += stepWH)
      for (let dh = 0; dh <= 30; dh += stepWH) {
        const r = pack(ord, W0 + dw, H0 + dh, g, front, shape, polyScore && polySpec ? { score: polyScore, A0: polySpec.A0, B0: polySpec.B0, area: polyAreaNorm(polySpec.poly) } : undefined);
        const key = r.placed.map((p) => `${p.mech.id}:${p.min.map((v) => Math.round(v)).join(",")}:${p.rotation}:${p.facing}`).sort().join("|");
        packs.push({ ...r, score: r.failed.length * 1e9 + r.score, key });
      }
  // round 7: a custom outline also packs straight into the outline at a few sizes (fixed: the asked
  // size only), so the parts follow its shape instead of a rectangle
  if (polySpec && polyScore) {
    const ok = packs.filter((x) => !x.failed.length);
    const s0 = ok.length ? Math.min(...ok.slice(0, 40).map((x) => polyScore(x.placed))) : 1;
    const arcR = (rad: number, delta: number) => (rad <= 0 || delta >= rad ? 0 : rad - Math.sqrt(rad * rad - (rad - Math.max(0, delta)) ** 2));
    // the rims' round-over (a share of the depth) takes room near the front and back faces: the
    // depth is estimated (fixed, or 18 mm), then the packing is redone once with the depth it came to
    const insetFor = (Dest: number) => {
      const eF = typeof params.edge_radius_front_mm === "number" ? params.edge_radius_front_mm : EDGE_SHARE[shape] * Dest;
      const eB = typeof params.edge_radius_back_mm === "number" ? params.edge_radius_back_mm : EDGE_SHARE[shape] * Dest;
      return (z0: number, z1: number, zB?: number) => Math.max(arcR(Math.max(0, eF - t), -z1), zB !== undefined ? arcR(Math.max(0, eB - t), z0 - zB) : 0) + 0.3;
    };
    // fixed: the asked size, and a little bigger so a miss says how much bigger it must be
    const scales = polySpec.fixed ? (quick ? [1, 1.05, 1.12] : [1, 1.03, 1.07, 1.12, 1.2]) : (quick ? [0.88, 1, 1.12, 1.27, 1.45] : [0.8, 0.88, 0.96, 1.05, 1.15, 1.27, 1.4, 1.55]).map((f) => f * s0);
    for (const sc of scales)
      for (const ord of orders.slice(0, quick ? 2 : 4)) {
        const A = polySpec.A0 * sc;
        const B = polySpec.B0 * sc;
        const cav: Plan = { kind: "poly", cx: 0, cy: 0, a: A - t, b: B - t, rc: 0, flats: [], poly: polySpec.poly, ctrl: polySpec.ctrl, w0: t };
        const run = (Dest: number) => pack(ord, 2 * (A - t), 2 * (B - t), g, front, shape, { score: polyScore, A0: polySpec.A0, B0: polySpec.B0, area: polyAreaNorm(polySpec.poly) }, { plan: cav, insetAt: insetFor(Dest) });
        const D0 = depthFixed ?? 18;
        // both packings go to the shortlist: the deeper estimate keeps clear of the rims, the first is often thinner
        const runs = [run(D0)];
        if (depthFixed === undefined && runs[0]!.placed.length) {
          const D1 = -Math.min(...runs[0]!.placed.map((q) => q.min[2])) + 2 * t + 1.5;
          if (D1 > D0 + 1) runs.push(run(D1));
        }
        for (const r of runs) {
          const key = "rg" + r.placed.map((p) => `${p.mech.id}:${p.min.map((v) => Math.round(v)).join(",")}:${p.rotation}:${p.facing}`).sort().join("|");
          packs.push({ ...r, score: r.failed.length * 1e9 + r.score, key });
        }
      }
  }
  });
  packs.sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  const shortlist: Packed[] = [];
  for (const pk of packs) {
    if (seen.has(pk.key)) continue;
    seen.add(pk.key);
    shortlist.push(pk);
    if (shortlist.length >= (quick ? 6 : 14)) break;
  }
  // also the shallowest packings: a thin case can win on the pocket even with a larger plan
  const depthOf = (pk: Packed) => -Math.min(...pk.placed.map((q) => q.min[2]));
  for (const pk of [...packs].filter((x) => !x.failed.length).sort((a, b) => depthOf(a) - depthOf(b) || a.score - b.score)) {
    if (seen.has(pk.key)) continue;
    seen.add(pk.key);
    shortlist.push(pk);
    if (shortlist.length >= (quick ? 9 : 22)) break;
  }
  // and the most compact contents (bounding box of the packed parts)
  const boxVol = (pk: Packed) => {
    const lo = [0, 1, 2].map((k) => Math.min(...pk.placed.map((q) => q.min[k]!)));
    const hi = [0, 1, 2].map((k) => Math.max(...pk.placed.map((q) => q.max[k]!)));
    return (hi[0]! - lo[0]! + 2 * g) * (hi[1]! - lo[1]! + 2 * g) * (hi[2]! - lo[2]! + 1) * (1 + 0.04 * Math.max(0, hi[2]! - lo[2]! - 14));
  };
  for (const pk of [...packs].filter((x) => !x.failed.length).sort((a, b) => boxVol(a) - boxVol(b))) {
    if (seen.has(pk.key)) continue;
    seen.add(pk.key);
    shortlist.push(pk);
    if (shortlist.length >= (quick ? 12 : 30)) break;
  }
  const baseIssues = issues.splice(0);
  let bestL: Layout | undefined;
  let bestCost = Infinity;
  for (const pk of shortlist) {
    const clone = pk.placed.map((p) => ({ ...p, min: [...p.min] as Vec3, max: [...p.max] as Vec3, bodyMin: [...p.bodyMin] as Vec3, bodyMax: [...p.bodyMax] as Vec3, T: [...p.T] as Vec3 }));
    const iss: FitCheck[] = baseIssues.map((i) => ({ ...i }));
    for (const id of pk.failed) iss.push({ id: "fits", ok: false, severity: "error", message: `${id} could not be packed with the others. Why: its exposed feature is pinned to a face where another part already sits. Fix: move it with placements (e.g. {"${id}": {"face": "left"}}) or exclude it.`, parts: [id] });
    const Lc = finish(clone, iss);
    const errs = Lc.issues.filter((i) => i.severity === "error").length;
    const cost = errs * 1e12 + overflow(Lc) + caseCost(Lc);
    if (cost < bestCost) {
      bestCost = cost;
      bestL = Lc;
    }
  }
  return { ...bestL!, connOrder };

  function finish(placed: Placed[], issues: FitCheck[]): Layout {
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
  // ---- round 7: a fixed depth (size_mm.d / depth_mm): the case is exactly that thick, or the stack is reported
  let fixedCrown: { front: number; back: number } | undefined;
  let depthMiss: LayoutFit["depthMiss"];
  if (depthFixed !== undefined) {
    const lo = [0, 1].map((k) => Math.min(...placed.map((q) => q.min[k]!)));
    const hi = [0, 1].map((k) => Math.max(...placed.map((q) => q.max[k]!)));
    const S = polySpec?.fixed ? Math.hypot(polySpec.A0, polySpec.B0) * 0.9 : Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!) / 2 + g + t;
    const want = (v: number | "auto") => (v === "auto" ? autoCrown(shape, S) : v);
    fixedCrown = { front: want(params.dome_mm), back: want(params.dome_back_mm) };
    const avail = depthFixed - 2 * t - fixedCrown.front - fixedCrown.back;
    const need = zFront - zBack;
    if (need > avail + 1e-6) {
      const deep = [...placed].sort((a, b) => b.max[2] - b.min[2] - (a.max[2] - a.min[2]));
      depthMiss = { needed_mm: r1(need + 2 * t + fixedCrown.front + fixedCrown.back), available_mm: r1(depthFixed), parts: deep.slice(0, 3).map((q) => q.mech.id) };
    } else zBack = zFront - avail;
  }
  const depth = zFront - zBack;
  // side connectors slide (in z) towards the middle of the depth where the room allows: the straight
  // band of the side wall that must hold their openings then sits in the middle, leaving the front
  // and back edges free to be rounded with a large radius.
  for (const p of [...placed].sort((a, b) => Number(b.bound?.feature.kind === "connector") - Number(a.bound?.feature.kind === "connector"))) {
    if (!p.bound || !SIDE_FACES.includes(p.bound.face)) continue;
    const want = (zFront + zBack) / 2 - tipCase(p)[2];
    const nn = FACE_DIR[p.bound.face];
    // it may also step out towards its own wall (where step 7 takes it anyway) to clear a neighbour
    const outs = [0, 1, 2, 3, 4, 6, 8];
    const okAt = (dz: number, s: number) => {
      const m = shift(p, [nn[0] * s, nn[1] * s, dz]);
      return m.min[2] >= zBack - 1e-6 && m.max[2] <= zFront + 1e-6 && !placed.some((q) => q !== p && overlap(q, m, g - 1e-6));
    };
    let bestDz = 0;
    let bestS = 0;
    for (const sOut of outs) {
      let lo = 0;
      let hi = 1;
      if (okAt(want, sOut)) lo = 1;
      else if (okAt(0, sOut))
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (okAt(want * mid, sOut)) lo = mid;
          else hi = mid;
        }
      else continue;
      if (Math.abs(want * lo) > Math.abs(bestDz) + 0.5) {
        bestDz = want * lo;
        bestS = sOut;
      }
      if (lo === 1) break;
    }
    if (Math.abs(bestDz) > 0.01) Object.assign(p, shift(p, [nn[0] * bestS, nn[1] * bestS, bestDz]));
  }

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
      // near the middle (both edges can be rounded), crossing as few parts as possible
      const s = crossing(z) * 2 + Math.abs(z - (zFront + zBack) / 2);
      if (s < bestS) {
        bestS = s;
        split = z;
      }
    }
  }

  // ---- round 17: a case that rides on a held object through a socket in its front / back and
  // follows its outline: the socket's floor plate spans the whole case, so the seam goes on the
  // plate's inner face. The shell with the socket then prints standing on that plate (no 70 mm
  // bridge), the socket's collar rising from it.
  let socket: { part: string; face: "front" | "back"; plate: [number, number] } | undefined;
  if (enc.follow) {
    const fr = placed.find((q) => q.mech.id === enc.follow!.held && isHeldMech(q.mech));
    const hd = (enc.held ?? []).find((x) => x.id === enc.follow!.held);
    const face = fr?.bound?.face;
    if (fr && hd?.engage_mm !== undefined && (face === "back" || face === "front")) {
      const T = SLEEVE_WALL_MM;
      const plate: [number, number] = face === "back" ? [fr.max[2], fr.max[2] + T] : [fr.min[2] - T, fr.min[2]];
      const at = face === "back" ? plate[1] : plate[0];
      // the lip hangs lipH from the seam: on the front shell (socket at the back) it must clear the
      // parts above the plate; the other way round it hangs into the collar's margin
      if (at > zBack + 1 && at < zFront - 1 && crossing(at) <= crossing(split)) {
        split = at;
        socket = { part: fr.mech.id, face, plate };
      }
    }
  }

  // ---- 5. front / back edge fillets
  const D = depth + 2 * t;
  let rf = shape === "rounded-box" ? 1.2 : EDGE_SHARE[shape] * D;
  // a rounded rectangle's edge fillet cannot be larger than its plan corner radius
  if (shape === "keychain") rf = Math.min(rf, params.corner_radius_mm - 3);
  let rfB = rf;
  if (typeof params.edge_radius_front_mm === "number") rf = params.edge_radius_front_mm;
  if (typeof params.edge_radius_back_mm === "number") rfB = params.edge_radius_back_mm;
  else if (typeof params.edge_radius_front_mm === "number" && shape === "rounded-box") rfB = rf;
  // straight side band must hold the split lip and every side opening (± 0.6)
  let bandTop = split + 0.6;
  let bandBot = split - lipH - 0.6;
  for (const p of placed)
    if (p.bound && SIDE_FACES.includes(p.bound.face)) {
      const f = p.bound.feature;
      const tip = tipCase(p);
      // the receptacle must face a straight wall (the plug's overmold clearance may run into the
      // curve); a plunger, lever or shaft needs its hole on the straight band too
      const uz = Math.abs(apply(p.R, f.uAxis)[2]);
      const vz = Math.abs(apply(p.R, f.vAxis)[2]);
      const ext = f.kind === "button" ? Math.max(3, Math.min(6, f.u)) / 2 + 0.3 : (uz * (f.u + (f.kind === "switch" ? f.travel : 0)) + vz * f.v) / 2;
      const half = ext + (f.kind === "connector" ? Math.min(0.6, f.plugClearance) : 0.2);
      bandTop = Math.max(bandTop, tip[2] + half + 0.6);
      bandBot = Math.min(bandBot, tip[2] - half - 0.6);
    }
  // round 17: a socket in a case that follows its object: the rim round the mouth is the wall alone,
  // so that face's edge is rounded no more than the wall (unless asked): it stays flat round the opening
  if (socket) {
    if (socket.face === "back" && typeof params.edge_radius_back_mm !== "number") rfB = Math.min(rfB, t);
    if (socket.face === "front" && typeof params.edge_radius_front_mm !== "number") rf = Math.min(rf, t);
  }
  // front and back edges are rounded separately: a port near the back keeps the front edge round
  const asked = { front: rf, back: rfB };
  let rfBack = rfB < 0.05 ? 0 : Math.max(0.6, Math.min(rfB, bandBot - (zBack - t)));
  rf = rf < 0.05 ? 0 : Math.max(0.6, Math.min(rf, zFront + t - bandTop));
  for (const [face, got, want, key] of [["front", rf, asked.front, params.edge_radius_front_mm], ["back", rfBack, asked.back, params.edge_radius_back_mm]] as const)
    if (typeof key === "number" && got + 0.05 < want) issues.push({ id: "edge-radius", ok: true, severity: "warning", message: `The ${face} edge is rounded ${got.toFixed(1)} mm, not the ${want} mm asked. Why: a side opening (USB, button) or the closure lip needs a straight band of wall there. Fix: move that part to another face with placements, or accept the smaller round-over.` });
  let ri = Math.max(0, rf - t);
  let riBack = Math.max(0, rfBack - t);

  // ---- 6. plan sizing
  const kind: PlanKind = polySpec ? "poly" : shape === "puck" ? "circle" : shape === "pebble" ? "ellipse" : shape === "pill" ? "stadium" : "rrect";
  const arc = (rad: number, delta: number) => (rad <= 0 || delta >= rad ? 0 : rad - Math.sqrt(rad * rad - (rad - Math.max(0, delta)) ** 2));
  const intrusion = (z0: number, z1: number) => Math.max(arc(ri, zFront - z1), arc(riBack, z0 - zBack));
  const lipIntr = Math.max(0, lip.t + tol - g);
  const needs: Need[] = [];
  const flats: Flat[] = [];
  for (const p of placed) {
    const z0 = p.min[2];
    const z1 = p.max[2];
    // + 0.1: the shrunk-outline test is an approximation of the true inward offset the wall is built with
    // the lip hangs lipH below the split and its ledge sits 0.8 mm above it
    // round 17: a held object's room already has its clearance and needs no wiring room against the
    // wall (the wall is its sleeve; the closure lip is cut round it), so a case can follow its outline
    const heldP = isHeldMech(p.mech);
    const inset = intrusion(z0, z1) + (!heldP && z1 > split - lipH && z0 < split + 0.8 ? lipIntr : 0) + (heldP ? 0.02 : 0.1);
    const side = p.bound && SIDE_FACES.includes(p.bound.face) ? p.bound.face : undefined;
    const gp = heldP ? 0 : g;
    const pad = (dir: CaseFaceName) => (side === dir ? p.bound!.offset : gp);
    const flat = Math.abs(apply(p.R, [0, 0, 1])[2]) > 0.5;
    if (flat) {
      for (const fp of p.mech.footprint) {
        const c = apply(p.R, [fp.cx, fp.cy, 0]);
        const cx = c[0] + p.T[0];
        const cy = c[1] + p.T[1];
        if (fp.shape === "round") {
          for (let i = 0; i < 32; i++) {
            const a = (i / 32) * Math.PI * 2;
            needs.push({ x: cx + Math.cos(a) * (fp.r + gp), y: cy + Math.sin(a) * (fp.r + gp), inset, part: p.mech.id });
          }
        } else {
          const e = apply(p.R, [fp.hw, fp.hh, 0]);
          const hx = Math.abs(e[0]);
          const hy = Math.abs(e[1]);
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) needs.push({ x: cx + sx * hx + sx * (sx > 0 ? pad("right") : pad("left")), y: cy + sy * hy + sy * (sy > 0 ? pad("top") : pad("bottom")), inset, part: p.mech.id });
        }
      }
    } else {
      for (const sx of [0, 1]) for (const sy of [0, 1]) needs.push({ x: sx ? p.max[0] + pad("right") : p.min[0] - pad("left"), y: sy ? p.max[1] + pad("top") : p.min[1] - pad("bottom"), inset, part: p.mech.id });
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
      needs.push({ x: tip[0] + FACE_DIR[side][0] * o, y: tip[1] + FACE_DIR[side][1] * o, inset: 0, part: p.mech.id });
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
  let plan: Plan;
  let fitScale = 1;
  const outlineMisses: LayoutFit["outlineMisses"] = [];
  if (polySpec) {
    // round 17: a case that follows a held object is concentric with its room
    const fr = enc.follow ? placed.find((q) => q.mech.id === enc.follow!.held && isHeldMech(q.mech)) : undefined;
    const sp = sizePoly(needs, fr ? { ...polySpec, center: [(fr.min[0] + fr.max[0]) / 2, (fr.min[1] + fr.max[1]) / 2] } : polySpec);
    plan = exact ? { ...sp.plan, exact } : sp.plan;
    fitScale = sp.scale;
    if (!polySpec.fixed) {
      // auto: never under 15 mm across (the smallest case that prints well)
      const minHalf = Math.min(plan.a, plan.b) + t;
      if (minHalf < 7.5) plan = { ...plan, a: (plan.a + t) * (7.5 / minHalf) - t, b: (plan.b + t) * (7.5 / minHalf) - t };
    } else if (fitScale > 1 + 1e-3) {
      // fixed size: which parts stick out, by how much, and where
      const by = new Map<string, { short: number; x: number; y: number }>();
      for (const q of needs) {
        if (!q.part || contains(plan, q.x, q.y, q.inset)) continue;
        const short = t + q.inset - polyDistance(plan, q.x, q.y);
        const cur = by.get(q.part);
        if (!cur || short > cur.short) by.set(q.part, { short, x: q.x, y: q.y });
      }
      for (const [part, m] of by) outlineMisses.push({ part, short_mm: r1(Math.max(0.1, m.short)), side: sideName(m.x - plan.cx, m.y - plan.cy, plan.a, plan.b) });
      outlineMisses.sort((a, b) => b.short_mm - a.short_mm);
    }
  } else plan = sizePlan(kind, needs, { ...(center ? { center } : {}), ...(centerX !== undefined ? { centerX } : {}), cornerRadius: cornerCavity });
  // A box keeps a flat wall at each connector; a curved shape stays curved all round (the
  // connector's board moves out to the wall in step 7 and the opening gets a flat spot face).
  const curved = kind !== "rrect";
  // Two or more connectors on one side of a curved shape share a flat there (one straight stretch
  // the plugs reach); a single one goes out to the curve.
  const perSide = new Map<CaseFaceName, number>();
  for (const p of placed) if (p.bound && SIDE_FACES.includes(p.bound.face) && p.bound.feature.kind === "connector") perSide.set(p.bound.face, (perSide.get(p.bound.face) ?? 0) + 1);
  const sideOf = (f: Flat): CaseFaceName => (f.axis === "x" ? (f.sign > 0 ? "right" : "left") : f.sign > 0 ? "top" : "bottom");
  // a custom outline keeps the silhouette that was drawn (no flats): its ports reach through spot faces
  plan = { ...plan, flats: kind === "poly" ? [] : mergeFlats(curved ? flats.filter((f) => (perSide.get(sideOf(f)) ?? 0) > 1) : flats) };
  // A flat that is outside the curve does nothing; one that cuts too deep is impossible (the parts are inside it by construction).

  // ---- 7. side-bound non-connector parts move out until the body (not just the cap) meets the wall
  for (const p of placed) {
    if (!p.bound || !SIDE_FACES.includes(p.bound.face) || (p.bound.feature.kind === "connector" && (!curved || (kind !== "poly" && (perSide.get(p.bound.face) ?? 0) > 1)))) continue;
    const n = FACE_DIR[p.bound.face];
    // measured from where the feature leaves the body (a lever / shaft / dome pokes through the wall)
    const pt = p.bound.feature.passThrough ? p.bound.feature.protrude : 0;
    const baseOff = p.bound.offset + pt;
    const tip0 = tipCase(p);
    const base0: Vec3 = [tip0[0] - n[0] * pt, tip0[1] - n[1] * pt, tip0[2]];
    const room = rayExit(plan, base0[0], base0[1], n[0], n[1]) - baseOff;
    const fits = (s: number) => {
      const moved = shift(p, [n[0] * s, n[1] * s, 0]);
      const inset = intrusion(moved.bodyMin[2], moved.bodyMax[2]) + 0.15;
      const t2 = tipCase(moved);
      if (!contains(plan, t2[0] - n[0] * pt + n[0] * baseOff, t2[1] - n[1] * pt + n[1] * baseOff, 0)) return false;
      // the body without the part that pokes through the wall
      const bx: [number, number] = [moved.bodyMin[0] + (n[0] < 0 ? pt : 0), moved.bodyMax[0] - (n[0] > 0 ? pt : 0)];
      const by: [number, number] = [moved.bodyMin[1] + (n[1] < 0 ? pt : 0), moved.bodyMax[1] - (n[1] > 0 ? pt : 0)];
      for (const x of bx) for (const y of by) if (!contains(plan, x, y, inset)) return false;
      const hit = placed.find((q) => q !== p && overlap(q, moved, g - 1e-6));
      return !hit;
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
  // A connector the curve still keeps away from the wall (a tight end radius bows away from the
  // board's corners) gets a flat on that side after all, so the plug reaches the receptacle.
  if (curved) {
    const late: Flat[] = [];
    for (const p of placed) {
      if (!p.bound || !SIDE_FACES.includes(p.bound.face) || p.bound.feature.kind !== "connector") continue;
      const n = FACE_DIR[p.bound.face];
      const tip = tipCase(p);
      const o = p.bound.offset;
      if (rayExit(plan, tip[0], tip[1], n[0], n[1]) - o <= (kind === "poly" ? 1.5 : 1.2)) continue; // a spot face reaches up to here (a drawn outline: as far as a plug can reach at all)
      const side = p.bound.face;
      const f: Flat = side === "right" ? { axis: "x", sign: 1, at: tip[0] + o } : side === "left" ? { axis: "x", sign: -1, at: tip[0] - o } : side === "top" ? { axis: "y", sign: 1, at: tip[1] + o } : { axis: "y", sign: -1, at: tip[1] - o };
      // round 7: the flat never cuts into another part's room (a screen near that side needs its
      // edge round-over clearance); the plug then reaches through a spot face instead
      for (const q of needs) {
        if (q.part === p.mech.id) continue;
        const c = f.axis === "x" ? q.x : q.y;
        f.at = f.sign > 0 ? Math.max(f.at, c + q.inset) : Math.min(f.at, c - q.inset);
      }
      // a flat that would only graze the curve (under 0.6 mm deep) is left out: it makes a sliver the CAD kernel cannot offset
      const pb = planBounds({ ...plan, flats: [] }, 0);
      const cut = f.axis === "x" ? (f.sign > 0 ? pb.maxX - f.at : f.at - pb.minX) : f.sign > 0 ? pb.maxY - f.at : f.at - pb.minY;
      if (cut < 0.6) continue;
      // a custom outline keeps its drawn silhouette except a local flat (up to 8 mm deep) where a port must reach; the report says so
      if (kind === "poly" && (cut > 8 || polySpec?.fixed)) continue; // a fixed size stays exactly that size: no flat
      late.push(f);
    }
    if (late.length) {
      plan = { ...plan, flats: mergeFlats([...plan.flats, ...late]) };
      if (kind === "poly") issues.push({ id: "outline", ok: true, severity: "warning", message: `The outline gets a flat on the ${late.map((f) => (f.axis === "x" ? (f.sign > 0 ? "right" : "left") : f.sign > 0 ? "top" : "bottom")).join(" and ")} where a port must reach the wall. Why: the drawn curve keeps the port too far in for a plug. Fix: draw that side fuller or straighter, or move the part to another face with placements.` });
    }
  }
  // A flat on a round shape gets rounded corners as large as the edge fillet needs (OpenCascade
  // cannot roll a fillet round a tighter corner), as far as the parts beside it allow; the edge
  // radius shrinks to what the corner allows.
  if (curved && plan.flats.length && kind !== "ellipse") {
    const okRc = (rc: number) =>
      placed.every((p) => {
        const inset = intrusion(p.bodyMin[2], p.bodyMax[2]);
        for (const x of [p.bodyMin[0], p.bodyMax[0]]) for (const y of [p.bodyMin[1], p.bodyMax[1]]) if (!contains({ ...plan, flatCorner: rc }, x, y, inset)) return false;
        return true;
      });
    let rc = Math.max(rf, rfBack) - t + 0.15;
    while (rc > 0.3 && !okRc(rc)) rc *= 0.85;
    plan = { ...plan, flatCorner: rc };
    rf = Math.max(0.6, Math.min(rf, rc + t - 0.15));
    rfBack = Math.max(0.6, Math.min(rfBack, rc + t - 0.15));
    ri = Math.max(0, rf - t);
    riBack = Math.max(0, rfBack - t);
  }

  // ---- 8. openings
  const openings: Opening[] = [];
  const outerPlan = growPlan(plan, t);
  // ---- 8a. pebble: domed faces with a flat plateau (window land on the front, bed contact for printing)
  let dome: Layout["dome"] = null;
  const domeAsked = (v: number | "auto") => v === "auto" ? shape === "pebble" || shape === "custom" : v > 0;
  if (domeAsked(params.dome_mm) || domeAsked(params.dome_back_mm) || (fixedCrown && (fixedCrown.front > 0 || fixedCrown.back > 0))) {
    const rim = outline(outerPlan, 0, 180);
    const mk = (x: number, y: number, want: number, face: "front" | "back"): Dome => {
      const S = Math.max(...rim.map(([px, py]) => Math.hypot(px - x, py - y)));
      const Smin = Math.min(...rim.map(([px, py]) => Math.hypot(px - x, py - y)));
      const v = face === "front" ? params.dome_mm : params.dome_back_mm;
      const crown = fixedCrown ? fixedCrown[face] : v === "auto" ? autoCrown(shape, S) : v;
      if (crown <= 0) return { x, y, R: 0, S, plateau: 0, crown: 0 };
      const plateau = Math.min(want, Smin - Math.max(rf, rfBack) - 1.5);
      if (plateau < 2) return { x, y, R: 0, S, plateau: 0, crown: 0 };
      return { x, y, R: domeRadius(S, plateau, crown), S, plateau, crown };
    };
    const fp = front ? placed.find((p) => p.mech.id === front.mech.id) : undefined;
    const scr = fp?.mech.features.find((f) => f.kind === "screen" && f.expose);
    const sc = fp && scr ? toCase(fp, scr.tip) : undefined;
    const winR = scr ? (scr.shape === "round" ? scr.u / 2 : Math.hypot(scr.u, scr.v) / 2) + 0.3 : 0;
    const smin = Math.min(...rim.map(([px, py]) => Math.hypot(px - plan.cx, py - plan.cy)));
    dome = { front: sc ? mk(sc[0], sc[1], winR + 2.5, "front") : mk(plan.cx, plan.cy, 0.45 * smin, "front"), back: mk(plan.cx, plan.cy, 0.45 * smin, "back") };
    if (!dome.front.crown && !dome.back.crown) dome = null;
    // round 8b: a big dome is thickness the person holds: say what it costs over the default bulge
    if (dome && !fixedCrown) {
      const S = Math.max(...rim.map(([px, py]) => Math.hypot(px - plan.cx, py - plan.cy)));
      const def = autoCrown(shape, S);
      const big = ([["front", dome.front.crown], ["back", dome.back.crown]] as const).filter(([, c]) => c > DOME_WARN_MM);
      if (big.length) {
        const extra = r1(dome.front.crown + dome.back.crown - 2 * def);
        const both = big.length === 2 && Math.abs(dome.front.crown - dome.back.crown) < 0.05;
        issues.push({ id: "dome", ok: false, severity: "warning", message: `The ${both ? `${r1(dome.front.crown)} mm dome on both faces` : big.map(([f, c]) => `${r1(c)} mm dome on the ${f}`).join(" and the ")} adds ${extra} mm of thickness over the default bulge (about ${r1(def)} mm a face). Why: a dome bulges out past the parts, so every mm of it is case thickness to hold. Fix: dome_mm 1.5 (still rounded) or "auto"${big.length === 1 && big[0]![0] === "back" ? ", or dome_back_mm 1.5" : ""}.` });
      }
    }
  }
  for (const p of placed) {
    for (const f of p.mech.features) {
      if (!f.expose) continue;
      const n = apply(p.R, f.n);
      const face = (Object.entries(FACE_DIR).find(([, d]) => eqv(d, n))?.[0] ?? undefined) as CaseFaceName | undefined;
      const tip = toCase(p, f.tip);
      if (!face) continue;
      // measured from the feature's base: the tip itself, or for a pass-through feature (lever,
      // shaft, dome) the point where it leaves the body; wallDist is then negative (past the wall)
      const base: Vec3 = f.passThrough ? [tip[0] - n[0] * f.protrude, tip[1] - n[1] * f.protrude, tip[2] - n[2] * f.protrude] : tip;
      let baseDist: number;
      let at: Vec3;
      if (face === "front") {
        baseDist = zFront - base[2];
        at = [base[0], base[1], zFront];
      } else if (face === "back") {
        baseDist = base[2] - zBack;
        at = [base[0], base[1], zBack];
      } else {
        baseDist = rayExit(plan, base[0], base[1], n[0], n[1]);
        at = [base[0] + n[0] * baseDist, base[1] + n[1] * baseDist, base[2]];
      }
      const wallDist = f.passThrough ? baseDist - f.protrude : baseDist;
      const reach = f.kind === "button" ? 8 : f.kind === "camera" ? 6 : f.kind === "led" ? 6 : f.kind === "grille" ? 3 : 1.5;
      if (baseDist < -0.05 || baseDist > reach + Math.max(0, tipOffset(f, tol))) {
        issues.push({ id: f.kind === "connector" ? "connector-access" : f.kind === "button" ? "buttons-reachable" : f.kind === "screen" ? "screen-window" : "exposed", ok: false, severity: f.kind === "connector" || f.kind === "button" || f.kind === "screen" ? "error" : "warning", message: `${p.mech.id}'s ${f.kind} "${f.id}" faces the ${face} but is ${baseDist.toFixed(1)} mm from that wall, so the case cannot expose it. Why: ${baseDist > 0 ? "the curved wall or another part keeps it away from the wall" : "it would poke through the wall"}. Fix: put it on another face with placements ({"${p.mech.id}": {"face": "${face === "right" ? "left" : face === "top" ? "right" : "top"}"}}), try the rounded-box shape, or set "expose": false for that feature if it does not need to be reached.`, parts: [p.mech.id] });
        continue;
      }
      const uAxis = apply(p.R, f.uAxis);
      const vAxis = apply(p.R, f.vAxis);
      const depthAlong = face === "front" || face === "back" ? t + domeHeight(dome?.[face], at[0], at[1]) : Math.max(t, rayExit(outerPlan, at[0], at[1], n[0], n[1]) + 1e-6);
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
        case "connector": {
          o.kind = "connector";
          o.u = f.u + 2 * f.plugClearance;
          o.v = f.v + 2 * f.plugClearance;
          // a curved wall holds the receptacle back: thin the wall round the port (never under 1.2 mm)
          const spot = Math.min(o.depth - 1.2, o.standoff + o.depth - 1.9);
          if (curved && spot > 0.05) {
            o.spot = spot;
            o.depth -= spot;
          }
          o.corner = Math.min(o.v / 2 - 0.01, f.connector?.startsWith("usb") ? o.v / 2 - 0.01 : 0.8);
          break;
        }
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
          // a hexagonal field of round holes over the grille's area (a buzzer's 8 mm, a speaker's ~18 mm)
          o.kind = "grille";
          const gd = Math.max(8, f.u);
          const hd = gd >= 14 ? 1.8 : 1.5;
          const pitch = hd + 1.3;
          const rMax = gd / 2 - hd / 2 - 0.2;
          const holes: { at: Vec3; d: number }[] = [];
          for (let row = -10; row <= 10; row++)
            for (let col = -10; col <= 10; col++) {
              const pu = (col + (row % 2 ? 0.5 : 0)) * pitch;
              const pv = row * pitch * 0.866;
              if (Math.hypot(pu, pv) > rMax + 1e-9) continue;
              holes.push({ at: [at[0] + uAxis[0] * pu + vAxis[0] * pv, at[1] + uAxis[1] * pu + vAxis[1] * pv, at[2] + uAxis[2] * pu + vAxis[2] * pv], d: hd });
            }
          o.holes = holes;
          o.u = o.v = gd;
          o.shape = "round";
          // the cut reaches the outer surface over every hole (a domed or curved face is higher off-centre)
          const depthAt = (h: Vec3) => (face === "front" || face === "back" ? t + domeHeight(dome?.[face], h[0], h[1]) : Math.max(t, rayExit(outerPlan, h[0], h[1], n[0], n[1]) + 1e-6));
          o.depth = Math.max(o.depth, ...holes.map((h) => depthAt(h.at)));
          break;
        }
        case "camera": {
          // round 13: a lens hole that grows with how far the lens sits behind the outer surface,
          // so the wall stays out of the picture (the field of view is a cone from the lens)
          const half = ((f.fov ?? 66) * Math.PI) / 360;
          const behind = Math.max(0, wallDist) + depthAlong;
          o.kind = "lens";
          o.shape = "round";
          o.u = o.v = Math.round((f.u + 2 * behind * Math.tan(half) + 2 * tol) * 10) / 10;
          break;
        }
        case "access": {
          // round 15: a held object's way in: a slot through a side the size of its cross-section
          // (no deeper than the cavity, so the front and back walls stay), or a pocket in a face
          o.kind = "access";
          const lip = f.lip ?? 0;
          o.u = Math.max(1, f.u - 2 * lip);
          o.v = Math.max(1, f.v - 2 * lip);
          if (face !== "front" && face !== "back") {
            o.v = Math.min(o.v, zFront - zBack - 0.01);
            o.at = [at[0], at[1], Math.min(Math.max(at[2], zBack + o.v / 2), zFront - o.v / 2)];
            // a curved wall is thicker at the slot's ends: cut through it everywhere
            let deep = o.depth;
            for (let k = -1; k <= 1; k += 0.25) {
              const px = at[0] + uAxis[0] * (k * o.u) / 2;
              const py = at[1] + uAxis[1] * (k * o.u) / 2;
              deep = Math.max(deep, rayExit(outerPlan, px, py, n[0], n[1]) + 1e-6);
            }
            o.depth = deep;
          } else {
            let deep = o.depth;
            for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]] as const) deep = Math.max(deep, t + domeHeight(dome?.[face], at[0] + (a * o.u) / 2, at[1] + (b * o.v) / 2));
            o.depth = deep;
          }
          o.corner = o.shape === "rect" ? Math.min(2, o.u / 2 - 0.01, o.v / 2 - 0.01) : 0;
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

  // a connector whose plug would not reach (recessed past 2.5 mm) counts against this layout, so
  // the packer keeps one where it does (the engine re-checks it on the real bodies)
  for (const o of openings)
    if (o.kind === "connector" && o.standoff + o.depth > 2.5)
      issues.push({ id: "connector-access", ok: false, severity: "error", message: `${o.part}.${o.feature}: the plug may not reach (receptacle ${(o.standoff + o.depth).toFixed(1)} mm in). Why: the port sits too far from the ${o.face} wall here. Fix: put it on another face with placements ({"${o.part}": {"face": "${o.face === "bottom" ? "left" : "bottom"}"}}), or a fuller outline on that side.`, parts: [o.part] });

  // ---- 9. retention: screen ribs, standoffs, cradle
  const ribs: Rib[] = [];
  const posts: Post[] = [];
  const cradles: Layout["cradles"] = [];
  const boxes: Box[] = placed.map((p) => ({ min: p.min, max: p.max }));
  const freeBox = (b: Box, ignore?: Placed) => !placed.some((p) => p !== ignore && overlap(p, b, 0.3)) && insidePlan(plan, b, intrusion);
  for (const p of placed) {
    if (isHeldMech(p.mech)) continue; // round 15: held objects get their sleeve below, not locators
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
        const back: Post = { x: c[0], y: c[1], z0: zBack, z1: far, d: hole.d + 2.4, pin_d: hole.d - 0.3, shell: "back", why: `standoff + pin for ${p.mech.id}`, part: p.mech.id, kind: "standoff" };
        const frontP: Post = { x: c[0], y: c[1], z0: near, z1: zFront, d: hole.d + 2.4, pin_d: hole.d - 0.3, shell: "front", why: `standoff + pin for ${p.mech.id}`, part: p.mech.id, kind: "standoff" };
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
      for (const b of cand) if (freeBox(b, p)) ribs.push({ min: b.min, max: b.max, shell, why: `locates ${p.mech.id}`, part: p.mech.id, kind: "locator" });
    }
  }
  void boxes;
  // round 12: every part held (seat posts, locators off the wall, hold-downs, backstops and guides
  // for side parts, cradle strap slots), and which shell it goes into and how
  // round 15: a sleeve of thin walls between each held object and the electronics
  const held = sleeveFor({ placed, openings, ribs, zFront, zBack, split, tol, plan, intrusion, issues, held: enc.held ?? [], wall: t, ri, riBack, ...(enc.follow ? { follow: enc.follow } : {}), ...(socket ? { socket } : {}) });
  // round 17: the socket's collar: the cavity round the room over its depth, so the socket wall
  // hugs the object and holds the floor plate (the case follows the object's outline)
  const collars: Collar[] = [];
  if (socket) {
    const fr = placed.find((q) => q.mech.id === socket!.part)!;
    const round = fr.mech.footprint.some((f) => f.shape === "round");
    collars.push(socket.face === "back"
      ? { part: socket.part, min: [fr.min[0], fr.min[1], zBack - 0.3], max: [fr.max[0], fr.max[1], fr.max[2] + 0.05], round, shell: "back" }
      : { part: socket.part, min: [fr.min[0], fr.min[1], fr.min[2] - 0.05], max: [fr.max[0], fr.max[1], zFront + 0.3], round, shell: "front" });
  }
  const lipBand = (b: Box) => b.max[2] > split - lip.h - 0.3 && b.min[2] < split + 0.8;
  const mounts = designMounts({
    placed,
    openings,
    ribs,
    posts,
    cradles,
    zFront,
    zBack,
    split,
    tol,
    free: (b, ignore, g = 0.3) => !placed.some((p) => p !== ignore && overlap(p, b, g)),
    inside: (b) => {
      const inset = intrusion(b.min[2], b.max[2]) + (lipBand(b) ? lip.t + tol + 0.3 : 0) + 0.3;
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) if (!contains(plan, x, y, inset)) return false;
      return true;
    },
    cavity: (b) => {
      const inset = intrusion(b.min[2], b.max[2]) + 0.05;
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) if (!contains(plan, x, y, inset)) return false;
      return true;
    },
  });

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
      // (round 12: nor on a rib or post: two solids touching on a face leave the shell open there)
      const feats: Box[] = [...ribs.map((r) => ({ min: r.min, max: r.max })), ...posts.map((q) => ({ min: [q.x - q.d / 2, q.y - q.d / 2, q.z0] as Vec3, max: [q.x + q.d / 2, q.y + q.d / 2, q.z1] as Vec3 }))];
      if (!placed.some((q) => overlap(q, col, 0.3)) && !feats.some((f) => overlap(f, col, 0.3)) && ![...openings].some((o) => Math.hypot(o.at[0] - b.x, o.at[1] - b.y) < Math.max(o.u, o.v) / 2 + od / 2 + 0.5)) cands.push(b);
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
    const topX = plan.kind === "poly" ? polyOuter(plan, 0).reduce((a, q) => (q[1] > a[1] ? q : a))[0] : plan.cx;
    tab = { x: topX, y: ob.maxY + th / 2 - 2, w: tw, h: th, t: tt, hole: shape === "keychain" ? 5 : 3.5, z0: Math.max(zBack - t, split - 0.3 - tt) }; // just under the split, on the straight band of the back shell
  }

  // ---- 12. finish: centre the outer box on the origin
  const outerMin: Vec3 = [ob.minX, ob.minY, zBack - t - (dome?.back.crown ?? 0)];
  const outerMax: Vec3 = [ob.maxX, tab ? Math.max(ob.maxY, tab.y + tab.h / 2) : ob.maxY, zFront + t + (dome?.front.crown ?? 0)];
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
  for (const co of collars) {
    co.min = mv(co.min);
    co.max = mv(co.max);
  }
  for (const cr of cradles) {
    cr.min = mv(cr.min);
    cr.max = mv(cr.max);
    if (cr.slots) for (const sl of cr.slots) Object.assign(sl, { min: mv(sl.min), max: mv(sl.max) });
  }
  if (dome)
    for (const d of [dome.front, dome.back]) {
      d.x -= c[0];
      d.y -= c[1];
    }
  if (tab) {
    tab.x -= c[0];
    tab.y -= c[1];
    tab.z0 -= c[2];
  }
  const finalPlan: Plan = { ...plan, cx: plan.cx - c[0], cy: plan.cy - c[1], flats: plan.flats.map((f) => ({ ...f, at: f.at - (f.axis === "x" ? c[0] : c[1]) })) };
  // ---- 13. round 7: the fit report (fixed sizes) and the outline's printability at its real size
  const fixedFlags = { w: polySpec?.fixed ? sz.w !== undefined || sz.h !== undefined : false, h: polySpec?.fixed ? sz.w !== undefined || sz.h !== undefined : false, d: depthFixed !== undefined };
  const outerW = outerMax[0] - outerMin[0];
  const outerH = ob.maxY - ob.minY;
  const outerD = outerMax[2] - outerMin[2];
  const grow = Math.max(1, polySpec?.fixed ? fitScale : 1);
  const fit: LayoutFit = {
    fits: !outlineMisses.length && !depthMiss && !(polySpec?.fixed && fitScale > 1 + 1e-3),
    fixed: fixedFlags,
    needed_mm: { w: r1(outerW * grow), h: r1(outerH * grow), d: r1(depthMiss ? depthMiss.needed_mm : outerD) },
    ...(fixedFlags.w || fixedFlags.d ? { asked_mm: { ...(fixedFlags.w ? { w: r1(2 * polySpec!.A0), h: r1(2 * polySpec!.B0) } : {}), ...(depthFixed !== undefined ? { d: depthFixed } : {}) } } : {}),
    scale: Math.round(fitScale * 1e4) / 1e4,
    outlineMisses,
    ...(depthMiss ? { depthMiss } : {}),
  };
  if (!fit.fits) {
    const parts = [...outlineMisses.map((m) => m.part), ...(depthMiss?.parts ?? [])];
    const what: string[] = [];
    if (outlineMisses.length) what.push(`${outlineMisses.map((m) => `${m.part} sticks out ${m.short_mm} mm at the ${m.side}`).join(", ")} (the outline would have to be ${fit.needed_mm.w} x ${fit.needed_mm.h} mm)`);
    if (depthMiss) what.push(`the stack is ${depthMiss.needed_mm} mm deep for a ${depthMiss.available_mm} mm case (${depthMiss.parts.join(", ")} are the thickest)`);
    issues.push({ id: "fits", ok: false, severity: "error", message: `The parts do not fit the asked size: ${what.join("; ")}. Why: the size is fixed (size_mm), so the case does not grow. Fix: swap a part for a smaller one, stand a board on its edge, leave a part outside, or make it bigger (check_fit lists each with the size it gives).`, parts: [...new Set(parts)] });
  }
  if (plan.kind === "poly") for (const m of outlineFeatureIssues(polyOuter(finalPlan, 0), t)) issues.push({ id: "outline", ok: false, severity: "warning", message: m });
  if (plan.kind === "poly" && !polySpec?.fixed && (outerW > 250 || outerH > 250)) issues.push({ id: "size", ok: false, severity: "error", message: `The case would be ${r1(outerW)} x ${r1(outerH)} mm, over 250 mm. Why: this outline is narrow where the parts need room, so it grows a lot to hold them. Fix: draw a fuller outline, or fewer / smaller parts.` });
  const ib = planBounds(finalPlan, 0);
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
    rfBack,
    riBack,
    split: split - c[2],
    lip: closure === "snap" ? lip : null,
    openings,
    ribs,
    posts,
    bosses,
    cradles,
    mounts,
    ...(held.length ? { held } : {}),
    ...(collars.length ? { collars } : {}),
    ...(socket ? { printFlip: socket.face } : {}),
    dome,
    ...(tab ? { tab } : {}),
    outer: { w: r1(outerMax[0] - outerMin[0]), h: r1(outerMax[1] - outerMin[1]), d: r1(outerMax[2] - outerMin[2]), min: mv(outerMin), max: mv(outerMax) },
    origin: [-c[0], -c[1], -c[2]],
    inner: { w: r1(ib.maxX - ib.minX), h: r1(ib.maxY - ib.minY), d: r1(zFront - zBack) },
    issues,
    fit,
    ...(po?.notes.length ? { outlineNotes: po.notes } : {}),
  };
  }
}

/** What the packer minimises: the outer volume, weighed up when the case is thick for a pocket (> 18 mm, more past 22 mm). */
export function caseCost(L: Pick<Layout, "outer" | "shape" | "rf" | "rfBack" | "plan">): number {
  const v = L.outer.w * L.outer.h * L.outer.d;
  const [a, b, d] = [L.outer.w, L.outer.h, L.outer.d].sort((x, y) => y - x) as [number, number, number];
  let k = 1 + 0.03 * Math.max(0, d - 18) + 0.06 * Math.max(0, d - 22) + 0.02 * Math.max(0, a - 110) + 0.03 * Math.max(0, b - 70);
  // a pebble / pill / puck / keychain with a small edge radius is a slab, not the shape asked for
  const want = EDGE_SHARE[L.shape] * d;
  if (want > 0) k *= 1 + 0.3 * Math.max(0, 1 - L.rf / want) + 0.15 * Math.max(0, 1 - L.rfBack / want) + (L.plan.kind === "poly" ? 1.5 : 0.25) * L.plan.flats.length; // a drawn outline keeps its silhouette unless a port needs a flat
  return v * k;
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

/** Where a point sits on the outline, in words ("top", "bottom left", ...). */
function sideName(dx: number, dy: number, a: number, b: number): string {
  const nx = dx / Math.max(1, a);
  const ny = dy / Math.max(1, b);
  const v = ny > 0.4 ? "top" : ny < -0.4 ? "bottom" : "";
  const h = nx > 0.4 ? "right" : nx < -0.4 ? "left" : "";
  return [v, h].filter(Boolean).join(" ") || (Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? "right" : "left") : ny > 0 ? "top" : "bottom");
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function polyAreaNorm(P: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i]!;
    const q = P[(i + 1) % P.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** A part stood on its edge (its board plane front to back): the distinct ways, by box shape. */
function edgeRotations(m: PartMech): Mat3[] {
  const out: Mat3[] = [];
  const seen = new Set<string>();
  for (const R of ROTATIONS) {
    if (Math.abs(apply(R, [0, 0, 1])[2]) > 0.5) continue;
    const b = rotatedBox(m, R);
    const key = [0, 1, 2].map((k) => (b.max[k]! - b.min[k]!).toFixed(2)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(R);
  }
  return out.slice(0, 4);
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
/**
 * Round 7: packing inside a real outline (a custom shape). Every candidate box must sit inside the
 * cavity (the outline inset by the wall, by `g` for wires and by the estimated edge round-over at
 * its depth), so the narrow end of an egg holds less than its wide end.
 */
interface Region {
  plan: Plan;
  /** Extra inset at this depth range (front / back edge round-over), mm. */
  insetAt: (z0: number, z1: number, zB?: number) => number;
}

/** Outline points of a part's footprint (front view), relative to its box's min corner: rect edges every ~4 mm, discs every 22.5°. */
function footprintPts(m: PartMech, R: Mat3, bx: Box, step = 4): [number, number][] {
  const pts: [number, number][] = [];
  const edge = (a: [number, number], b: [number, number]) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 0; i < n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  };
  if (Math.abs(apply(R, [0, 0, 1])[2]) > 0.5) {
    for (const fp of m.footprint) {
      const c = apply(R, [fp.cx, fp.cy, 0]);
      const cx = c[0] - bx.min[0];
      const cy = c[1] - bx.min[1];
      if (fp.shape === "round") for (let i = 0; i < 16; i++) pts.push([cx + Math.cos((i / 16) * Math.PI * 2) * fp.r, cy + Math.sin((i / 16) * Math.PI * 2) * fp.r]);
      else {
        const e = apply(R, [fp.hw, fp.hh, 0]);
        const hx = Math.abs(e[0]);
        const hy = Math.abs(e[1]);
        const q: [number, number][] = [[cx - hx, cy - hy], [cx + hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy]];
        for (let i = 0; i < 4; i++) edge(q[i]!, q[(i + 1) % 4]!);
      }
    }
  } else {
    const sx = bx.max[0] - bx.min[0];
    const sy = bx.max[1] - bx.min[1];
    const q: [number, number][] = [[0, 0], [sx, 0], [sx, sy], [0, sy]];
    for (let i = 0; i < 4; i++) edge(q[i]!, q[(i + 1) % 4]!);
  }
  return pts;
}

function regionHolds(rg: Region, pts: [number, number][], x0: number, y0: number, inset: number): boolean {
  for (const [px, py] of pts) if (!contains(rg.plan, x0 + px, y0 + py, inset)) return false;
  return true;
}

/** Snug position along one axis: the coordinate nearest to the `dir` side where the part fits (or undefined). */
function snug(rg: Region, pts: [number, number][], axis: 0 | 1, dir: -1 | 1, other: number, sx: number, sy: number, lo: number, hi: number, inset: number): number | undefined {
  const fits = (v: number) => (axis === 0 ? regionHolds(rg, pts, v, other, inset) : regionHolds(rg, pts, other, v, inset));
  const span = axis === 0 ? sx : sy;
  const from = dir < 0 ? lo : hi - span;
  const to = dir < 0 ? hi - span : lo;
  const step = (to - from) / Math.max(1, Math.ceil(Math.abs(to - from) / 1.0));
  if (!Number.isFinite(step) || Math.abs(to - from) < 1e-9) return fits(from) ? from : undefined;
  let prev = from;
  for (let v = from, i = 0; i <= Math.ceil(Math.abs(to - from) / 1.0) + 1; i++, v += step) {
    if (fits(v)) {
      if (i === 0) return v;
      let a = prev;
      let b = v;
      for (let k = 0; k < 8; k++) {
        const m = (a + b) / 2;
        if (fits(m)) b = m;
        else a = m;
      }
      return b;
    }
    prev = v;
  }
  return undefined;
}

function placeOne(pl: Plan0, placed: Placed[], hw: number, hh: number, g: number, mode: "front" | "back", zB = 0, rg?: Region): Placed | undefined {
  let bestP: Placed | undefined;
  let bestS = Infinity;
  for (const R of pl.Rs) {
    const bx = rotatedBox(pl.mech, R);
    const body = rotatedBox(pl.mech, R, true);
    const sx = bx.max[0] - bx.min[0];
    const sy = bx.max[1] - bx.min[1];
    const sz = bx.max[2] - bx.min[2];
    const fpts = rg ? footprintPts(pl.mech, R, bx) : [];
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
    // inside an outline a side-bound part is not pinned to the bounding box: it goes as far towards
    // its side as the outline allows (step 7 then takes it out to the wall)
    const sideDir = rg && bound && SIDE_FACES.includes(bound.face) ? bound.face : undefined;
    if (sideDir === "left" || sideDir === "right") delete pinned.x;
    if (sideDir === "top" || sideDir === "bottom") delete pinned.y;
    // the screen of a custom outline stays on the centre line but may move up or down to where the outline is wide
    if (rg && pl.isFront && pl.placement?.y_mm === undefined) delete pinned.y;
    if (pinned.x !== undefined) xs = [pinned.x];
    if (pinned.y !== undefined) ys = [pinned.y];
    if (pinned.z !== undefined) zs = [pinned.z];
    for (const z of zs) {
      const zr: [number, number] = mode === "front" ? [z - sz, z] : [z, z + sz];
      const inset = rg ? g + rg.insetAt(zr[0], zr[1], mode === "back" ? zB : undefined) : 0;
      let pairs: [number, number][] = [];
      if (!rg) for (const x0 of xs) for (const y0 of ys) pairs.push([x0, y0]);
      else if (sideDir === "bottom" || sideDir === "top") for (const x0 of xs) {
        const y = snug(rg, fpts, 1, sideDir === "bottom" ? -1 : 1, x0, sx, sy, -hh, hh, inset);
        if (y !== undefined) pairs.push([x0, y]);
      }
      else if (sideDir === "left" || sideDir === "right") for (const y0 of ys) {
        const x = snug(rg, fpts, 0, sideDir === "left" ? -1 : 1, y0, sx, sy, -hw, hw, inset);
        if (x !== undefined) pairs.push([x, y0]);
      }
      else {
        for (const x0 of xs) for (const y0 of ys) pairs.push([x0, y0]);
        if (pinned.x === undefined) for (const y0 of ys) for (const d of [-1, 1] as const) {
          const x = snug(rg, fpts, 0, d, y0, sx, sy, -hw, hw, inset);
          if (x !== undefined) pairs.push([x, y0]);
        }
        if (pinned.y === undefined) for (const x0 of xs) for (const d of [-1, 1] as const) {
          const y = snug(rg, fpts, 1, d, x0, sx, sy, -hh, hh, inset);
          if (y !== undefined) pairs.push([x0, y]);
        }
      }
      for (const [x0, y0] of pairs) {
          if (!rg && pinned.x === undefined && (x0 < -hw + g - 1e-6 || x0 + sx > hw - g + 1e-6)) continue;
          if (!rg && pinned.y === undefined && (y0 < -hh + g - 1e-6 || y0 + sy > hh - g + 1e-6)) continue;
          const min: Vec3 = mode === "front" ? [x0, y0, z - sz] : [x0, y0, z];
          const max: Vec3 = mode === "front" ? [x0 + sx, y0 + sy, z] : [x0 + sx, y0 + sy, z + sz];
          if (mode === "back" && max[2] > 0) continue;
          const cand: Box = { min, max };
          if (placed.some((q) => overlap(q, cand, g - 1e-6))) continue;
          if (rg && !regionHolds(rg, fpts, x0, y0, inset)) continue;
          const s = mode === "front" ? -Math.min(min[2], ...placed.map((q) => q.min[2])) * 1000 - max[2] * 10 + Math.abs(x0 + sx / 2) * 0.1 + Math.abs(y0 + sy / 2) * 0.1 : max[2] * 100 + Math.abs(x0 + sx / 2) * 0.1 + Math.abs(y0 + sy / 2) * 0.1;
          if (s < bestS) {
            bestS = s;
            const T: Vec3 = [min[0] - bx.min[0], min[1] - bx.min[1], min[2] - bx.min[2]];
            const add = (v: Vec3): Vec3 => [v[0] + T[0], v[1] + T[1], v[2] + T[2]];
            bestP = { mech: pl.mech, R, T, facing: facingOf(R), rotation: rotationDeg(R), layer: 0, min, max, bodyMin: add(body.min), bodyMax: add(body.max), ...(bound ? { bound } : {}) };
          }
        }
    }
  }
  return bestP;
}

/** Front stack (screen, boards, side parts) from the front plane, then the back group (cells, back grilles) from the back wall, as shallow as both allow. */
function pack(order: Plan0[], W: number, H: number, g: number, front: Plan0 | undefined, shape: CaseShape, poly?: { score: (placed: Placed[]) => number; A0: number; B0: number; area: number }, rg?: Region): { placed: Placed[]; score: number; failed: string[] } {
  const placed: Placed[] = [];
  const failed: string[] = [];
  const hw = W / 2;
  const hh = H / 2;
  for (const pl of order.filter((p) => !isBackGroup(p))) {
    const p = placeOne(pl, placed, hw, hh, g, "front", 0, rg);
    if (p) placed.push(p);
    else failed.push(pl.mech.id);
  }
  const back = order.filter(isBackGroup);
  if (back.length) {
    const depthA = placed.length ? -Math.min(...placed.map((q) => q.min[2])) : 0;
    let done = false;
    // inside an outline a back part that does not fit even alone behind everything fails at once
    if (rg) for (const pl of back) if (!placeOne(pl, [], hw, hh, g, "back", -(depthA + 60), rg)) done = true;
    if (done) {
      failed.push(...back.map((p) => p.mech.id));
      back.length = 0;
    }
    for (let D = Math.max(depthA, 4); D <= depthA + 60 && !done; D += rg ? 1 : 0.5) {
      const trial: Placed[] = [];
      let ok = true;
      for (const pl of back) {
        const p = placeOne(pl, [...placed, ...trial], hw, hh, g, "back", -D, rg);
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
  const ps = poly && placed.length ? poly.score(placed) : 1;
  const area = poly ? poly.area * poly.A0 * poly.B0 * ps * ps : shape === "puck" ? Math.PI * rMax * rMax : shape === "pebble" ? 2 * Math.PI * hx * (h / 2) * 0.8 : shape === "pill" ? w * h * 0.95 : w * h;
  // estimated outer size, to prefer layouts that fit a pocket (110 x 70 x 30 mm)
  const ow = (poly ? 2 * poly.A0 * ps : shape === "puck" ? 2 * rMax : shape === "pebble" ? 2 * hx * 1.2 : w) + 3.2;
  const oh = (poly ? 2 * poly.B0 * ps : shape === "puck" ? 2 * rMax : shape === "pebble" ? h * 1.2 : h) + 3.2;
  const od = d + 3.2;
  const pocket = Math.max(Math.min(ow, oh) / 70, Math.max(ow, oh) / 110, od / 30);
  let score = area * d * (pocket > 1 ? pocket : 1) + Math.max(w, h) * 5;
  if (poly) {
    // a custom outline: weigh thickness like caseCost (a thinner, larger egg can beat a thick one)
    const [a, b, c] = [ow, oh, od + 2].sort((x, y) => y - x) as [number, number, number];
    score = area * (od + 2) * (1 + 0.03 * Math.max(0, c - 18) + 0.06 * Math.max(0, c - 22) + 0.02 * Math.max(0, a - 110) + 0.03 * Math.max(0, b - 70));
  }
  return { placed, score, failed };
}

/** Round 8: the optimizer's finished layouts, one per cavity depth tried (thinnest first). */
export function autoLayouts(input: LayoutInput, opts: OptimizeOptions = {}): AutoCandidate[] {
  return layoutOnce(input, undefined, { quick: true, optimize: opts }).candidates ?? [];
}
