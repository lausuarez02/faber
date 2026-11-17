/**
 * Round 7: custom case outlines. The front view of the case, drawn by an agent or a person, as an
 * SVG path (y DOWN, like any drawing program) or a list of points (y UP, the case frame) with
 * optional smoothing. It is parsed into one closed curve, sharp corners rounded so they print,
 * checked (closed, one shape, not crossing itself, a sensible aspect), and turned into one closed
 * (periodic) cubic B-spline that both the CAD kernel (the real surface) and the packer (point in
 * outline, distance to the wall) use, so what is checked is what is printed.
 */
import type { CaseOutline } from "@faber/project-format";

export type Pt = [number, number];

/** Parsed outline in its own drawn units (mm), y up, centred on its bounding box, counter-clockwise. */
export interface ParsedOutline {
  /** Poles of the periodic cubic B-spline (normalised: the curve's bounding box is [-1, 1]²). */
  ctrl: Pt[];
  /** Dense polygon of the same curve (normalised), counter-clockwise. */
  poly: Pt[];
  /** Drawn size (mm) of the curve's bounding box. */
  w: number;
  h: number;
  /** What was changed on the way (corners rounded), for the report. */
  notes: string[];
}

export class OutlineError extends Error {
  readonly code = "bad-outline";
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  constructor(what: string, why: string, fix: string) {
    super(`${what}. Why: ${why}. Fix: ${fix}.`);
    this.name = "OutlineError";
    this.what = what;
    this.why = why;
    this.fix = fix;
  }
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

// ------------------------------------------------------------------ SVG path

/** SVG path data → polyline(s) (y flipped to point up). Each subpath is a list of points. */
export function svgPathToPolylines(d: string): { pts: Pt[]; closed: boolean }[] {
  const tokens: (string | number)[] = [];
  const re = /\s*(?:([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?))\s*,?/y;
  let i = 0;
  while (i < d.length) {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m || m[0].length === 0) {
      if (/\s|,/.test(d[i]!)) {
        i++;
        continue;
      }
      throw new OutlineError(`The outline path has "${d.slice(i, i + 12)}" at character ${i + 1}, which is not SVG path data`, "an SVG path is commands (M, L, H, V, C, S, Q, T, A, Z, lower case = relative) followed by numbers", 'write it like "M 0 -40 C 24 -40 30 0 30 10 ... Z", or pass {"points": [[x, y], ...], "smooth": true}');
    }
    tokens.push(m[1] ?? Number(m[2]));
    i = re.lastIndex;
  }
  if (typeof tokens[0] !== "string" || !/[Mm]/.test(tokens[0])) throw new OutlineError("The outline path does not start with M", "SVG path data starts with a move-to (M x y)", 'start it with "M x y"');
  const subs: { pts: Pt[]; closed: boolean }[] = [];
  let cur: { pts: Pt[]; closed: boolean } | undefined;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: Pt | undefined; // reflection of the previous cubic control
  let lastQ: Pt | undefined;
  let k = 0;
  let cmd = "";
  const num = (): number => {
    const v = tokens[k];
    if (typeof v !== "number") throw new OutlineError(`The outline path's "${cmd}" command is missing a number`, `it needs ${argCount(cmd)} numbers per segment`, "check the numbers after each letter");
    k++;
    return v;
  };
  const add = (p: Pt) => cur!.pts.push(p);
  const cubic = (p0: Pt, c1: Pt, c2: Pt, p3: Pt) => {
    const n = 24;
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      const u = 1 - t;
      add([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]]);
    }
  };
  const quad = (p0: Pt, c: Pt, p2: Pt) => {
    const n = 20;
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      const u = 1 - t;
      add([u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]]);
    }
  };
  while (k < tokens.length) {
    const t = tokens[k];
    if (typeof t === "string") {
      cmd = t;
      k++;
    } else if (!cmd || /[Zz]/.test(cmd)) throw new OutlineError("The outline path has numbers after Z", "Z closes the shape; numbers after it belong to no command", "remove them, or start a new command letter");
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (C) {
      case "M": {
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        cur = { pts: [[x, y]], closed: false };
        subs.push(cur);
        lastC = lastQ = undefined;
        break;
      }
      case "L":
        x = ox + num();
        y = oy + num();
        add([x, y]);
        lastC = lastQ = undefined;
        break;
      case "H":
        x = ox + num();
        add([x, y]);
        lastC = lastQ = undefined;
        break;
      case "V":
        y = oy + num();
        add([x, y]);
        lastC = lastQ = undefined;
        break;
      case "C": {
        const c1: Pt = [ox + num(), oy + num()];
        const c2: Pt = [ox + num(), oy + num()];
        const p: Pt = [ox + num(), oy + num()];
        cubic([x, y], c1, c2, p);
        lastC = c2;
        lastQ = undefined;
        [x, y] = p;
        break;
      }
      case "S": {
        const c1: Pt = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
        const c2: Pt = [ox + num(), oy + num()];
        const p: Pt = [ox + num(), oy + num()];
        cubic([x, y], c1, c2, p);
        lastC = c2;
        lastQ = undefined;
        [x, y] = p;
        break;
      }
      case "Q": {
        const c: Pt = [ox + num(), oy + num()];
        const p: Pt = [ox + num(), oy + num()];
        quad([x, y], c, p);
        lastQ = c;
        lastC = undefined;
        [x, y] = p;
        break;
      }
      case "T": {
        const c: Pt = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        const p: Pt = [ox + num(), oy + num()];
        quad([x, y], c, p);
        lastQ = c;
        lastC = undefined;
        [x, y] = p;
        break;
      }
      case "A": {
        const rx = Math.abs(num());
        const ry = Math.abs(num());
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const p: Pt = [ox + num(), oy + num()];
        for (const q of arcPoints([x, y], p, rx, ry, rot, large, sweep)) add(q);
        [x, y] = p;
        lastC = lastQ = undefined;
        break;
      }
      case "Z":
        if (cur) {
          cur.closed = true;
          x = sx;
          y = sy;
        }
        lastC = lastQ = undefined;
        break;
      default:
        throw new OutlineError(`The outline path has an unknown command "${cmd}"`, "SVG path commands are M L H V C S Q T A Z", "use only those");
    }
  }
  // SVG y points down: flip to the case frame (y up)
  return subs.map((s) => ({ closed: s.closed, pts: s.pts.map(([px, py]) => [px, -py] as Pt) }));
}

