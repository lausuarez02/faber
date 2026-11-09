/**
 * Orthogonal wire routing for drawings (screenshots, the canvas): a wire leaves its pin away from
 * its own part, then takes the 3-segment path (one horizontal or vertical channel) that crosses
 * the fewest part bodies and labels, shortest first. Pure and deterministic; it only changes how
 * wires are drawn, never the circuit.
 */

export interface RoutePoint {
  x: number;
  y: number;
}

export interface RouteBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Side = "top" | "bottom" | "left" | "right";

const STUB = 14;
const CLEAR = 12;
/** How far around the wire's ends parts are considered. */
const REACH = 400;
/** Most channel candidates per axis for detours. */
const MAX_CHANNELS = 24;

function sideOf(p: RoutePoint, b: RouteBox | undefined): Side {
  if (!b) return "top";
  const d: [Side, number][] = [
    ["top", Math.abs(p.y - b.y)],
    ["bottom", Math.abs(b.y + b.h - p.y)],
    ["left", Math.abs(p.x - b.x)],
    ["right", Math.abs(b.x + b.w - p.x)],
  ];
  d.sort((a, c) => a[1] - c[1]);
  return d[0]![0];
}

/** The point just outside the pin's part, straight out from the nearest edge. */
function stub(p: RoutePoint, b: RouteBox | undefined): RoutePoint {
  if (!b) return p;
  switch (sideOf(p, b)) {
    case "top":
      return { x: p.x, y: Math.min(p.y, b.y) - STUB };
    case "bottom":
      return { x: p.x, y: Math.max(p.y, b.y + b.h) + STUB };
    case "left":
      return { x: Math.min(p.x, b.x) - STUB, y: p.y };
    default:
      return { x: Math.max(p.x, b.x + b.w) + STUB, y: p.y };
  }
}

/** Does the axis-aligned segment a→b pass through the inside of box r? */
function crosses(a: RoutePoint, b: RoutePoint, r: RouteBox): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return x1 > r.x + 1 && x0 < r.x + r.w - 1 && y1 > r.y + 1 && y0 < r.y + r.h - 1;
}

function cost(points: RoutePoint[], boxes: RouteBox[]): number {
  let hits = 0;
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    len += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    // The stubs (first and last segment) leave the pin's own part by construction.
    if (i === 1 || i === points.length - 1) continue;
    for (const r of boxes) if (crosses(a, b, r)) hits++;
  }
  return hits * 100_000 + len + (points.length - 2) * 30;
}

/**
 * Route a wire from pin `a` (on part box `from`) to pin `z` (on `to`), avoiding `boxes` (every part
 * body, with its label area). Returns the polyline including both pins.
 */
export function routeWire(a: RoutePoint, z: RoutePoint, boxes: RouteBox[], from?: string, to?: string): RoutePoint[] {
  const fa = boxes.find((b) => b.id === from);
  const fz = boxes.find((b) => b.id === to);
  const sa = stub(a, fa);
  const sz = stub(z, fz);
  // Only parts near the wire matter (keeps big canvases fast).
  const span = { x0: Math.min(sa.x, sz.x) - REACH, x1: Math.max(sa.x, sz.x) + REACH, y0: Math.min(sa.y, sz.y) - REACH, y1: Math.max(sa.y, sz.y) + REACH };
  boxes = boxes.filter((b) => b.x < span.x1 && b.x + b.w > span.x0 && b.y < span.y1 && b.y + b.h > span.y0);
  const ys = new Set<number>([(sa.y + sz.y) / 2, sa.y, sz.y]);
  const xs = new Set<number>([(sa.x + sz.x) / 2, sa.x, sz.x]);
  for (const b of boxes) {
    ys.add(b.y - CLEAR);
    ys.add(b.y + b.h + CLEAR);
    xs.add(b.x - CLEAR);
    xs.add(b.x + b.w + CLEAR);
  }
  let best: RoutePoint[] = [a, sa, { x: sa.x, y: (sa.y + sz.y) / 2 }, { x: sz.x, y: (sa.y + sz.y) / 2 }, sz, z];
  let bestCost = cost(best, boxes);
  const consider = (mid: RoutePoint[]) => {
    const raw = [a, sa, ...mid, sz, z];
    const c = cost(raw, boxes);
    if (c < bestCost) {
      bestCost = c;
      best = raw;
    }
  };
  for (const y of ys) consider([{ x: sa.x, y }, { x: sz.x, y }]);
  for (const x of xs) consider([{ x, y: sa.y }, { x, y: sz.y }]);
  if (bestCost < 100_000) return dedupe(best);
  // No clean single-channel path: try going around (two channels joined by a third).
  const near = (vals: Set<number>, mid: number) => [...vals].sort((u, v) => Math.abs(u - mid) - Math.abs(v - mid)).slice(0, MAX_CHANNELS);
  const yl = near(ys, (sa.y + sz.y) / 2);
  const xl = near(xs, (sa.x + sz.x) / 2);
  for (const y1 of yl) for (const x of xl) for (const y2 of yl) consider([{ x: sa.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: sz.x, y: y2 }]);
  for (const x1 of xl) for (const y of yl) for (const x2 of xl) consider([{ x: x1, y: sa.y }, { x: x1, y }, { x: x2, y }, { x: x2, y: sz.y }]);
  return dedupe(best);
}

function dedupe(pts: RoutePoint[]): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) continue;
    // Drop the middle of three collinear points when the line keeps going the same way.
    const o = out[out.length - 2];
    const between = (u: number, v: number, w: number) => (v - u) * (w - v) >= 0;
    if (o && q && ((Math.abs(o.x - q.x) < 0.01 && Math.abs(q.x - p.x) < 0.01 && between(o.y, q.y, p.y)) || (Math.abs(o.y - q.y) < 0.01 && Math.abs(q.y - p.y) < 0.01 && between(o.x, q.x, p.x)))) out.pop();
    out.push(p);
  }
  return out;
}

/** SVG path data for a routed polyline. */
export function routePath(points: RoutePoint[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`).join(" ");
}
