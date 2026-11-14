/**
 * The case's plan (the outline seen from the front) for every shape. The cavity plan is sized so
 * every part fits; the outer plan is the cavity grown by the wall (a true 2D offset, so the wall is
 * the same thickness everywhere). Flats are straight cuts where a connector needs a flat wall.
 */

import { bsplinePoles, type Pt, signedArea } from "./outline.ts";

export type PlanKind = "rrect" | "stadium" | "circle" | "ellipse" | "poly";

export interface Flat {
  /** Which side: the flat keeps points with sign * (coord - at) <= 0, e.g. bottom = {axis:"y", sign:-1, at:-20} keeps y >= -20. */
  axis: "x" | "y";
  sign: 1 | -1;
  at: number;
}

export interface Plan {
  kind: PlanKind;
  cx: number;
  cy: number;
  /** Half sizes along x / y (circle: a = b = r; stadium: a, b half sizes, caps on the long axis). */
  a: number;
  b: number;
  /** rrect corner radius (cavity). */
  rc: number;
  flats: Flat[];
  /** Radius rounding the corners where a flat meets a circle / stadium (drawing only), so a large edge fillet can roll round them. */
  flatCorner?: number;
  /**
   * Round 7, kind "poly" (a custom outline): the OUTER outline is the normalised curve (bounding
   * box [-1, 1]²) scaled to half sizes (a + w0, b + w0) about (cx, cy); this plan is that outline
   * offset inwards by w0 (the cavity when w0 = the wall). `ctrl` are the Bézier chain's points,
   * `poly` its dense polygon (both normalised).
   */
  poly?: Pt[];
  ctrl?: Pt[];
  w0?: number;
  /**
   * Round 17: a preset shape at a fixed size (or one that follows a held object) is drawn exactly
   * for the CAD kernel: a circle, or a rounded rectangle whose OUTER corner radius is `r` x the outer
   * half size (the smaller of the two). Booleans and fillets on lines and arcs are fast and sound;
   * on the 64-pole B-spline they took minutes (round 17: a 2 mm rim on a fixed-size box).
   */
  exact?: { shape: "circle" | "rrect"; r: number };
}

/** A point that must be inside the cavity, with the extra inset needed at its depth (front / back fillet). */
export interface Need {
  x: number;
  y: number;
  inset: number;
  /** The part that needs it (fit reports). */
  part?: string;
}

export function contains(p: Plan, x: number, y: number, inset = 0): boolean {
  for (const f of p.flats) if (f.sign * ((f.axis === "x" ? x : y) - f.at) > 1e-6 - (f.sign > 0 ? 0 : 0)) return false;
  const rc = p.flatCorner ?? 0;
  if (rc > 0.05 && p.flats.length && (p.kind === "circle" || p.kind === "stadium" || p.kind === "poly")) {
    // the rounded corner where a flat meets the curve (treated as a right-angle corner: conservative for the obtuse ones a flat makes)
    const dx0 = x - p.cx;
    const dy0 = y - p.cy;
    let curve: number;
    if (p.kind === "poly") curve = polyDistance(p, x, y) - (p.w0 ?? 0);
    else if (p.kind === "circle") curve = p.a - Math.hypot(dx0, dy0);
    else {
      const r = Math.min(p.a, p.b);
      const half = Math.max(p.a, p.b) - r;
      const along = p.a >= p.b ? Math.abs(dx0) : Math.abs(dy0);
      const across = p.a >= p.b ? Math.abs(dy0) : Math.abs(dx0);
      curve = r - Math.hypot(Math.max(0, along - half), across);
    }
    curve -= inset;
    for (const f of p.flats) {
      const flat = -f.sign * ((f.axis === "x" ? x : y) - f.at) - inset;
      if (flat < rc && curve < rc && (rc - flat) ** 2 + (rc - curve) ** 2 > rc * rc + 1e-9) return false;
    }
  }
  const dx = x - p.cx;
  const dy = y - p.cy;
  switch (p.kind) {
    case "circle":
      return Math.hypot(dx, dy) <= p.a - inset + 1e-6;
    case "ellipse": {
      const a = p.a - inset;
      const b = p.b - inset;
      if (a <= 0 || b <= 0) return false;
      return (dx / a) ** 2 + (dy / b) ** 2 <= 1 + 1e-9;
    }
    case "stadium": {
      const along = p.a >= p.b ? Math.abs(dx) : Math.abs(dy);
      const across = p.a >= p.b ? Math.abs(dy) : Math.abs(dx);
      const r = Math.min(p.a, p.b);
      const half = Math.max(p.a, p.b) - r;
      const ex = Math.max(0, along - half);
      return Math.hypot(ex, across) <= r - inset + 1e-6;
    }
    case "poly":
      return polyContains(p, x, y, inset);
    case "rrect": {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax > p.a - inset + 1e-6 || ay > p.b - inset + 1e-6) return false;
      const rc = Math.max(0, p.rc - inset);
      const kx = p.a - inset - rc;
      const ky = p.b - inset - rc;
      if (ax > kx && ay > ky) return Math.hypot(ax - kx, ay - ky) <= rc + 1e-6;
      return true;
    }
  }
}

