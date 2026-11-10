/**
 * The case's plan (the outline seen from the front) for every shape. The cavity plan is sized so
 * every part fits; the outer plan is the cavity grown by the wall (a true 2D offset, so the wall is
 * the same thickness everywhere). Flats are straight cuts where a connector needs a flat wall.
 */

export type PlanKind = "rrect" | "stadium" | "circle" | "ellipse";

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
}

/** A point that must be inside the cavity, with the extra inset needed at its depth (front / back fillet). */
export interface Need {
  x: number;
  y: number;
  inset: number;
}

export function contains(p: Plan, x: number, y: number, inset = 0): boolean {
  for (const f of p.flats) if (f.sign * ((f.axis === "x" ? x : y) - f.at) > 1e-6 - (f.sign > 0 ? 0 : 0)) return false;
  const rc = p.flatCorner ?? 0;
  if (rc > 0.05 && p.flats.length && (p.kind === "circle" || p.kind === "stadium")) {
    // the rounded corner where a flat meets the curve (treated as a right-angle corner: conservative for the obtuse ones a flat makes)
    const dx0 = x - p.cx;
    const dy0 = y - p.cy;
    let curve: number;
    if (p.kind === "circle") curve = p.a - Math.hypot(dx0, dy0);
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
  let d;
  const { a, b } = p;
  switch (p.kind) {
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
  for (const f of p.flats) {
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
  return Math.abs(offset) > 1e-9 ? d.offset(offset) : d;
}