function argCount(cmd: string): number {
  return { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[cmd.toUpperCase()] ?? 2;
}

/** SVG elliptical arc (endpoint form) → points after the start (SVG spec F.6.5). */
function arcPoints(p0: Pt, p1: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean): Pt[] {
  if (rx < 1e-9 || ry < 1e-9 || (p0[0] === p1[0] && p0[1] === p1[1])) return [p1];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1) / ry;
  const cyp = (-co * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2;
  const cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(dt) / (Math.PI * 2)) * 72));
  const out: Pt[] = [];
  for (let j = 1; j <= n; j++) {
    const t = t1 + (dt * j) / n;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  out[out.length - 1] = p1;
  return out;
}

// ------------------------------------------------------------------ splines

/** Closed centripetal Catmull-Rom spline through the points, `per` samples per span. */
export function catmullRomClosed(P: Pt[], per = 16): Pt[] {
  const n = P.length;
  const out: Pt[] = [];
  const at = (i: number) => P[((i % n) + n) % n]!;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const td = (a: Pt, b: Pt) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0;
    const t1 = t0 + td(p0, p1);
    const t2 = t1 + td(p1, p2);
    const t3 = t2 + td(p2, p3);
    for (let j = 0; j < per; j++) {
      const t = t1 + ((t2 - t1) * j) / per;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
        const u = (tb - t) / (tb - ta);
        const v = (t - ta) / (tb - ta);
        return [u * a[0] + v * b[0], u * a[1] + v * b[1]];
      };
      const A1 = lerp(p0, p1, t0, t1);
      const A2 = lerp(p1, p2, t1, t2);
      const A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2);
      const B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  return out;
}

