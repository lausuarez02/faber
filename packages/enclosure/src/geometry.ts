/**
 * Build the case bodies in OpenCascade (B-rep) from a layout: the outer shape, the cavity (a true
 * 2D offset of the plan, so the wall is uniform), the front / back split with a snap lip or M2
 * bosses, openings, button plungers, light pipes, ribs, standoffs, the cell cradle and the tab.
 * Everything is in the case frame (mm).
 */
import { apply, type Mat3, ROTATIONS } from "./mech.ts";
import { checkMesh, meshOf } from "./mesh.ts";
import type { Layout, Opening } from "./layout.ts";
import { contains, planBounds, planDrawing } from "./plan.ts";
import { occt, type Replicad } from "./occt.ts";
import type { CaseFile, Vec3 } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Solid = any;

/** The thinnest wall a rim may leave between the rounded outside and the cavity's corner, mm. */
const RIM_WALL = 1.25;

export interface Body {
  /** "front", "back", "cap-<part>", "light-pipe-<part>", "belt-clip". */
  name: string;
  kind: "shell" | "cap" | "light-pipe" | "clip";
  shape: Solid;
  color: string;
  print: NonNullable<CaseFile["print"]>;
  /** Case-frame direction that points up (away from the bed) when this body is printed. */
  up: Vec3;
  /** Direction this body moves in the exploded view (mm). */
  explode: Vec3;
}

export interface Built {
  bodies: Body[];
  envelopes: { id: string; shape: Solid; color: string }[];
  outer: Solid;
  cavity: Solid;
  rf: number;
  rfBack: number;
  /** Round 17: how the rims were rounded (fillet, lofted round-over, chamfer, sharp). */
  edgeHow: EdgeHow;
  /** Round 17: why a rim got less than planned (empty: as planned, or the kernel could not round it). */
  edgeWhy: string;
  notes: string[];
  screws?: { count: number; size: string; inserts: string };
}

