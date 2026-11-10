/**
 * Round 7: the Case view's outline editor maths (browser side, no CAD). Points are in mm, y UP
 * (the device's top is +y), like the design_case {"points": [...], "smooth": true} outline the
 * server takes; the curve through them is the same closed centripetal Catmull-Rom spline the
 * server smooths them with.
 */
export type Pt = [number, number];

/** Closed centripetal Catmull-Rom curve through the points (`per` samples per span). */
export function smoothClosed(P: Pt[], per = 12): Pt[] {
  const n = P.length;
  if (n < 3) return P;
  const at = (i: number) => P[((i % n) + n) % n]!;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const td = (a: Pt, b: Pt) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t1 = td(p0, p1);
    const t2 = t1 + td(p1, p2);
    const t3 = t2 + td(p2, p3);
    for (let j = 0; j < per; j++) {
      const t = t1 + ((t2 - t1) * j) / per;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
        const u = (tb - t) / (tb - ta);
        const v = (t - ta) / (tb - ta);
        return [u * a[0] + v * b[0], u * a[1] + v * b[1]];
      };
      const A1 = lerp(p0, p1, 0, t1);
      const A2 = lerp(p1, p2, t1, t2);
      const A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, 0, t2);
      const B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  return out;
}

export function bounds(P: Pt[]): { minX: number; maxX: number; minY: number; maxY: number; w: number; h: number; cx: number; cy: number } {
  const xs = P.map((p) => p[0]);
  const ys = P.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Scale the points so the smooth curve through them is w x h mm (either may be undefined: uniform), centred on 0. */
export function fitTo(P: Pt[], w?: number, h?: number): Pt[] {
  const b = bounds(smoothClosed(P));
  if (b.w < 1e-6 || b.h < 1e-6) return P;
  const sx = w !== undefined ? w / b.w : h !== undefined ? h / b.h : 1;
  const sy = h !== undefined ? h / b.h : w !== undefined ? w / b.w : 1;
  return P.map(([x, y]) => [round((x - b.cx) * sx), round((y - b.cy) * sy)]);
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Starting outlines: a few control points (the server smooths through them). */
export const STARTS: { id: string; label: string }[] = [
  { id: "ellipse", label: "Ellipse" },
  { id: "pebble", label: "Pebble" },
  { id: "puck", label: "Puck" },
  { id: "pill", label: "Pill" },
  { id: "rounded-box", label: "Box" },
];

export function startPoints(kind: string, w = 60, h = 76): Pt[] {
  const a = w / 2;
  const b = h / 2;
  if (kind === "ellipse" || kind === "pebble" || kind === "puck") {
    const n = kind === "puck" ? 8 : 10;
    const [aa, bb] = kind === "puck" ? [Math.min(a, b), Math.min(a, b)] : [a, b];
    return fitTo(Array.from({ length: n }, (_, i) => [aa * Math.cos((i / n) * Math.PI * 2 + Math.PI / 2), bb * Math.sin((i / n) * Math.PI * 2 + Math.PI / 2)] as Pt), kind === "puck" ? Math.min(w, h) : w, kind === "puck" ? Math.min(w, h) : h);
  }
  if (kind === "pill") {
    const r = Math.min(a, b);
    const pts: Pt[] = [];
    for (let i = 0; i <= 4; i++) pts.push([r * Math.cos(Math.PI - (i / 4) * Math.PI), b - r + r * Math.sin(Math.PI - (i / 4) * Math.PI)]);
    pts.push([a, 0]);
    for (let i = 0; i <= 4; i++) pts.push([r * Math.cos(-(i / 4) * Math.PI), -b + r + r * Math.sin(-(i / 4) * Math.PI)]);
    pts.push([-a, 0]);
    return fitTo(pts.reverse(), w, h);
  }
  // a rounded box: corners pulled in a little so the smooth curve keeps straight-ish sides
  const c = Math.min(a, b) * 0.28;
  return fitTo(
    [
      [0, b],
      [-a + c, b],
      [-a, b - c],
      [-a, 0],
      [-a, -b + c],
      [-a + c, -b],
      [0, -b],
      [a - c, -b],
      [a, -b + c],
      [a, 0],
      [a, b - c],
      [a - c, b],
    ],
    w,
    h,
  );
}

/** About n points spread evenly round a closed polygon (to edit an outline the agent drew). */
export function resampleClosed(P: Pt[], n: number): Pt[] {
  if (P.length <= n) return P.map(([x, y]) => [round(x), round(y)]);
  const seg = P.map((p, i) => Math.hypot(P[(i + 1) % P.length]![0] - p[0], P[(i + 1) % P.length]![1] - p[1]));
  const L = seg.reduce((s, v) => s + v, 0);
  const out: Pt[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const want = (k * L) / n;
    while (acc + seg[i % P.length]! < want) acc += seg[i++ % P.length]!;
    const a = P[i % P.length]!;
    const b = P[(i + 1) % P.length]!;
    const t = seg[i % P.length]! > 0 ? (want - acc) / seg[i % P.length]! : 0;
    out.push([round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)]);
  }
  return out;
}

/** Index after which a new point at q goes: the span of the smooth curve nearest to q. */
export function insertIndex(P: Pt[], q: Pt): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i]!;
    const b = P[(i + 1) % P.length]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / (ex * ex + ey * ey || 1)));
    const d = Math.hypot(a[0] + ex * t - q[0], a[1] + ey * t - q[1]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Points to the {points, smooth} outline design_case takes. */
export function toOutline(P: Pt[]): { points: Pt[]; smooth: true } {
  return { points: P.map(([x, y]) => [round(x), round(y)]), smooth: true };
}