/**
 * Poles of the closed uniform cubic B-spline that passes through the points (periodic
 * interpolation: (P[i-1] + 4 P[i] + P[i+1]) / 6 = Q[i], solved by Gauss-Seidel; diagonally dominant).
 * One periodic C2 curve: OpenCascade fillets and offsets it like an ellipse (one edge, no seams).
 */
export function bsplinePoles(Q: Pt[]): Pt[] {
  const n = Q.length;
  const P: Pt[] = Q.map((q) => [q[0], q[1]]);
  for (let it = 0; it < 80; it++) {
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const a = P[(i - 1 + n) % n]!;
      const b = P[(i + 1) % n]!;
      const x = (6 * Q[i]![0] - a[0] - b[0]) / 4;
      const y = (6 * Q[i]![1] - a[1] - b[1]) / 4;
      delta = Math.max(delta, Math.abs(x - P[i]![0]), Math.abs(y - P[i]![1]));
      P[i] = [x, y];
    }
    if (delta < 1e-10) break;
  }
  return P;
}

/** Dense polygon of the closed uniform cubic B-spline with these poles (`per` points per span). */
export function sampleBSpline(P: Pt[], per = 8): Pt[] {
  const n = P.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n]!;
    const p1 = P[i]!;
    const p2 = P[(i + 1) % n]!;
    const p3 = P[(i + 2) % n]!;
    for (let j = 0; j < per; j++) {
      const u = j / per;
      const b0 = (1 - u) ** 3 / 6;
      const b1 = (3 * u ** 3 - 6 * u ** 2 + 4) / 6;
      const b2 = (-3 * u ** 3 + 3 * u ** 2 + 3 * u + 1) / 6;
      const b3 = u ** 3 / 6;
      out.push([b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ polygon helpers

export function signedArea(P: Pt[]): number {
  let a = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i]!;
    const q = P[(i + 1) % P.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function perimeter(P: Pt[]): number {
  let L = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i]!;
    const q = P[(i + 1) % P.length]!;
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return L;
}

/** Resample a closed polygon to n points evenly spaced along its length. */
export function resample(P: Pt[], n: number): Pt[] {
  const L = perimeter(P);
  const out: Pt[] = [];
  let seg = 0;
  let acc = 0;
  const len = (i: number) => {
    const p = P[i % P.length]!;
    const q = P[(i + 1) % P.length]!;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  };
  for (let k = 0; k < n; k++) {
    const want = (k * L) / n;
    while (acc + len(seg) < want && seg < P.length * 2) {
      acc += len(seg);
      seg++;
    }
    const p = P[seg % P.length]!;
    const q = P[(seg + 1) % P.length]!;
    const l = len(seg) || 1;
    const t = Math.max(0, Math.min(1, (want - acc) / l));
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

function segX(a: Pt, b: Pt, c: Pt, d: Pt): Pt | undefined {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return undefined;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) return [a[0] + r[0] * t, a[1] + r[1] * t];
  return undefined;
}

/** First crossing of two non-neighbouring edges, if any. */
export function selfIntersection(P: Pt[]): Pt | undefined {
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[i]!;
    const b = P[(i + 1) % n]!;
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]);
    const maxY = Math.max(a[1], b[1]);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = P[j]!;
      const d = P[(j + 1) % n]!;
      if (Math.max(c[0], d[0]) < minX || Math.min(c[0], d[0]) > maxX || Math.max(c[1], d[1]) < minY || Math.min(c[1], d[1]) > maxY) continue;
      const x = segX(a, b, c, d);
      if (x) return x;
    }
  }
  return undefined;
}