/** Distance from (x, y) along unit (ux, uy) to the cavity boundary (flats included). */
export function rayExit(p: Plan, x: number, y: number, ux: number, uy: number): number {
  if (!contains(p, x, y)) return 0;
  let lo = 0;
  let hi = 4 * Math.max(p.a, p.b) + 10;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (contains(p, x + ux * mid, y + uy * mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Sampled outline (counter-clockwise) of the plan grown by `offset` (negative = inward). */
export function outline(p: Plan, offset = 0, n = 180): [number, number][] {
  if (p.kind === "poly") {
    let poly = polyOuter(p, offset - (p.w0 ?? 0));
    for (const f of p.flats) poly = clip(poly, f.axis, f.sign, f.at + f.sign * offset);
    return poly;
  }
  // Sample the base shape by angle, then push each point along the outward normal by offset;
  // flats are applied by clipping the offset polygon.
  const raw: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ux = Math.cos(t);
    const uy = Math.sin(t);
    const base = { ...p, flats: [] };
    const d = rayExit(base, p.cx, p.cy, ux, uy);
    raw.push([p.cx + ux * d, p.cy + uy * d]);
  }
  const pts: [number, number][] = raw.map((pt, i) => {
    const prev = raw[(i + n - 1) % n]!;
    const next = raw[(i + 1) % n]!;
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    return [pt[0] + (ty / len) * offset, pt[1] - (tx / len) * offset];
  });
  let poly = pts;
  for (const f of p.flats) poly = clip(poly, f.axis, f.sign, f.at + f.sign * offset);
  return poly;
}

function clip(poly: [number, number][], axis: "x" | "y", sign: 1 | -1, at: number): [number, number][] {
  const k = axis === "x" ? 0 : 1;
  const inside = (q: [number, number]) => sign * (q[k] - at) <= 1e-9;
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (at - a[k]) / (b[k] - a[k]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export function bounds(poly: [number, number][]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

/** Exact bounds of the plan grown by offset (analytic for each kind, flats applied). */
export function planBounds(p: Plan, offset = 0): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = p.cx - p.a - offset;
  let maxX = p.cx + p.a + offset;
  let minY = p.cy - p.b - offset;
  let maxY = p.cy + p.b + offset;
  for (const f of p.flats) {
    const at = f.at + f.sign * offset;
    if (f.axis === "x") {
      if (f.sign > 0) maxX = Math.min(maxX, at);
      else minX = Math.max(minX, at);
    } else if (f.sign > 0) maxY = Math.min(maxY, at);
    else minY = Math.max(minY, at);
  }
  return { minX, maxX, minY, maxY };
}

// ---------------------------------------------------------------- sizing

function fitsAll(p: Plan, needs: Need[]): boolean {
  for (const q of needs) if (!contains({ ...p, flats: [] }, q.x, q.y, q.inset)) return false;
  return true;
}

/** Smallest scale s (multiplying a, b and rc) for which every need fits. */
function minScale(base: Plan, needs: Need[]): number {
  let lo = 0.01;
  let hi = 1;
  while (!fitsAll(scale(base, hi), needs)) {
    hi *= 1.5;
    if (hi > 1e4) return hi;
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fitsAll(scale(base, mid), needs)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function scale(p: Plan, s: number): Plan {
  if (p.kind === "poly") {
    const w0 = p.w0 ?? 0;
    return { ...p, a: (p.a + w0) * s - w0, b: (p.b + w0) * s - w0 };
  }
  return { ...p, a: p.a * s, b: p.b * s, rc: p.kind === "rrect" ? Math.min(p.rc, p.a * s, p.b * s) : p.rc };
}

function area(p: Plan): number {
  switch (p.kind) {
    case "circle":
      return Math.PI * p.a * p.a;
    case "ellipse":
      return Math.PI * p.a * p.b;
    case "stadium": {
      const r = Math.min(p.a, p.b);
      return Math.PI * r * r + 4 * r * (Math.max(p.a, p.b) - r);
    }
    case "rrect":
      return 4 * p.a * p.b - (4 - Math.PI) * p.rc * p.rc;
    case "poly":
      return Math.abs(signedArea(p.poly!)) * (p.a + (p.w0 ?? 0)) * (p.b + (p.w0 ?? 0));
  }
}

/**
 * Size a cavity plan of `kind` around the needs. `center` fixes the centre (e.g. the screen centre
 * for a puck); otherwise a small grid search picks the centre giving the smallest area.
 */
export function sizePlan(kind: PlanKind, needs: Need[], opts: { center?: [number, number]; centerX?: number; cornerRadius?: number } = {}): Plan {
  const xs = needs.map((q) => q.x);
  const ys = needs.map((q) => q.y);
  const bx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const by = (Math.min(...ys) + Math.max(...ys)) / 2;
  const hx = (Math.max(...xs) - Math.min(...xs)) / 2;
  const hy = (Math.max(...ys) - Math.min(...ys)) / 2;
  const centres: [number, number][] = [];
  if (opts.center) centres.push(opts.center);
  else if (kind === "rrect" || kind === "stadium") centres.push([bx, by]);
  else if (opts.centerX !== undefined) for (let j = -16; j <= 16; j++) centres.push([opts.centerX, by + j * 0.5]);
  else for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) centres.push([bx + i * 0.75, by + j * 0.75]);
  let best: Plan | undefined;
  const consider = (p: Plan) => {
    if (!best || area(p) < area(best) - 1e-9) best = p;
  };
  for (const [cx, cy] of centres) {
    if (kind === "circle") {
      const r = Math.max(...needs.map((q) => Math.hypot(q.x - cx, q.y - cy) + q.inset));
      consider({ kind, cx, cy, a: r, b: r, rc: 0, flats: [] });
    } else if (kind === "ellipse") {
      // Pebble: a gentle oval (aspect 1.08 to 1.35 along the longer content axis).
      const alongX = hx >= hy;
      for (let k = 1.08; k <= 1.351; k += 0.03) {
        const base: Plan = { kind, cx, cy, a: alongX ? k : 1, b: alongX ? 1 : k, rc: 0, flats: [] };
        consider(scale(base, minScale(base, needs)));
      }
    } else if (kind === "stadium") {
      const alongX = hx >= hy;
      const minR = Math.max(...needs.map((q) => (alongX ? Math.abs(q.y - cy) : Math.abs(q.x - cx)) + q.inset));
      for (let r = minR; r <= minR + 20; r += 0.25) {
        let half = r;
        let ok = true;
        for (const q of needs) {
          const along = alongX ? Math.abs(q.x - cx) : Math.abs(q.y - cy);
          const across = alongX ? Math.abs(q.y - cy) : Math.abs(q.x - cx);
          const rr = r - q.inset;
          if (across > rr) {
            ok = false;
            break;
          }
          half = Math.max(half, along + r - Math.sqrt(rr * rr - across * across));
        }
        if (!ok) continue;
        consider({ kind, cx, cy, a: alongX ? half : r, b: alongX ? r : half, rc: 0, flats: [] });
      }
    } else {
      const rc = opts.cornerRadius ?? 2.4;
      let a = Math.max(...needs.map((q) => Math.abs(q.x - cx) + q.inset));
      let b = Math.max(...needs.map((q) => Math.abs(q.y - cy) + q.inset));
      for (let i = 0; i < 400 && !fitsAll({ kind, cx, cy, a, b, rc: Math.min(rc, a, b), flats: [] }, needs); i++) {
        a += 0.1;
        b += 0.1;
      }
      consider({ kind, cx, cy, a, b, rc: Math.min(rc, a, b), flats: [] });
    }
  }
  return best!;
}

/** Replicad drawing of the plan grown by offset (a true 2D offset, so walls stay uniform). `r` is the replicad module. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function planDrawing(r: any, p: Plan, offset = 0): any {
  if (p.kind === "poly" && p.flats.length) {
    // a custom outline with a port flat: offset the curve alone (one smooth edge: robust), then cut
    // the flats at their own offset; offsetting the trimmed curve makes slivers the kernel chokes on
    let d = planDrawing(r, { ...p, flats: [] }, offset);
    const big = 4 * Math.max(p.a, p.b) + 40 + 2 * Math.abs(offset);
    for (const f0 of p.flats) {
      const at = f0.at + f0.sign * offset;
      const keep = f0.axis === "x" ? r.drawRectangle(big, big).translate(f0.sign > 0 ? at - big / 2 : at + big / 2, p.cy) : r.drawRectangle(big, big).translate(p.cx, f0.sign > 0 ? at - big / 2 : at + big / 2);
      d = d.intersect(keep);
      // round the corners where the flat meets the curve, concentric at every offset (uniform wall)
      const rc = (p.flatCorner ?? 0) + offset;
      if ((p.flatCorner ?? 0) > 0.05 && rc > 0.05) {
        const lo: [number, number] = f0.axis === "x" ? [at - 0.05, -1e4] : [-1e4, at - 0.05];
        const hi: [number, number] = f0.axis === "x" ? [at + 0.05, 1e4] : [1e4, at + 0.05];
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          d = d.fillet(rc, (c: any) => c.inBox(lo, hi));
        } catch {
          // keep the sharp corner: the edge fillet then falls back to a smaller radius
        }
      }
    }
    return d;
  }
  if (p.kind === "poly" && p.exact) {
    const w0e = p.w0 ?? 0;
    const off = offset - w0e;
    const A = p.a + w0e + off;
    const B = p.b + w0e + off;
    let e;
    if (p.exact.shape === "circle") e = r.drawCircle((A + B) / 2);
    else {
      const rc = p.exact.r * Math.min(p.a + w0e, p.b + w0e) + off;
      e = rc > 0.05 ? r.drawRoundedRectangle(2 * A, 2 * B, Math.min(rc, Math.min(A, B) - 1e-3)) : r.drawRectangle(2 * A, 2 * B);
    }
    return e.translate(p.cx, p.cy);
  }
  let d;
  const { a, b } = p;
  const w0 = p.kind === "poly" ? (p.w0 ?? 0) : 0;
  switch (p.kind) {
    case "poly":
      d = polyDrawing(r, p, w0);
      break;
    case "circle":
      d = r.drawCircle(a);
      break;
    case "ellipse":
      d = a >= b ? r.drawEllipse(a, b) : r.drawEllipse(b, a).rotate(90, [0, 0]);
      break;
    case "stadium":
      d = r.drawRoundedRectangle(2 * a, 2 * b, Math.min(a, b) - 1e-3);
      break;
    case "rrect":
      d = p.rc > 0.05 ? r.drawRoundedRectangle(2 * a, 2 * b, Math.min(p.rc, Math.min(a, b) - 1e-3)) : r.drawRectangle(2 * a, 2 * b);
      break;
  }
  d = d.translate(p.cx, p.cy);
  const big = 4 * Math.max(a, b) + 40;
  for (const f0 of p.flats) {
    // a poly plan's base drawing is the outer outline (w0 out): its flats move out with it
    const f = { ...f0, at: f0.at + f0.sign * w0 };
    // keep the half-plane sign * (coord - at) <= 0
    const keep = f.axis === "x" ? r.drawRectangle(big, big).translate(f.sign > 0 ? f.at - big / 2 : f.at + big / 2, p.cy) : r.drawRectangle(big, big).translate(p.cx, f.sign > 0 ? f.at - big / 2 : f.at + big / 2);
    d = d.intersect(keep);
    if ((p.flatCorner ?? 0) > 0.05 && (p.kind === "circle" || p.kind === "stadium")) {
      const lo: [number, number] = f.axis === "x" ? [f.at - 0.05, -1e4] : [-1e4, f.at - 0.05];
      const hi: [number, number] = f.axis === "x" ? [f.at + 0.05, 1e4] : [1e4, f.at + 0.05];
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        d = d.fillet(p.flatCorner!, (c: any) => c.inBox(lo, hi));
      } catch {
        // keep the sharp corner: the edge fillet then falls back to a smaller radius
      }
    }
  }
  const off = offset - w0;
  if (Math.abs(off) <= 1e-9) return d;
  if (p.kind !== "poly") return d.offset(off);
  try {
    const o = d.offset(off);
    if (o?.innerShape) return o;
  } catch {
    // below
  }
  // OpenCascade could not offset this curve (an empty result): a chain through the offset polygon instead
  return polyDrawing(r, p, offset).translate(p.cx, p.cy);
}

/** Plan grown by `off` (negative = inward): the same shape with the wall moved, flats included. */
export function growPlan(p: Plan, off: number): Plan {
  return { ...p, a: p.a + off, b: p.b + off, rc: p.rc + off, flats: p.flats.map((f) => ({ ...f, at: f.at + f.sign * off })), ...(p.kind === "poly" ? { w0: (p.w0 ?? 0) - off } : {}) };
}

// ---------------------------------------------------------------- custom outlines (kind "poly")

/** The outer outline (mm, case frame), pushed out by `off` along its normals (negative = in). */
export function polyOuter(p: Plan, off = 0): Pt[] {
  const w0 = p.w0 ?? 0;
  const A = p.a + w0;
  const B = p.b + w0;
  const P = p.poly!.map(([x, y]) => [p.cx + x * A, p.cy + y * B] as Pt);
  if (Math.abs(off) < 1e-9) return P;
  const m = P.length;
  return P.map((q, i) => {
    const a = P[(i - 1 + m) % m]!;
    const b = P[(i + 1) % m]!;
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    return [q[0] + (ty / l) * off, q[1] - (tx / l) * off] as Pt; // counter-clockwise: (ty, -tx) points out
  });
}

/** Replicad drawing of the plan's outline grown to `offset` (centred on the origin; the caller translates). Exact at offset = w0 (the outer outline). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function polyDrawing(r: any, p: Plan, offset: number): any {
  const w0 = p.w0 ?? 0;
  const A = p.a + w0;
  const B = p.b + w0;
  let ctrl: Pt[] = p.ctrl!.map(([x, y]) => [x * A, y * B]);
  if (Math.abs(offset - w0) > 1e-9) {
    const outer = polyOuter({ ...p, cx: 0, cy: 0 }, offset - w0);
    const step = outer.length / ctrl.length;
    ctrl = bsplinePoles(Array.from({ length: ctrl.length }, (_, i) => outer[Math.floor(i * step)]!));
  }
  // one periodic cubic B-spline edge (uniform knots), exactly the curve sampleBSpline traces
  const oc = r.getOC();
  const n = ctrl.length;
  const poles = new oc.NCollection_Array1_gp_Pnt2d(1, n);
  ctrl.forEach(([x, y], i) => poles.SetValue(i + 1, new oc.gp_Pnt2d(x, y)));
  const knots = new oc.NCollection_Array1_double(1, n + 1);
  const mults = new oc.NCollection_Array1_int(1, n + 1);
  for (let i = 0; i <= n; i++) {
    knots.SetValue(i + 1, i);
    mults.SetValue(i + 1, 1);
  }
  const curve = new oc.Geom2d_BSplineCurve(poles, knots, mults, 3, true);
  return new r.Drawing(new r.Blueprint([new r.Curve2D(curve)]));
}

interface Sdf {
  k: number;
  x0: number;
  y0: number;
  step: number;
  nx: number;
  ny: number;
  d: Float32Array;
  ref: Float64Array; // reference polygon (x, k·y) pairs, half width 1
}
const sdfCache = new WeakMap<Pt[], Map<string, Sdf>>();

function refDist(S: Sdf, X: number, Y: number): number {
  const R = S.ref;
  const n = R.length / 2;
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = R[2 * j]!;
    const ay = R[2 * j + 1]!;
    const bx = R[2 * i]!;
    const by = R[2 * i + 1]!;
    if (by > Y !== ay > Y && X < ((ax - bx) * (Y - by)) / (ay - by) + bx) inside = !inside;
    const ex = bx - ax;
    const ey = by - ay;
    const l2 = ex * ex + ey * ey || 1e-12;
    const t = Math.max(0, Math.min(1, ((X - ax) * ex + (Y - ay) * ey) / l2));
    const dx = ax + ex * t - X;
    const dy = ay + ey * t - Y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return inside ? d : -d;
}

/** Signed distance field of the outline at aspect k = B / A, in units of A (positive inside). */
let lastSdf: { poly: Pt[]; k: number; S: Sdf } | undefined;
function sdfOf(poly: Pt[], k: number): Sdf {
  if (lastSdf && lastSdf.poly === poly && Math.abs(lastSdf.k - k) < 1e-9) return lastSdf.S;
  const S = sdfBuild(poly, k);
  lastSdf = { poly, k, S };
  return S;
}

function sdfBuild(poly: Pt[], k: number): Sdf {
  const key = k.toFixed(6);
  let m = sdfCache.get(poly);
  if (!m) sdfCache.set(poly, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const ref = new Float64Array(poly.length * 2);
  poly.forEach(([x, y], i) => {
    ref[2 * i] = x;
    ref[2 * i + 1] = y * k;
  });
  const span = Math.max(1, k);
  const margin = 0.12 * span;
  const step = (2 * span + 2 * margin) / 150;
  const x0 = -1 - margin;
  const y0 = -k - margin;
  const nx = Math.ceil((2 + 2 * margin) / step) + 1;
  const ny = Math.ceil((2 * k + 2 * margin) / step) + 1;
  const S: Sdf = { k, x0, y0, step, nx, ny, d: new Float32Array(nx * ny), ref };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) S.d[j * nx + i] = refDist(S, x0 + i * step, y0 + j * step);
  if (m.size > 8) m.clear();
  m.set(key, S);
  return S;
}

let FAST = false;
/** Run f with the outline test on its distance field only (no exact check near the wall): packing searches, which keep their own margin. */
export function withFastOutline<T>(f: () => T): T {
  const was = FAST;
  FAST = true;
  try {
    return f();
  } finally {
    FAST = was;
  }
}

function polyContains(p: Plan, x: number, y: number, inset: number): boolean {
  const w0 = p.w0 ?? 0;
  const A = p.a + w0;
  const B = p.b + w0;
  if (A <= 0 || B <= 0) return false;
  const S = sdfOf(p.poly!, B / A);
  const X = (x - p.cx) / A;
  const Y = (y - p.cy) / A;
  const thr = (w0 + inset) / A;
  const fi = (X - S.x0) / S.step;
  const fj = (Y - S.y0) / S.step;
  if (fi < 0 || fj < 0 || fi >= S.nx - 1 || fj >= S.ny - 1) return false;
  const i = Math.floor(fi);
  const j = Math.floor(fj);
  const u = fi - i;
  const v = fj - j;
  const d = S.d;
  const val = (1 - u) * (1 - v) * d[j * S.nx + i]! + u * (1 - v) * d[j * S.nx + i + 1]! + (1 - u) * v * d[(j + 1) * S.nx + i]! + u * v * d[(j + 1) * S.nx + i + 1]!;
  if (FAST) return val >= thr;
  if (val - thr > 1.5 * S.step) return true;
  if (val - thr < -1.5 * S.step) return false;
  return refDist(S, X, Y) >= thr - 1e-6 / A;
}

/** Signed distance (mm) from (x, y) to the plan's outer outline, positive inside. */
export function polyDistance(p: Plan, x: number, y: number): number {
  const w0 = p.w0 ?? 0;
  const A = p.a + w0;
  const S = sdfOf(p.poly!, (p.b + w0) / A);
  return refDist(S, (x - p.cx) / A, (y - p.cy) / A) * A;
}

export interface PolySpec {
  poly: Pt[];
  ctrl: Pt[];
  /** Wall: the cavity sits this far inside the outline. */
  w0: number;
  /** Outer half sizes of the reference outline (fixed size: the asked size; auto: any, only the aspect counts). */
  A0: number;
  B0: number;
  /** true: the size is fixed (the plan is never scaled; the returned scale says how much it would need). */
  fixed: boolean;
  /** Quick search (check_fit, pack scoring): a coarser centre search. */
  quick?: boolean;
  /** Round 17: the outline's centre is fixed here (a case that follows a held object is concentric with it). */
  center?: [number, number];
}

/**
 * Size (auto) or place (fixed) a custom outline around the needs: the centre giving the smallest
 * scale is searched; returns the plan and the scale the needs ask for (1 = exactly the reference size).
 */
export function sizePoly(needs: Need[], spec: PolySpec): { plan: Plan; scale: number } {
  const xs = needs.map((q) => q.x);
  const ys = needs.map((q) => q.y);
  const bx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const by = (Math.min(...ys) + Math.max(...ys)) / 2;
  const hx = Math.max(1, (Math.max(...xs) - Math.min(...xs)) / 2);
  const hy = Math.max(1, (Math.max(...ys) - Math.min(...ys)) / 2);
  const mk = (cx: number, cy: number, s: number): Plan => ({ kind: "poly", cx, cy, a: spec.A0 * s - spec.w0, b: spec.B0 * s - spec.w0, rc: 0, flats: [], poly: spec.poly, ctrl: spec.ctrl, w0: spec.w0 });
  const ok = (cx: number, cy: number, q: Need, s: number) => polyContains(mk(cx, cy, s), q.x, q.y, q.inset);
  const minS = (cx: number, cy: number, cap: number): number => {
    const order = [...needs].sort((p, q) => Math.hypot(q.x - cx, q.y - cy) + q.inset - (Math.hypot(p.x - cx, p.y - cy) + p.inset));
    let s = 0.02;
    for (const q of order) {
      if (ok(cx, cy, q, s)) continue;
      let lo = s;
      let hi = Math.max(s * 1.3, 0.05);
      while (!ok(cx, cy, q, hi)) {
        lo = hi;
        hi *= 1.4;
        if (hi > cap * 1.4 + 1e-9) return Infinity;
      }
      for (let i = 0; i < (spec.quick ? 14 : 22); i++) {
        const mid = (lo + hi) / 2;
        if (ok(cx, cy, q, mid)) hi = mid;
        else lo = mid;
      }
      s = hi;
      if (s > cap) return Infinity;
    }
    return s;
  };
  if (spec.center) {
    const s0 = minS(spec.center[0], spec.center[1], 1e3) * (1 + 1e-4);
    return { plan: mk(spec.center[0], spec.center[1], spec.fixed ? 1 : s0), scale: s0 };
  }
  let best = { cx: bx, cy: by, s: minS(bx, by, 1e3) };
  let stepX = (hx * 0.6) / 3;
  let stepY = (hy * 0.6) / 3;
  const rounds = spec.quick ? 2 : 3;
  for (let r = 0; r < rounds; r++) {
    const c0 = { ...best };
    const N = r === 0 ? 3 : 2;
    for (let i = -N; i <= N; i++)
      for (let j = -N; j <= N; j++) {
        if (!i && !j) continue;
        const cx = c0.cx + i * stepX;
        const cy = c0.cy + j * stepY;
        const s = minS(cx, cy, best.s);
        if (s < best.s) best = { cx, cy, s };
      }
    stepX /= 2.5;
    stepY /= 2.5;
  }
  const s = best.s * (1 + 1e-4);
  return { plan: mk(best.cx, best.cy, spec.fixed ? 1 : s), scale: s };
}