const EULER: { R: Mat3; a: number; b: number; c: number }[] = (() => {
  const out: { R: Mat3; a: number; b: number; c: number }[] = [];
  const rx = (d: number): Mat3 => { const c = Math.round(Math.cos((d * Math.PI) / 180)); const s = Math.round(Math.sin((d * Math.PI) / 180)); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
  const ry = (d: number): Mat3 => { const c = Math.round(Math.cos((d * Math.PI) / 180)); const s = Math.round(Math.sin((d * Math.PI) / 180)); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
  const rz = (d: number): Mat3 => { const c = Math.round(Math.cos((d * Math.PI) / 180)); const s = Math.round(Math.sin((d * Math.PI) / 180)); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
  const mul = (p: Mat3, q: Mat3): Mat3 => p.map((row) => [0, 1, 2].map((j) => row[0]! * q[0]![j]! + row[1]! * q[1]![j]! + row[2]! * q[2]![j]!)) as Mat3;
  for (const a of [0, 90, 180, 270]) for (const b of [0, 90, 180, 270]) for (const c of [0, 90, 180, 270]) out.push({ R: mul(rz(c), mul(ry(b), rx(a))), a, b, c });
  return out;
})();

/** Rotate a shape by an axis-aligned rotation matrix (about the origin). */
export function orient(shape: Solid, R: Mat3): Solid {
  const e = EULER.find((x) => x.R.every((row, i) => row.every((v, j) => Math.abs(v - R[i]![j]!) < 1e-9)));
  if (!e) throw new Error("orient: not an axis rotation");
  let s = shape;
  if (e.a) s = s.rotate(e.a, [0, 0, 0], [1, 0, 0]);
  if (e.b) s = s.rotate(e.b, [0, 0, 0], [0, 1, 0]);
  if (e.c) s = s.rotate(e.c, [0, 0, 0], [0, 0, 1]);
  return s;
}

/** Rotation taking local x → u, y → v (or -v), z → n. */
function frameR(u: Vec3, v: Vec3, n: Vec3): Mat3 {
  const cross: Vec3 = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]]; // u × n = -(n × u)
  const y: Vec3 = [-cross[0], -cross[1], -cross[2]]; // n × u keeps det +1
  void v;
  const R: Mat3 = [
    [u[0], y[0], n[0]],
    [u[1], y[1], n[1]],
    [u[2], y[2], n[2]],
  ];
  if (!ROTATIONS.some((q) => q.every((row, i) => row.every((val, j) => Math.abs(val - R[i]![j]!) < 1e-9)))) throw new Error("frameR: axes are not orthonormal");
  return R;
}

function tryFillet(solid: Solid, r: number, z: number): Solid | undefined {
  try {
    const s = solid.fillet(r, (e: Solid) => e.inPlane("XY", z));
    return sound(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A fillet OpenCascade "succeeded" at can still be a broken solid: on some outlines (an arc meeting
 * straight sides) the rounded rim comes back as a separate face that is not sewn to the flat face,
 * so the printed STL has a gap all round the edge (round 15: a 1.65 mm back rim, 200 open edges).
 * A coarse tessellation finds it: every edge shared by two triangles and a positive volume, or the
 * caller tries again. Not "one piece": half-built, a shell can rightly hold a closed void (a held
 * object's sleeve and floor under the front wall, before its opening is cut).
 */
export function sound(s: Solid): boolean {
  try {
    const c = checkMesh(meshOf(s, 0.2, 0.5));
    return c.closed && c.volume > 0;
  } catch {
    return false;
  }
}

/** How a front / back rim came out: a true fillet, a lofted round-over (OpenCascade could not fillet it), a chamfer, or sharp. */
export type EdgeHow = "fillet" | "lofted" | "chamfer" | "sharp";

export interface Rounded {
  solid: Solid;
  /** The radius each rim really got, mm (0 = sharp). */
  r: number;
  rBack: number;
  how: EdgeHow;
}

/**
 * Round 17: a slab with rounded rims built without a fillet: each rim is a smooth loft through
 * exact offsets of the outline along a quarter circle (`segs` + 1 sections; segs 1 = a 45° chamfer,
 * ruled), fused to the straight extruded band between them. OpenCascade's fillet fails silently on
 * some outlines (round 15: an arc meeting straight sides came out sharp); a loft through concentric
 * offsets does not. `drawingAt(inset)` is the outline `inset` mm inside the full one.
 */
export function loftedSlab(drawingAt: (inset: number) => Solid, z0: number, z1: number, rT: number, rB: number, segs = 4): Solid | undefined {
  try {
    if (rT + rB > z1 - z0 + 1e-6) return undefined;
    const rim = (zFace: number, rr: number, dir: 1 | -1): Solid => {
      const sk = Array.from({ length: segs + 1 }, (_, k) => {
        const a = (k / segs) * (Math.PI / 2);
        return drawingAt(rr * (1 - Math.sin(a))).sketchOnPlane("XY", zFace + dir * rr * (1 - Math.cos(a)));
      });
      return sk[0].loftWith(sk.slice(1), { ruled: segs === 1 });
    };
    const zb = z0 + (rB > 0.05 ? rB : 0);
    const zt = z1 - (rT > 0.05 ? rT : 0);
    let s: Solid | undefined = zt - zb > 0.01 ? drawingAt(0).sketchOnPlane("XY", zb).extrude(zt - zb) : undefined;
    if (rB > 0.05) s = s ? s.fuse(rim(z0, rB, 1)) : rim(z0, rB, 1);
    if (rT > 0.05) s = s ? s.fuse(rim(z1, rT, -1)) : rim(z1, rT, -1);
    return s && sound(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Round 17: the rounded slab, never silently sharp: a fillet at the asked radii, else the lofted
 * round-over at those radii, else both again at smaller radii, else a chamfer; what it came to is
 * returned (and reported).
 */
export function roundedOuter(drawingAt: (inset: number) => Solid, z0: number, z1: number, rT: number, rB: number, opts: { fillet?: boolean; loft?: boolean } = {}): Rounded {
  const base = () => drawingAt(0).sketchOnPlane("XY", z0).extrude(z1 - z0);
  const sharp0 = rT < 0.05 && rB < 0.05;
  if (sharp0) return { solid: base(), r: 0, rBack: 0, how: "fillet" };
  for (const k of [1, 0.75, 0.5, 0.3]) {
    const a = rT * k;
    const b = rB * k;
    if (opts.fillet !== false) {
      let s: Solid | undefined = base();
      if (a >= 0.05) s = tryFillet(s, a, z1);
      if (s && b >= 0.05) s = tryFillet(s, b, z0);
      if (s) return { solid: s, r: a < 0.05 ? 0 : a, rBack: b < 0.05 ? 0 : b, how: "fillet" };
    }
    const l = opts.loft === false ? undefined : loftedSlab(drawingAt, z0, z1, a < 0.05 ? 0 : a, b < 0.05 ? 0 : b);
    if (l) return { solid: l, r: a < 0.05 ? 0 : a, rBack: b < 0.05 ? 0 : b, how: "lofted" };
  }
  for (const k of opts.loft === false ? [] : [1, 0.5]) {
    const c = loftedSlab(drawingAt, z0, z1, rT * k < 0.05 ? 0 : rT * k, rB * k < 0.05 ? 0 : rB * k, 1);
    if (c) return { solid: c, r: rT * k < 0.05 ? 0 : rT * k, rBack: rB * k < 0.05 ? 0 : rB * k, how: "chamfer" };
  }
  return { solid: base(), r: 0, rBack: 0, how: "sharp" };
}

/** Extrude the plan from z0 to z1 and round the top perimeter with radTop, the bottom with radBot (falls back to a lofted round-over, smaller radii, a chamfer). */
function roundedSlab(r: Replicad, plan: Layout["plan"], offset: number, z0: number, z1: number, radTop: number, radBot = radTop, opts: { loft?: boolean } = {}): Rounded {
  return roundedOuter((i) => planDrawing(r, plan, offset - i), z0, z1, radTop, radBot, opts);
}

/**
 * A curved shape's outer body: the outer plan extruded, domed by a sphere on each face (pebble),
 * every front / back rim edge rounded in 3D with one large fillet, then the domes cut flat at their
 * plateau. Falls back to smaller radii when OpenCascade cannot fillet the larger one. Round 17: a
 * flat-faced body is first built as a lofted round-over when the full fillet fails (it never
 * silently comes out sharp).
 */
export function roundedBody(r: Replicad, L: Layout, zOutB: number, zOutF: number, rfT = L.rf, rfB = L.rfBack): Rounded {
  const d = L.dome;
  const cf = d?.front.crown ?? 0;
  const cb = d?.back.crown ?? 0;
  const t = L.params.wall_mm;
  // flat faces: a fillet per rim plane, else the lofted round-over (exact offsets: a circle's is a
  // revolved profile), smaller radii, a chamfer
  if (!cf && !cb) {
    const l = roundedOuter((i) => planDrawing(r, L.plan, t - i), zOutB, zOutF, rfT, rfB);
    if (l.how !== "sharp") return l;
  }
  let base = planDrawing(r, L.plan, t).sketchOnPlane("XY", zOutB - cb - 1).extrude(zOutF - zOutB + cf + cb + 2);
  const sphere = (dm: NonNullable<Layout["dome"]>["front"], z0: number, sign: 1 | -1) => {
    const zc = z0 - sign * Math.sqrt(dm.R * dm.R - dm.S * dm.S);
    // turned so the sphere's poles and seam lie far outside the body (a seam on the face would be filleted)
    return r.makeSphere(dm.R).rotate(90, [0, 0, 0], [1, 0, 0]).translate([dm.x, dm.y, zc]);
  };
  if (d && cf > 0) base = base.intersect(sphere(d.front, zOutF, 1));
  else base = base.intersect(r.makeBox([-1e3, -1e3, -1e3], [1e3, 1e3, zOutF]));
  if (d && cb > 0) base = base.intersect(sphere(d.back, zOutB, -1));
  else base = base.intersect(r.makeBox([-1e3, -1e3, zOutB], [1e3, 1e3, 1e3]));
  const zMid = (zOutF + zOutB) / 2;
  const span = (zOutF - zOutB) / 2;
  const fillet = (k: number): Rounded | undefined => {
    const rT = rfT * k;
    const rB = rfB * k;
    try {
      // the front and back rim edges only (a seam running front to back is not rounded)
      let s = base.fillet((e: Solid) => {
        const bb = e.boundingBox;
        if (bb.depth > span) return null;
        return bb.center[2] > zMid ? rT : rB;
      });
      s = s.intersect(r.makeBox([-1e3, -1e3, zOutB - cb], [1e3, 1e3, zOutF + cf]));
      if (r.measureVolume(s) > 0 && sound(s)) return { solid: s, r: rT, rBack: rB, how: "fillet" };
    } catch {
      // try a smaller radius
    }
    return undefined;
  };
  for (const k of [1, 0.85, 0.7, 0.55, 0.4, 0.25]) {
    const s = fillet(k);
    if (s) return s;
  }
  return { solid: base.intersect(r.makeBox([-1e3, -1e3, zOutB - cb], [1e3, 1e3, zOutF + cf])), r: 0, rBack: 0, how: "sharp" };
}

/** The cutting tool of an opening; `jitter` (mm) nudges its size and start when OpenCascade fails on the exact one. */
function cutterFor(r: Replicad, o: Opening, len: number, jitter = 0): Solid {
  const z0 = -0.8 - Math.abs(jitter);
  let tool: Solid;
  if (o.shape === "round") tool = r.makeCylinder(o.u / 2 + jitter, len + 0.3 * Math.abs(jitter) - z0, [0, 0, z0], [0, 0, 1]);
  else {
    const c = Math.min(o.corner, Math.min(o.u, o.v) / 2 - 0.01);
    const d = c > 0.05 ? r.drawRoundedRectangle(o.u + jitter, o.v + jitter, c) : r.drawRectangle(o.u + jitter, o.v + jitter);
    tool = d.sketchOnPlane("XY", z0).extrude(len + 0.3 * Math.abs(jitter) - z0);
  }
  return orient(tool, frameR(o.uAxis, o.vAxis, o.n)).translate(o.at);
}

function cylAlong(r: Replicad, d: number, from: number, to: number, base: Vec3, n: Vec3): Solid {
  const R = frameR(Math.abs(n[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1], [0, 1, 0], n);
  return orient(r.makeCylinder(d / 2, to - from, [0, 0, from], [0, 0, 1]), R).translate(base);
}

export async function buildCase(L: Layout): Promise<Built> {
  const r = await occt();
  const t = L.params.wall_mm;
  const tol = L.params.tolerance_mm;
  const notes: string[] = [];
  const zOutF = L.zFront + t;
  const zOutB = L.zBack - t;
  const prof = process.env.JUMPER_CASE_PROFILE ? (() => { let t0 = Date.now(); return (what: string) => { console.log(`[case] ${what} ${Date.now() - t0} ms`); t0 = Date.now(); }; })() : () => {};
  // Round 17: a flat-faced case is built with sharp rims (every boolean on a plain extrusion is fast
  // and sound) and rounded at the end by one intersection per shell with the rounded outer body; a
  // domed one is rounded from the start (its rim is where the dome meets the side).
  // The cavity first, filleted only (a lofted cavity makes OpenCascade's later fuses of ribs and
  // sleeve walls fail on a B-spline outline): where it gets less than planned, the outer rim is
  // kept small enough for the wall at the rim to stay MIN_WALL thick.
  // A drawn (B-spline) outline keeps a square-cornered cavity: OpenCascade's fuses of sleeve walls
  // into its filleted cavity leave the solid open (round 17, the round 15 pouch-tin outline).
  const spline = L.plan.kind === "poly" && !L.plan.exact;
  const cavR = roundedSlab(r, L.plan, 0, L.zBack, L.zFront, spline ? 0 : Math.max(0, L.rf - t), spline ? 0 : Math.max(0, L.rfBack - t), { loft: false });
  const capR = (want: number, ric: number) => (ric + 0.01 >= want - t ? want : Math.min(want, Math.max(0, (Math.SQRT2 * (t + ric) - ric - RIM_WALL) / (Math.SQRT2 - 1))));
  const rfT = capR(L.rf, cavR.r);
  const rfB = capR(L.rfBack, cavR.rBack);
  let edgeWhy = "";
  if (rfT + 0.05 < L.rf || rfB + 0.05 < L.rfBack) edgeWhy = `the cavity's inner corner is ${spline ? "square on a drawn outline (OpenCascade cannot fuse the sleeve walls and ribs into a rounded one there)" : "rounded less than planned (OpenCascade could not fillet it)"}, and a larger outer round-over would leave the wall under ${RIM_WALL} mm at the rim`;
  // Round 17: a flat-faced case is built with sharp rims (every boolean on a plain extrusion is fast
  // and sound) and rounded at the end by one intersection per shell with the rounded outer body; a
  // domed one is rounded from the start (its rim is where the dome meets the side).
  let outerR = L.kind === "rrect" && !L.dome ? roundedSlab(r, L.plan, t, zOutB, zOutF, rfT, rfB) : roundedBody(r, L, zOutB, zOutF, rfT, rfB);
  const roundLate = !L.dome && outerR.how !== "sharp" && (outerR.r > 0 || outerR.rBack > 0);
  const outer = roundLate ? planDrawing(r, L.plan, t).sketchOnPlane("XY", zOutB).extrude(zOutF - zOutB) : outerR.solid;
  if (L.dome) notes.push(`Domed faces: the front rises ${L.dome.front.crown.toFixed(1)} mm and the back ${L.dome.back.crown.toFixed(1)} mm above the flat wall, with a flat ${(2 * L.dome.front.plateau).toFixed(0)} mm land around the window and a flat ${(2 * L.dome.back.plateau).toFixed(0)} mm pad on the back (each shell prints on its flat).`);
  const cavity = cavR.solid;
  prof("outer + cavity");
  let shell = outer.cut(cavity);
  prof("shell");

  // tab (keychain / lanyard), part of the back shell (fused after the rims are rounded: it stands out of the outline)
  let tabPiece: Solid | undefined;
  if (L.tab) {
    const ob = planBounds(L.plan, t);
    const tb = L.tab;
    const top = tb.y + tb.h / 2;
    const bottom = ob.maxY - t - 1.5; // overlaps the wall
    const h = top - bottom;
    const rr = Math.min(tb.w / 2 - 0.01, 4);
    let tabS = r.drawRoundedRectangle(tb.w, h, rr).translate(tb.x, (top + bottom) / 2).sketchOnPlane("XY", tb.z0).extrude(tb.t);
    tabS = tabS.cut(r.makeCylinder(tb.hole / 2, tb.t + 2, [tb.x, top - tb.hole / 2 - 1.8, tb.z0 - 1], [0, 0, 1]));
    tabPiece = tabS.cut(cavity);
    if (!roundLate) shell = shell.fuse(tabPiece);
  }

  // part envelopes (bodies only, keep-outs not included) for the assembly STEP and the intersection check
  const envelopes: Built["envelopes"] = [];
  for (const p of L.placed) {
    const m = p.mech;
    const cut = Math.max(0, ...m.features.filter((f) => f.passThrough && f.n[2] > 0.5).map((f) => f.protrude));
    const h = Math.max(0.3, m.d - cut);
    let s: Solid | undefined;
    for (const fp of m.footprint) {
      const piece = fp.shape === "round" ? r.makeCylinder(fp.r, h, [fp.cx, fp.cy, 0], [0, 0, 1]) : r.makeBox([fp.cx - fp.hw, fp.cy - fp.hh, 0], [fp.cx + fp.hw, fp.cy + fp.hh, h]);
      s = s ? s.fuse(piece) : piece;
    }
    // mounting holes go through the board: the case's locating pins sit in them
    for (const hole of m.holes) {
      try {
        s = s!.cut(r.makeCylinder(hole.d / 2, h + 2, [hole.x, hole.y, -1], [0, 0, 1]));
      } catch {
        // keep the solid board (the intersection check is then stricter there)
      }
    }
    for (const f of m.features.filter((x) => x.passThrough && x.n[2] > 0.5)) s = s!.fuse(r.makeCylinder(Math.min(f.u, f.v) / 2, f.protrude, [f.tip[0], f.tip[1], f.tip[2] - f.protrude], [0, 0, 1]));
    envelopes.push({ id: m.id, shape: orient(s, p.R).translate(p.T), color: partColor(m.category) });
  }
  const ob = shell.boundingBox.bounds as [Vec3, Vec3];
  const big = (z0: number, z1: number) => r.makeBox([ob[0][0] - 20, ob[0][1] - 20, z0], [ob[1][0] + 20, ob[1][1] + 20, z1]);
  let front = shell.intersect(big(L.split, ob[1][2] + 5));
  let back = shell.intersect(big(ob[0][2] - 5, L.split));
  // Clipping to the rounded outer body is the slowest boolean here: skip it for a piece whose box
  // is well inside the cavity's plan (shrunk by the edge rounds) and within the wall planes.
  const zIn: [number, number] = [L.zBack - t + 0.05, L.zFront + t - 0.05];
  const inside = (s: Solid) => {
    const [lo, hi] = s.boundingBox.bounds as [Vec3, Vec3];
    if (lo[2] < zIn[0] || hi[2] > zIn[1]) return false;
    const inset = Math.max(L.ri, L.riBack) + 0.1;
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) if (!contains(L.plan, x, y, inset)) return false;
    return true;
  };
  // (round 17: against the rounded body even when the rims are rounded last: a piece filling the
  // sharp corner the rounding then trims makes OpenCascade leave the fuse open)
  const clip = (s: Solid) => (inside(s) ? s : s.intersect(outer));

  // closure
  if (L.lip) {
    const lip = L.lip;
    const outRing = (a: number, b: number) => planDrawing(r, L.plan, a).cut(planDrawing(r, L.plan, b));
    let lipS = outRing(-tol, -tol - lip.t).sketchOnPlane("XY", L.split - lip.h).extrude(lip.h + 0.01);
    lipS = lipS.fuse(outRing(t * 0.5, -tol - lip.t).sketchOnPlane("XY", L.split).extrude(0.8));
    if (lip.groove > 0.05) {
      lipS = lipS.fuse(outRing(-tol + lip.bead, -tol - 0.05).sketchOnPlane("XY", L.split - lip.h + 0.3).extrude(0.5));
      back = back.cut(outRing(lip.groove, -0.05).sketchOnPlane("XY", L.split - lip.h + 0.15).extrude(0.8));
    } else notes.push(`The ${t} mm wall is too thin for a snap groove (it would leave less than 1.2 mm), so the lip is a friction fit; use wall_mm 1.8 or more for a snap bead, or closure "screws".`);
    // the lip stops where a part sits against the wall (a USB port, a button)
    for (const p of L.placed) if (p.max[2] > L.split - lip.h - 0.5 && p.min[2] < L.split + 0.8) lipS = lipS.cut(r.makeBox([p.bodyMin[0] - 0.4, p.bodyMin[1] - 0.4, L.split - lip.h - 1], [p.bodyMax[0] + 0.4, p.bodyMax[1] + 0.4, L.split + 1]));
    // the split and its lip sit on the straight band of the side wall (the layout keeps the edge
    // rounds off it), where the ledge (half a wall deep) is inside the outer body: no clip needed
    front = front.fuse(lipS);
  }
  let screws: Built["screws"];
  if (L.bosses.length) {
    for (const b of L.bosses) {
      const fb = r.makeCylinder(b.od / 2, L.zFront + 0.3 - L.split, [b.x, b.y, L.split], [0, 0, 1]).cut(r.makeCylinder(1.6, 4.5, [b.x, b.y, L.split - 0.01], [0, 0, 1]));
      front = front.fuse(clip(fb));
      let bb = clip(r.makeCylinder(b.od / 2, L.split - (L.zBack - 0.3), [b.x, b.y, L.zBack - 0.3], [0, 0, 1]));
      back = back.fuse(bb);
      bb = r.makeCylinder(1.1, L.split - zOutB + 2, [b.x, b.y, zOutB - 1], [0, 0, 1]).fuse(r.makeCylinder(2.1, 2.5, [b.x, b.y, zOutB - 1], [0, 0, 1]));
      back = back.cut(bb);
    }
    const len = L.split - zOutB - 1.5 + 3;
    const std = [4, 5, 6, 8, 10, 12, 14, 16, 20, 25].find((s) => s >= len - 0.5 && s <= len + 1.5) ?? Math.round(len);
    screws = { count: L.bosses.length, size: `M2 x ${std} mm pan head`, inserts: "M2 x 3 mm brass heat-set inserts (3.2 mm hole), pressed into the front bosses with a soldering iron at ~220 °C" };
  }
  // ribs, posts and cradles are fused into each shell in one boolean (each fuse with the rounded
  // shell is slow; fusing the small pieces together first is not)
  const addF: Solid[] = [];
  const addB: Solid[] = [];
  for (const rib of L.ribs) {
    // a rib reaches 0.3 mm into the wall it hangs from (a sure fuse); round 15: only when it reaches
    // that wall: a held object's floor plate floats on its sleeve, and growing it would put it in the room
    const z0 = rib.shell === "back" && rib.min[2] - 0.3 <= L.zBack + 0.05 ? rib.min[2] - 0.3 : rib.min[2];
    const z1 = rib.shell === "front" && rib.max[2] + 0.3 >= L.zFront - 0.05 ? rib.max[2] + 0.3 : rib.max[2];
    const box = clip(r.makeBox([rib.min[0], rib.min[1], z0], [rib.max[0], rib.max[1], z1]));
    (rib.shell === "front" ? addF : addB).push(box);
  }
  for (const p of L.posts) {
    const z0 = p.shell === "back" ? p.z0 - 0.3 : p.z0;
    const z1 = p.shell === "front" ? p.z1 + 0.3 : p.z1;
    let s = r.makeCylinder(p.d / 2, z1 - z0, [p.x, p.y, z0], [0, 0, 1]);
    if (p.pin_d) s = s.fuse(p.shell === "back" ? r.makeCylinder(p.pin_d / 2, 1.5, [p.x, p.y, z1], [0, 0, 1]) : r.makeCylinder(p.pin_d / 2, 1.5, [p.x, p.y, z0 - 1.5], [0, 0, 1]));
    (p.shell === "front" ? addF : addB).push(clip(s));
  }
  for (const c of L.cradles) {
    const z0 = L.zBack - 0.3;
    const z1 = L.zBack + c.h;
    let ring = r.makeBox([c.min[0] - c.wall, c.min[1] - c.wall, z0], [c.max[0] + c.wall, c.max[1] + c.wall, z1]).cut(r.makeBox([c.min[0], c.min[1], z0 - 1], [c.max[0], c.max[1], z1 + 1]));
    // round 12: two strap slots through the long walls (a Kapton strap over the cell)
    for (const sl of c.slots ?? []) ring = ring.cut(r.makeBox([sl.min[0], sl.min[1], z0 - 1], [sl.max[0], sl.max[1], z1 + 1]));
    addB.push(clip(ring));
  }
  const fuseAll = (shell: Solid, pieces: Solid[], name: string) => {
    if (!pieces.length) return shell;
    const spare = pieces.map((q) => q.clone());
    let all = pieces[0]!;
    for (const q of pieces.slice(1)) all = all.fuse(q);
    const fused = shell.fuse(all);
    if (sound(fused)) return fused;
    // Round 15: a piece clipped to the rounded outer body (a held object's sleeve wall meeting the
    // rim fillet) can share a face with it, and OpenCascade's fuse then leaves the rim unsewn: an STL
    // with a gap all round the edge. Fuse piece by piece, nudging a piece that breaks the solid by a
    // few hundredths of a millimetre (z first, into the wall it already overlaps, then sideways), and
    // leave out one that still breaks it (said in the notes).
    let s = shell;
    let nudged = 0;
    const dropped: string[] = [];
    for (const q of spare) {
      let ok = false;
      const moves: Vec3[] = [[0, 0, 0], [0, 0, 0.02], [0, 0, -0.02], [0, 0, 0.05], [0, 0, -0.05], [0.03, 0, 0], [-0.03, 0, 0], [0, 0.03, 0], [0, -0.03, 0]];
      for (const mv of moves) {
        const dz = mv.some((v) => v !== 0);
        const tool = dz ? q.clone().translate(mv) : q.clone();
        let f: Solid;
        try {
          f = s.fuse(tool);
        } catch {
          continue;
        }
        if (!sound(f)) continue;
        s = f;
        ok = true;
        if (dz) nudged++;
        break;
      }
      if (!ok) {
        const [lo, hi] = q.boundingBox.bounds as [Vec3, Vec3];
        dropped.push(`(${lo.map((v) => v.toFixed(1)).join(", ")}) to (${hi.map((v) => v.toFixed(1)).join(", ")})`);
      }
    }
    if (nudged) notes.push(`${nudged} rib / wall piece(s) of the ${name} shell were fused 0.02-0.05 mm off their exact place (OpenCascade left the rounded rim open on the exact one; within the print tolerance).`);
    if (dropped.length) notes.push(`The ${name} shell has ${dropped.length} rib / wall piece(s) left out, at ${dropped.join("; ")} mm. Why: fusing them broke the solid in OpenCascade (the printed file would have had a gap). Fix: change wall_mm, gap_mm or the outline a little and design again; the case still closes without them.`);
    return s;
  };
  prof("closure + pieces");
  front = fuseAll(front, addF, "front");
  back = fuseAll(back, addB, "back");
  prof("fuse pieces");

  // openings through whichever shell they cross (a cut whose box misses a shell's box is skipped)
  const boxOf = (x: Solid) => x.boundingBox.bounds as [Vec3, Vec3];
  const cutIf = (shell: Solid, tool: Solid) => {
    const [a0, a1] = boxOf(shell);
    const [b0, b1] = boxOf(tool);
    for (let k = 0; k < 3; k++) if (b1[k]! < a0[k]! - 0.01 || b0[k]! > a1[k]! + 0.01) return shell;
    return shell.cut(tool);
  };
  // OpenCascade sometimes throws on a boolean between curved faces (a window through a domed,
  // filleted custom outline): the same cut is retried with the tool nudged by a few hundredths of a
  // millimetre (well inside the tolerances), then reported with what to change
  const cutOpening = (o: Opening, make: (jitter: number) => Solid) => {
    let last: unknown;
    let open: [Solid, Solid] | undefined;
    for (const j of [0, 0.03, -0.03, 0.07]) {
      try {
        const tool = make(j);
        const f2 = cutIf(front, tool);
        const b2 = cutIf(back, tool);
        // round 15: a cut can "succeed" and still leave a shell open (an STL with a gap): try the next
        // size; if every size does, keep the exact one and the watertight check reports it
        if ((f2 !== front && !sound(f2)) || (b2 !== back && !sound(b2))) {
          open ??= [f2, b2];
          continue;
        }
        front = f2;
        back = b2;
        if (j) notes.push(`The ${o.kind} for ${o.part} was cut ${Math.abs(j)} mm ${j > 0 ? "larger" : "smaller"} (OpenCascade failed on the exact size; within the print tolerance).`);
        return;
      } catch (e) {
        last = e;
      }
    }
    if (open) {
      [front, back] = open;
      return;
    }
    throw new Error(`OpenCascade could not cut the ${o.kind} for ${o.part} on the ${o.face}. Why: the boolean between that opening and this curved outline failed (${last instanceof Error ? last.message : "a kernel exception"}). Fix: change dome_mm or edge_radius_front_mm a little, or nudge the outline, and design again`);
  };
  const bodies: Body[] = [];
  const color = L.params.color;
  for (const o of L.openings) {
    const len = o.depth + 0.8;
    if (o.spot) {
      // flat recess on the outside round the port: from depth (the thinned wall) outwards
      const spotTool = orient(r.drawRoundedRectangle(o.u + 4, o.v + 4, Math.min(2, (o.v + 4) / 2 - 0.01)).sketchOnPlane("XY", o.depth).extrude(o.spot + 6), frameR(o.uAxis, o.vAxis, o.n)).translate(o.at);
      front = cutIf(front, spotTool);
      back = cutIf(back, spotTool);
    }
    // a grille's holes are cut in one boolean (a compound of the cylinders), from inside the cavity to past the outer surface
    prof(`before ${o.kind} ${o.part}`);
    cutOpening(o, (j) => (o.holes ? r.makeCompound(o.holes.map((h) => cylAlong(r, h.d + j, -0.8 - Math.abs(j), len + 0.6, h.at, o.n))) : cutterFor(r, o, len, j)));
    if (o.insert) {
      const ins = o.insert;
      if (ins.kind === "cap") {
        const s = cylAlong(r, ins.flange_d, 0, ins.flange_mm, ins.base, o.n).fuse(cylAlong(r, ins.d, 0, ins.length, ins.base, o.n));
        bodies.push({ name: `cap-${o.part}`, kind: "cap", shape: s, color: shade(color, -0.25), print: { face_down: "flat", supports: false, note: "standing on its flange, 0.12 mm layers" }, up: o.n, explode: [o.n[0] * 14, o.n[1] * 14, o.n[2] * 14] });
      } else {
        const s = cylAlong(r, ins.d, 0.3, 0.3 + ins.length, ins.base, o.n).fuse(cylAlong(r, ins.flange_d, o.standoff - 0.85, o.standoff - 0.05, ins.base, o.n));
        bodies.push({ name: `light-pipe-${o.part}`, kind: "light-pipe", shape: s, color: "#E8F4FF", print: { face_down: "flat", supports: false, note: "standing on its flange; clear PETG or clear resin; polish both ends" }, up: o.n, explode: [o.n[0] * 12, o.n[1] * 12, o.n[2] * 12] });
      }
    }
  }
  prof("openings");
  // round 17: the rims rounded last (one intersection per shell); never silently sharp: a lofted
  // round-over, then a chamfer, when the fillet's intersection leaves a shell open
  if (roundLate) {
    const z0 = zOutB;
    const z1 = zOutF;
    const at = (i: number) => planDrawing(r, L.plan, t - i);
    const tries: (() => Rounded | undefined)[] = [
      () => outerR,
      () => (outerR.how === "fillet" ? lofted(loftedSlab(at, z0, z1, outerR.r, outerR.rBack), "lofted") : undefined),
      () => lofted(loftedSlab(at, z0, z1, outerR.r, outerR.rBack, 2), "chamfer"),
    ];
    function lofted(s: Solid | undefined, how: EdgeHow): Rounded | undefined {
      return s ? { solid: s, r: outerR.r, rBack: outerR.rBack, how } : undefined;
    }
    let done = false;
    for (const mk of tries) {
      const o = mk();
      if (!o) continue;
      try {
        const f = front.intersect(o.solid);
        const b = back.intersect(o.solid);
        if (!sound(f) || !sound(b)) continue;
        front = f;
        back = b;
        outerR = o;
        done = true;
        break;
      } catch {
        // the next way of rounding
      }
    }
    if (!done) outerR = { solid: outer, r: 0, rBack: 0, how: "sharp" };
    if (tabPiece) {
      const ob2 = tabPiece.boundingBox.bounds as [Vec3, Vec3];
      if (ob2[1][2] <= L.split + 1e-6) back = back.fuse(tabPiece);
      else front = front.fuse(tabPiece);
    }
    prof("rims rounded");
  }
  if (outerR.r + 1e-6 < L.rf || outerR.rBack + 1e-6 < L.rfBack || outerR.how === "chamfer") notes.push(`The front / back edges are ${outerR.how === "chamfer" ? "chamfered (two facets) " : outerR.how === "sharp" ? "sharp " : "rounded "}${outerR.r.toFixed(1)} / ${outerR.rBack.toFixed(1)} mm${outerR.how === "chamfer" ? "" : ` instead of ${L.rf.toFixed(1)} / ${L.rfBack.toFixed(1)} mm`}. Why: ${edgeWhy || "OpenCascade could not round the planned radius on this outline"}. Fix: ${edgeWhy ? "a thicker wall (wall_mm 2) allows a larger round-over, or accept this one" : "a smoother outline (larger corner_radius_mm) or smaller edge_radius_front_mm / edge_radius_back_mm, and design again"}.`);
  const sep = Math.max(12, (ob[1][2] - ob[0][2]) * 0.9);
  bodies.unshift(
    { name: "front", kind: "shell", shape: front, color, print: { face_down: "front", supports: false, note: "front face on the bed (the window side down), open side up" }, up: [0, 0, -1], explode: [0, 0, sep] },
    { name: "back", kind: "shell", shape: back, color, print: { face_down: "back", supports: false, note: "back face on the bed, open side up" }, up: [0, 0, 1], explode: [0, 0, -sep] },
  );
  if (L.params.belt_clip) {
    const H = L.outer.h;
    const lenC = Math.min(50, Math.max(20, H * 0.6));
    const yTop = L.outer.max[1] - Math.max(4, H * 0.15);
    const zb = L.outer.min[2];
    let clipS = r.makeBox([-9, yTop - 7, zb - 3], [9, yTop, zb]);
    clipS = clipS.fuse(r.makeBox([-9, yTop - lenC, zb - 5], [9, yTop, zb - 3]));
    clipS = clipS.fuse(r.makeBox([-9, yTop - lenC, zb - 5], [9, yTop - lenC + 2, zb - 2.2]));
    bodies.push({ name: "belt-clip", kind: "clip", shape: clipS, color: shade(color, -0.35), print: { face_down: "flat", supports: false, note: "print on its side (the L profile flat on the bed) so the layers run along the spring; PETG; glue to the back with CA or VHB tape" }, up: [1, 0, 0], explode: [0, 0, -sep * 1.8] });
    notes.push("The belt clip is a separate PETG part glued to the back (CA glue or 3M VHB). It is not screwed: screws would hit the cell behind the back wall.");
  }

  void apply;
  return { bodies, envelopes, outer: outerR.solid, cavity, rf: outerR.r, rfBack: outerR.rBack, edgeHow: outerR.how, edgeWhy, notes, ...(screws ? { screws } : {}) };
}

export function partColor(category: string): string {
  return { board: "#2F6B4F", display: "#1C2430", sensor: "#3B5BA5", power: "#C9A227", input: "#7A7F8A", output: "#B5483B", communication: "#4B7F8C", motor: "#6B6F76" }[category] ?? "#5A6070";
}

export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k))));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