/** Round every corner sharper than ~30° of turn with a quadratic blend of reach `r` (limited by the neighbours). */
function roundCorners(P: Pt[], r: number): { pts: Pt[]; count: number } {
  const n = P.length;
  const turn = (i: number) => {
    const a = P[(i - 1 + n) % n]!;
    const b = P[i]!;
    const c = P[(i + 1) % n]!;
    const u = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const v = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = v - u;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  };
  const corners = new Set<number>();
  for (let i = 0; i < n; i++) if (turn(i) > (30 * Math.PI) / 180) corners.add(i);
  if (!corners.size) return { pts: P, count: 0 };
  // walk along the polygon `reach` from vertex i, forwards (+1) or backwards (-1)
  const walk = (i: number, dir: 1 | -1, reach: number): Pt => {
    let k = i;
    let left = reach;
    for (let guard = 0; guard < n; guard++) {
      const a = P[k]!;
      const k2 = (k + dir + n) % n;
      const b = P[k2]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l >= left) return [a[0] + ((b[0] - a[0]) * left) / l, a[1] + ((b[1] - a[1]) * left) / l];
      left -= l;
      k = k2;
    }
    return P[i]!;
  };
  // distance to the next corner along the outline, to keep blends from overlapping
  const out: Pt[] = [];
  const skipUntil = new Map<number, number>();
  const sorted = [...corners].sort((a, b) => a - b);
  const arcTo = (i: number, dir: 1 | -1) => {
    let k = i;
    let L = 0;
    for (let guard = 0; guard < n; guard++) {
      const k2 = (k + dir + n) % n;
      L += Math.hypot(P[k2]![0] - P[k]![0], P[k2]![1] - P[k]![1]);
      k = k2;
      if (corners.has(k)) break;
    }
    return L;
  };
  const blend = new Map<number, Pt[]>();
  for (const i of sorted) {
    const reach = Math.min(r, arcTo(i, 1) * 0.45, arcTo(i, -1) * 0.45);
    const a = walk(i, -1, reach);
    const c = walk(i, 1, reach);
    const b = P[i]!;
    const pts: Pt[] = [];
    for (let j = 0; j <= 8; j++) {
      const t = j / 8;
      const u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]);
    }
    blend.set(i, pts);
    skipUntil.set(i, reach);
  }
  // rebuild: drop original vertices within reach of a corner, insert the blend
  const near = (k: number) => {
    for (const i of sorted) {
      const reach = skipUntil.get(i)!;
      const d = Math.hypot(P[k]![0] - P[i]![0], P[k]![1] - P[i]![1]);
      if (k !== i && d < reach * 0.999) return true;
    }
    return false;
  };
  for (let k = 0; k < n; k++) {
    if (blend.has(k)) out.push(...blend.get(k)!);
    else if (!near(k)) out.push(P[k]!);
  }
  return { pts: out, count: corners.size };
}

// ------------------------------------------------------------------ parse

/** Parse and check an outline. Throws OutlineError (what / why / fix) when it cannot be a case. */
export function parseOutline(o: CaseOutline | undefined): ParsedOutline {
  if (o === undefined || o === null) throw new OutlineError('Shape "custom" needs an outline', "a custom case is whatever front outline you draw, and none was given", 'pass outline: an SVG path in mm ("M 0 -40 C ... Z") or {"points": [[x, y], ...], "smooth": true}; or pick a preset shape (pebble, puck, pill, rounded-box, keychain)');
  let raw: Pt[];
  const notes: string[] = [];
  let smoothInput = false;
  // positions in messages are in the drawing's own coordinates (SVG: y down)
  const yOut = (y: number) => (typeof o === "string" ? -y : y);
  if (typeof o === "string") {
    const subs = svgPathToPolylines(o).filter((s) => s.pts.length > 1);
    if (!subs.length) throw new OutlineError("The outline path draws nothing", "it has a move-to but no segments", "add segments (L, C, Q, A ...) and end with Z");
    if (subs.length > 1) throw new OutlineError(`The outline path has ${subs.length} separate shapes`, "a case outline is one closed shape (holes and islands cannot be printed as one shell)", "draw one shape: one M at the start, Z at the end");
    const s = subs[0]!;
    raw = s.pts;
    const first = raw[0]!;
    const last = raw[raw.length - 1]!;
    const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
    const span = Math.max(...raw.map((p) => Math.hypot(p[0] - first[0], p[1] - first[1])));
    if (!s.closed && gap > Math.max(0.5, span * 0.02)) throw new OutlineError(`The outline is not closed: it ends ${f1(gap)} mm from where it starts`, "a case outline must be one closed loop", 'end the path with Z (or finish the last segment at the starting point)');
    if (gap < 1e-6) raw = raw.slice(0, -1);
  } else {
    const pts = o.points;
    if (!Array.isArray(pts) || pts.length < 3) throw new OutlineError("The outline needs at least 3 points", `it has ${Array.isArray(pts) ? pts.length : 0}`, "give [[x, y], ...] around the shape (6 to 16 points with smooth: true make a good organic shape)");
    for (const p of pts) if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new OutlineError(`The outline point ${JSON.stringify(p)} is not [x, y]`, "each point is two numbers in mm", "write points as [[0, 40], [28, 10], ...]");
    raw = pts.map((p) => [p[0], p[1]] as Pt);
    const f = raw[0]!;
    const l = raw[raw.length - 1]!;
    if (raw.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) raw = raw.slice(0, -1);
    smoothInput = o.smooth !== false;
  }
  // de-duplicate
  const dd: Pt[] = [];
  for (const p of raw) {
    const q = dd[dd.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) dd.push(p);
  }
  while (dd.length > 2 && Math.hypot(dd[0]![0] - dd[dd.length - 1]![0], dd[0]![1] - dd[dd.length - 1]![1]) < 1e-6) dd.pop();
  if (dd.length < 3) throw new OutlineError("The outline has fewer than 3 distinct points", "a closed shape needs at least 3", "add points around the shape");
  let w = Math.max(...dd.map((p) => p[0])) - Math.min(...dd.map((p) => p[0]));
  let h = Math.max(...dd.map((p) => p[1])) - Math.min(...dd.map((p) => p[1]));
  if (w < 1e-6 || h < 1e-6) throw new OutlineError("The outline is flat (all points on one line)", "a case needs width and height", "spread the points around a shape");
  // check the drawn polygon itself before smoothing hides a crossing
  const xRaw = smoothInput ? selfIntersection(dd) : undefined;
  let curve: Pt[] = smoothInput ? catmullRomClosed(dd, 16) : dd;
  if (signedArea(curve) < 0) curve = curve.reverse();
  const size = Math.max(w, h);
  if (!smoothInput) {
    // keep the drawn corners printable: round each sharp corner (reach ~10 % of the size, at least 2 mm)
    const rc = roundCorners(curve, Math.max(2, size * 0.1));
    if (rc.count) notes.push(`${rc.count} sharp corner${rc.count > 1 ? "s were" : " was"} rounded so the shell prints and the edge can be rounded.`);
    curve = rc.pts;
  }
  const dense = resample(curve, 400);
  const x = selfIntersection(dense) ?? xRaw;
  if (x) throw new OutlineError(`The outline crosses itself near (${f1(x[0])}, ${f1(yOut(x[1]))}) mm`, "a case wall cannot pass through itself", "move the points so the line goes round the shape once without crossing (list them in order round the edge)");
  if (Math.abs(signedArea(dense)) < 0.05 * w * h) throw new OutlineError("The outline encloses almost no area", "it is a thin sliver", "draw a fuller shape");
  // the chain: control points evenly spaced, about every 4 % of the length (32 to 72 of them)
  const L = perimeter(dense);
  const M = Math.max(32, Math.min(72, Math.round(L / (size * 0.04))));
  let ctrl = bsplinePoles(resample(dense, M));
  let poly = sampleBSpline(ctrl, 8);
  // normalise to the chain's own bounding box
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  w = maxX - minX;
  h = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const norm = (p: Pt): Pt => [(p[0] - cx) / (w / 2), (p[1] - cy) / (h / 2)];
  ctrl = ctrl.map(norm);
  poly = poly.map(norm);
  const aspect = Math.max(w / h, h / w);
  if (aspect > 8) throw new OutlineError(`The outline is ${f1(w)} x ${f1(h)}, ${f1(aspect)} times longer than it is wide`, "a case thinner than an eighth of its length cannot hold boards and prints badly", "make it fuller (at most 8:1)");
  const x2 = selfIntersection(poly);
  if (x2) throw new OutlineError(`The smoothed outline crosses itself near (${f1(x2[0] * (w / 2) + cx)}, ${f1(yOut(x2[1] * (h / 2) + cy))}) mm`, "two parts of the outline are too close for the smooth curve", "space the points further apart there, or use fewer points");
  return { ctrl, poly, w, h, notes };
}

/**
 * Problems of an outline at its final size: a neck narrower than the wall can hold (the cavity
 * would pinch shut there) and a tip too sharp to print. `P` is the outer outline in mm.
 */
export function outlineFeatureIssues(P: Pt[], wall: number): string[] {
  const out: string[] = [];
  const n = P.length;
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + Math.hypot(P[i]![0] - P[i - 1]![0], P[i]![1] - P[i - 1]![1]));
  const L = cum[n - 1]! + Math.hypot(P[0]![0] - P[n - 1]![0], P[0]![1] - P[n - 1]![1]);
  const minNeck = 2 * wall + 4;
  let worst: { d: number; at: Pt } | undefined;
  for (let i = 0; i < n; i += 2)
    for (let j = i + 2; j < n; j += 2) {
      const arc = Math.min(Math.abs(cum[j]! - cum[i]!), L - Math.abs(cum[j]! - cum[i]!));
      if (arc < minNeck * 2.2) continue;
      const d = Math.hypot(P[i]![0] - P[j]![0], P[i]![1] - P[j]![1]);
      if (d < minNeck && (!worst || d < worst.d)) worst = { d, at: [(P[i]![0] + P[j]![0]) / 2, (P[i]![1] + P[j]![1]) / 2] };
    }
  if (worst) out.push(`The outline is only ${f1(worst.d)} mm across near (${f1(worst.at[0])}, ${f1(worst.at[1])}). Why: with a ${wall} mm wall on each side there is no room inside there (at least ${f1(minNeck)} mm is needed). Fix: widen that part of the outline or make the case bigger.`);
  return out;
}

// ------------------------------------------------------------------ presets as outlines

/** Dense outline (mm, y up, centred) of a preset shape at w x h: what a preset becomes at a fixed size. */
export function presetPoints(shape: string, w: number, h: number, corner = 4): Pt[] {
  const a = w / 2;
  const b = h / 2;
  const n = 240;
  const out: Pt[] = [];
  if (shape === "pebble" || shape === "puck" || shape === "custom") {
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      out.push([a * Math.cos(t), b * Math.sin(t)]);
    }
    return out;
  }
  // stadium (pill) or rounded rectangle (box, keychain): straight sides, round corners of radius r
  const r = shape === "pill" ? Math.min(a, b) - 1e-3 : Math.max(0.5, Math.min(corner, a - 0.01, b - 0.01));
  const corners: [number, number, number][] = [
    [a - r, b - r, 0],
    [-a + r, b - r, Math.PI / 2],
    [-a + r, -b + r, Math.PI],
    [a - r, -b + r, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, t0] of corners)
    for (let j = 0; j <= 15; j++) {
      const t = t0 + (j / 15) * (Math.PI / 2);
      out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  return out;
}

/** A preset shape as a parsed outline (used when a preset gets a fixed size_mm). */
export function presetOutline(shape: string, w: number, h: number, corner = 4): ParsedOutline {
  const dense = resample(presetPoints(shape, w, h, corner), 400);
  let ctrl = bsplinePoles(resample(dense, 64));
  let poly = sampleBSpline(ctrl, 8);
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const W = Math.max(...xs) - Math.min(...xs);
  const H = Math.max(...ys) - Math.min(...ys);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const norm = (p: Pt): Pt => [(p[0] - cx) / (W / 2), (p[1] - cy) / (H / 2)];
  ctrl = ctrl.map(norm);
  poly = poly.map(norm);
  return { ctrl, poly, w: W, h: H, notes: [] };
}
