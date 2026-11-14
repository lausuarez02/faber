/**
 * Round 8: the automatic distribution optimizer (engine case-4).
 *
 * Every part is a box (its envelope: dimensions + keep-outs + swell) with a few ways to sit
 * ("variants": turned 0 / 90 in plan, stood on its edge where allowed, a port on another side) and
 * a depth mode (against the front, against the back, or in the middle of the depth). For a cavity
 * depth D the outline (its shape fixed) is tried at a scale: a bottom-left fill puts each part, in
 * order, at the lowest free spot inside it (next to the parts already there, or snug against the
 * wall; a part with a port, button or switch against its own wall, its feature within reach and
 * nothing between it and that wall), stacking only where two parts fit behind each other within D.
 * A seeded threshold walk over the order and the per-part choices finds the smallest scale that
 * holds everything (in an upright outline, traded against keeping the heavy parts low).
 * Deterministic: the same parts give the same layouts (the time box only stops a search that would
 * take far longer than planned).
 *
 * The caller (layout.ts) tries depths from the thinnest that holds the thickest part (one flat
 * layer) upwards and turns each result into a real layout (finish: rims, openings, retention).
 */

export type Pt2 = [number, number];
export type ZMode = 0 | 1 | 2; // 0 front, 1 back, 2 middle

export interface OVariant {
  /** Envelope box size (case axes, mm). */
  sx: number;
  sy: number;
  sz: number;
  /** Footprint outline points (front view) relative to the box's min corner. */
  pts: Pt2[];
  /** A side-bound feature: its face's outward direction in plan and the tip (relative to the box min, plan) + offset kept from the wall. */
  side?: { face: string; n: Pt2; tip: Pt2; off: number; connector: boolean; /** a lever / shaft that pokes through the wall this far */ poke: number; /** how far the feature may stay from the wall (mm) */ reach: number };
  /** Front / back bound: the box's top sits at z = -top (front) or its bottom at z = -D + bottom (back). */
  zFix?: { mode: "front"; top: number } | { mode: "back"; bottom: number };
  /** Pinned box-min x / y (a placement's x_mm / y_mm, the screen on the centre line). */
  pinX?: number;
  pinY?: number;
  /** Not lying flat (a board on its edge). */
  onEdge: boolean;
}

export interface OItem {
  id: string;
  variants: OVariant[];
  /** Mass proxy (volume, a cell counts double): heavy parts go low in an upright outline. */
  mass: number;
  /** A pinned depth mode (placement.layer); otherwise the search picks. */
  zPin?: ZMode;
  soft: boolean;
  /** Round 17: a held object's room: no wiring room and no closure-lip inset against the wall (the case may follow its outline). */
  flush?: boolean;
}

export interface OEnv {
  kind: "poly" | "rrect" | "ellipse" | "circle" | "stadium";
  /** The outline (custom, or a preset's at a trial aspect): boundary radius (mm at scale 1) and the wall's slant factor per angle sample. */
  radial: { r: Float64Array; c: Float64Array };
  g: number;
  t: number;
  /** Extra inset everywhere (the closure lip). */
  lip: number;
  /** Inner rim radii (front, back) at cavity depth D. */
  rims: (D: number) => [number, number];
  /** An upright outline (taller than wide): heavy parts low. */
  upright: boolean;
  /** Half height at scale 1 (poly) for the heavy-low weighting. */
  B0: number;
  /** Round 17: depth taken at the front / back by a held object's room that fills the outline (mm, gap included). */
  layer?: { front: number; back: number };
}

export interface OPlaced {
  item: number;
  v: number;
  x: number;
  y: number;
  z0: number;
  z1: number;
}

export interface OResult {
  D: number;
  placed: OPlaced[];
  failed: number[];
  /** Outline scale (poly) or plan area (presets) the layout needs. */
  size: number;
  cost: number;
  iters: number;
}

const NA = 360;

/** Boundary radius and slant per angle of a normalised outline (bounding box [-1, 1]²) at half sizes A0, B0. */
export function radialOf(poly: Pt2[], A0: number, B0: number): { r: Float64Array; c: Float64Array } {
  const P = poly.map(([x, y]) => [x * A0, y * B0] as Pt2);
  const r = new Float64Array(NA);
  const c = new Float64Array(NA);
  for (let k = 0; k < NA; k++) {
    const a = (k / NA) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let best = Infinity;
    let cos = 1;
    for (let i = 0; i < P.length; i++) {
      const p = P[i]!;
      const q = P[(i + 1) % P.length]!;
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      const den = ux * ey - uy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const s = (p[0] * ey - p[1] * ex) / den; // distance along the ray
      const u = (p[0] * uy - p[1] * ux) / den; // position on the edge
      if (s > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && s < best) {
        best = s;
        const l = Math.hypot(ex, ey) || 1;
        cos = Math.abs(ux * ey - uy * ex) / l;
      }
    }
    r[k] = Number.isFinite(best) ? best : 1e-3;
    c[k] = Math.max(0.35, cos);
  }
  return { r, c };
}

function arc(rad: number, delta: number): number {
  return rad <= 0 || delta >= rad ? 0 : rad - Math.sqrt(rad * rad - (rad - Math.max(0, delta)) ** 2);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface State {
  order: number[];
  v: number[];
  z: ZMode[];
}

/** z range of a variant at depth D in a mode, or undefined when it does not fit the depth. */
function zRange(V: OVariant, mode: ZMode, D: number, layer?: { front: number; back: number }): [number, number] | undefined {
  let r: [number, number];
  // round 17: a held object's room that fills the outline (a case that follows it) is a layer of its
  // own against its wall: "front" / "back" then means against that layer
  const lf = layer?.front ?? 0;
  const lb = layer?.back ?? 0;
  if (V.zFix?.mode === "front") r = [-V.zFix.top - V.sz, -V.zFix.top];
  else if (V.zFix?.mode === "back") r = [-D + V.zFix.bottom, -D + V.zFix.bottom + V.sz];
  else if (mode === 0) r = [-lf - V.sz, -lf];
  else if (mode === 1) r = [-D + lb, -D + lb + V.sz];
  else r = [-(D + lf - lb + V.sz) / 2, -(D + lf - lb - V.sz) / 2];
  if (r[0] < -D - 1e-6 || r[1] > 1e-6 + (V.zFix?.mode === "front" ? Math.max(0, -V.zFix.top) : 0)) return undefined;
  return r;
}

/**
 * The best layout at cavity depth D. The outline (its shape fixed, centred on the origin) is tried
 * at a scale: every part goes to the lowest free spot (bottom-left fill: next to the parts already
 * there or snug against the wall), a side-bound part snug against its own wall with its feature
 * reaching it. Simulated annealing over the order and the per-part choices drives the area of the
 * parts left over to zero, then the scale shrinks 3 % and it goes again: the smallest scale that
 * held everything wins. Seeded, `iters` steps, stopped early at `deadline`.
 */
export function searchAtDepth(items: OItem[], env: OEnv, D: number, opts: { iters: number; seed: number; deadline: number; minScale?: number; startScale?: number }): OResult {
  const n = items.length;
  const g = env.g;
  const [riF, riB] = env.rims(D);
  const inset = (z0: number, z1: number) => env.t + env.lip + Math.max(arc(riF, -z1), arc(riB, z0 + D)) + 0.1;
  const R = env.radial;
  const scaleOf = (x: number, y: number, ins: number): number => {
    const rho = Math.hypot(x, y);
    let a = Math.atan2(y, x);
    if (a < 0) a += Math.PI * 2;
    const k0 = Math.floor((a / (Math.PI * 2)) * NA) % NA;
    const k1 = (k0 + 1) % NA;
    // the tighter of the two neighbouring samples (conservative)
    return Math.max((rho + ins / R.c[k0]!) / R.r[k0]!, (rho + ins / R.c[k1]!) / R.r[k1]!);
  };
  type Bx = { x0: number; y0: number; x1: number; y1: number; z0: number; z1: number };
  const overlaps = (a: Bx, b: Bx) => a.x0 < b.x1 + g - 1e-9 && b.x0 < a.x1 + g - 1e-9 && a.y0 < b.y1 + g - 1e-9 && b.y0 < a.y1 + g - 1e-9 && a.z0 < b.z1 + g - 1e-9 && b.z0 < a.z1 + g - 1e-9;
  const BIG = 1e4;
  const corridorOf = (V: OVariant, x: number, y: number, z0: number, z1: number): Bx => {
    const s = V.side!;
    return { x0: s.n[0] > 0.5 ? x : s.n[0] < -0.5 ? -BIG : x, x1: s.n[0] < -0.5 ? x + V.sx : s.n[0] > 0.5 ? BIG : x + V.sx, y0: s.n[1] > 0.5 ? y : s.n[1] < -0.5 ? -BIG : y, y1: s.n[1] < -0.5 ? y + V.sy : s.n[1] > 0.5 ? BIG : y + V.sy, z0, z1 };
  };
  // outline points grown by the wiring room (outwards from the box centre), relative to the box min
  // (a side-bound part touches its own wall: no wiring room on that side, as the layout's step 7 puts it)
  const grown = items.map((it) =>
    it.variants.map((V) =>
      V.pts.map(([px, py]) => {
        const sx = Math.sign(px - V.sx / 2);
        const sy = Math.sign(py - V.sy / 2);
        const n = V.side?.n ?? [0, 0];
        const pk = V.side?.poke ?? 0;
        const gg = it.flush ? 0 : g;
        return [px + (n[0] !== 0 && sx === Math.sign(n[0]) ? -n[0] * pk : sx * gg), py + (n[1] !== 0 && sy === Math.sign(n[1]) ? -n[1] * pk : sy * gg)] as Pt2;
      }),
    ),
  );
  // how far a feature may stay from its wall: a plug reaches about 1 mm in through a spot face on a curve (0.8 on a flat; past that the wall would need a flat), a plunger or lever more
  const reachOf = (V: OVariant) => (V.side!.connector ? (env.kind === "poly" ? 1.0 : 0.8) : V.side!.reach);
  const ext = items.map((it) => it.variants.map((V) => Math.hypot(V.sx, V.sy)));
  const maxR = Math.max(...Array.from(R.r));
  // every part left out counts at least this much (mm²), so a small one is not given up lightly
  const FAIL = 400;

  const snugCache = new Map<string, number | undefined>();
  const decode = (st: State, S: number, early = false): { placed: OPlaced[]; failed: number[]; left: number } => {
    const placed: OPlaced[] = [];
    const failed: number[] = [];
    let left = 0;
    const corridors: Bx[] = [];
    const sideFaces = new Set<string>();
    const boxes: Bx[] = [];
    for (const i of st.order) {
      const it = items[i]!;
      const vi = st.v[i]!;
      const V = it.variants[vi]!;
      const G = grown[i]![vi]!;
      const zr = zRange(V, V.side ? 2 : st.z[i]!, D, env.layer);
      if (!zr || (V.side?.connector && env.kind !== "rrect" && sideFaces.has(V.side.face))) {
        failed.push(i);
        left += V.sx * V.sy + FAIL;
        continue;
      }
      const ins = it.flush ? inset(zr[0], zr[1]) - env.lip - 0.08 : inset(zr[0], zr[1]);
      const inside = (x: number, y: number) => {
        // quick reject: the box centre's distance bound
        if (Math.hypot(x + V.sx / 2, y + V.sy / 2) > S * maxR + ext[i]![vi]!) return false;
        for (const [px, py] of G) if (scaleOf(x + px, y + py, ins) > S + 1e-9) return false;
        return true;
      };
      const free = (x: number, y: number) => {
        const cand: Bx = { x0: x, y0: y, x1: x + V.sx, y1: y + V.sy, z0: zr[0], z1: zr[1] };
        for (const b of boxes) if (overlaps(cand, b)) return false;
        for (const c of corridors) if (overlaps(cand, c)) return false;
        if (V.side) {
          const cor = corridorOf(V, x, y, zr[0], zr[1]);
          for (const b of boxes) if (overlaps(cor, b)) return false;
        }
        return true;
      };
      // the feature reaches its wall: the wall is within reach along n from the tip
      const reaches = (x: number, y: number) => {
        const s = V.side!;
        const tx = x + s.tip[0] + s.n[0] * s.off;
        const ty = y + s.tip[1] + s.n[1] * s.off;
        if (scaleOf(tx, ty, env.t) > S + 1e-9) return true; // past the wall already (the plan grows a little there)
        const r = reachOf(V);
        return scaleOf(tx + s.n[0] * r, ty + s.n[1] * r, env.t) > S - 1e-9;
      };
      // snug: along axis k from a start inside, as far as the outline allows towards dir
      // (cached: the scales tried sit on a grid, so the same slide comes back in other decodes)
      const snug = (x: number, y: number, k: 0 | 1, dir: 1 | -1): number | undefined => {
        const key = `${i},${vi},${ins.toFixed(3)},${k},${dir},${x.toFixed(3)},${y.toFixed(3)},${S}`;
        if (snugCache.has(key)) return snugCache.get(key);
        const at = (v: number) => (k === 0 ? inside(v, y) : inside(x, v));
        const v0 = k === 0 ? x : y;
        let out: number | undefined;
        if (at(v0)) {
          let lo = 0;
          let hi = 2 * S * maxR + 2;
          for (let j = 0; j < 11; j++) {
            const m = (lo + hi) / 2;
            if (at(v0 + dir * m)) lo = m;
            else hi = m;
          }
          out = v0 + dir * lo;
        }
        if (snugCache.size > 300_000) snugCache.clear();
        snugCache.set(key, out);
        return out;
      };
      const xs: number[] = [];
      const ys: number[] = [];
      if (V.pinX !== undefined) xs.push(V.pinX);
      else {
        xs.push(-V.sx / 2);
        for (const b of boxes) xs.push(b.x1 + g, b.x0 - g - V.sx);
      }
      if (V.pinY !== undefined) ys.push(V.pinY);
      else {
        ys.push(-V.sy / 2);
        for (const b of boxes) ys.push(b.y1 + g, b.y0 - g - V.sy);
      }
      const cands: Pt2[] = [];
      const s = V.side;
      if (s) {
        // against its own wall: next to the parts already there, and along the wall every few mm
        const span = S * maxR;
        const along = (lo: number, hi: number) => Array.from({ length: 13 }, (_, j) => lo + ((hi - lo) * j) / 12);
        if (Math.abs(s.n[1]) > 0.5) {
          if (V.pinX === undefined) xs.push(...along(-span, span - V.sx));
          if (V.pinY !== undefined) for (const x of xs) cands.push([x, V.pinY]);
          else for (const x of xs) {
            const y = snug(x, -V.sy / 2, 1, s.n[1] > 0 ? 1 : -1) ?? snug(x, s.n[1] > 0 ? 0 : -V.sy, 1, s.n[1] > 0 ? 1 : -1);
            if (y !== undefined) cands.push([x, y]);
          }
        } else {
          if (V.pinY === undefined) ys.push(...along(-span, span - V.sy));
          if (V.pinX !== undefined) for (const y of ys) cands.push([V.pinX, y]);
          else for (const y of ys) {
            const x = snug(-V.sx / 2, y, 0, s.n[0] > 0 ? 1 : -1) ?? snug(s.n[0] > 0 ? 0 : -V.sx, y, 0, s.n[0] > 0 ? 1 : -1);
            if (x !== undefined) cands.push([x, y]);
          }
        }
      } else {
        // spots touching a part already placed: beside it (any height it spans) or on top / under it
        cands.push([xs[0]!, ys[0]!]);
        for (const b of boxes) {
          for (const x of [b.x1 + g, b.x0 - g - V.sx]) if (V.pinX === undefined || Math.abs(x - V.pinX) < 1e-9) for (const y of ys) if (y >= b.y0 - V.sy - g - 1e-9 && y <= b.y1 + g + 1e-9) cands.push([x, y]);
          for (const y of [b.y1 + g, b.y0 - g - V.sy]) if (V.pinY === undefined || Math.abs(y - V.pinY) < 1e-9) for (const x of xs) if (x >= b.x0 - V.sx - g - 1e-9 && x <= b.x1 + g + 1e-9) cands.push([x, y]);
        }
        if (V.pinX !== undefined) for (const y of ys) cands.push([V.pinX, y]);
        if (V.pinY !== undefined) for (const x of xs) cands.push([x, V.pinY]);
        // dropped to the bottom (and pushed to either side) of the outline
        if (V.pinY === undefined) for (const x of xs) {
          const y = snug(x, ys[0]!, 1, -1);
          if (y !== undefined) cands.push([x, y]);
        }
        if (V.pinX === undefined) for (const y of ys) {
          for (const d of [-1, 1] as const) {
            const x = snug(xs[0]!, y, 0, d);
            if (x !== undefined) cands.push([x, y]);
          }
        }
      }
      // bottom first, then near the centre line: the first free spot in that order wins
      const scored = cands.map(([x, y]) => [y + V.sy / 2 + 0.35 * Math.abs(x + V.sx / 2), x, y] as [number, number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      let best: { x: number; y: number } | undefined;
      for (const [, x, y] of scored) {
        if (!free(x, y) || !inside(x, y) || (s && !reaches(x, y))) continue;
        best = { x, y };
        break;
      }
      if (!best) {
        failed.push(i);
        left += V.sx * V.sy + FAIL;
        if (early) break;
        continue;
      }
      const b: Bx = { x0: best.x, y0: best.y, x1: best.x + V.sx, y1: best.y + V.sy, z0: zr[0], z1: zr[1] };
      boxes.push(b);
      if (s) {
        corridors.push(corridorOf(V, best.x, best.y, zr[0], zr[1]));
        sideFaces.add(s.face);
      }
      placed.push({ item: i, v: vi, x: best.x, y: best.y, z0: zr[0], z1: zr[1] });
    }
    return { placed, failed, left };
  };

  // ---- initial state: pinned first, then the front screen, side-bound parts, then big / heavy parts first
  const area = (it: OItem) => it.variants[0]!.sx * it.variants[0]!.sy;
  const rank = (i: number) => {
    const it = items[i]!;
    // a part pinned in place first (the screen kept on the centre line is not pinned in height)
    if (it.variants.some((V) => V.pinY !== undefined && V.pinX !== undefined)) return 0;
    if (it.variants.some((V) => V.pinY !== undefined || (V.pinX !== undefined && V.zFix?.mode !== "front"))) return 0.5;
    // in an upright outline the heaviest parts drop to the bottom first
    if (env.upright && !it.variants[0]!.zFix && !it.variants[0]!.side && it.mass >= 0.5 * Math.max(...items.map((x) => x.mass))) return 0.75;
    // parts that need a wall go before the ones that fill in
    if (it.variants[0]!.side) return 1;
    if (it.variants[0]!.zFix?.mode === "front") return 2;
    return 3;
  };
  const cur0: State = {
    order: [...Array(n).keys()].sort((a, b) => rank(a) - rank(b) || items[b]!.mass - items[a]!.mass || area(items[b]!) - area(items[a]!) || items[a]!.id.localeCompare(items[b]!.id)),
    v: items.map((it) => Math.max(0, it.variants.findIndex((V) => V.sz <= D + 1e-6))),
    z: items.map((it) => it.zPin ?? (it.soft ? 1 : 2)),
  };
  // where two parts can stack within D, start with two layers of about equal area: the parts against
  // the front (the screen's layer) and the ones against the back (cells, the speaker)
  {
    const thin = Math.min(...items.map((it) => Math.min(...it.variants.map((V) => V.sz))));
    let front = 0;
    let back = 0;
    for (const it of items) {
      const V = it.variants[0]!;
      if (V.zFix?.mode === "front") front += V.sx * V.sy;
      else if (V.zFix?.mode === "back") back += V.sx * V.sy;
    }
    const free = [...Array(n).keys()].filter((i) => items[i]!.zPin === undefined && !items[i]!.variants[0]!.zFix && !items[i]!.variants[0]!.side).sort((a, b) => area(items[b]!) - area(items[a]!) || a - b);
    for (const i of free) {
      const V = items[i]!.variants[cur0.v[i]!]!;
      if (V.sz + g + thin > D + 1e-6) continue; // nothing stacks with it: the middle (clear of both rims)
      const toBack = items[i]!.soft || back < front;
      cur0.z[i] = toBack ? 1 : 0;
      if (toBack) back += V.sx * V.sy;
      else front += V.sx * V.sy;
    }
  }
  // the smallest scale at which a state's decode holds everything (bisection near a guess)
  const minS = opts.minScale ?? 0;
  let evals = 0;
  // scales on a grid (0.3 % steps; index 0 = scale 1, a fixed size)
  const Q = Math.log(1.003);
  const sAt = (k: number) => Math.exp(k * Q);
  const kOf = (v: number) => Math.round(Math.log(v) / Q);
  const kMin = minS > 0 ? kOf(minS) : -Infinity;
  // the heavy parts' height (mass-weighted, in half heights of the outline): lower is steadier in an upright outline
  const massSum = items.reduce((a, it) => a + it.mass, 0) || 1;
  const heavyOf = (placed: OPlaced[]) => {
    if (!env.upright) return 0;
    let h = 0;
    for (const q of placed) h += items[q.item]!.mass * (q.y + items[q.item]!.variants[q.v]!.sy / 2);
    return h / massSum / Math.max(1, env.B0);
  };
  let lastOk: OPlaced[] = [];
  const fits = (st: State, k: number) => {
    evals++;
    const r = decode(st, sAt(k), true);
    if (r.failed.length) return false;
    lastOk = r.placed;
    return true;
  };
  const scaleFor = (st: State, guess: number): number => {
    let hi = Math.max(kMin, kOf(guess));
    let ok = fits(st, hi);
    let step = 0;
    while (!ok && step < 25) {
      hi += 26; // about 8 % bigger
      ok = fits(st, hi);
      step++;
    }
    if (!ok) return Infinity;
    let lo = Math.max(kMin, hi - (step ? 26 : 35));
    if (lo < hi && lo === kMin && fits(st, lo)) return sAt(lo);
    // lo does not fit (or is unknown), hi fits
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2);
      if (fits(st, m)) hi = m;
      else lo = m;
    }
    return sAt(hi);
  };
  const rand = rng(opts.seed ^ Math.round(D * 1000));
  // a part on a side wall stays in the middle of the depth (its opening needs the straight band of the wall)
  const zFree = items.map((it, i) => (it.zPin === undefined && it.variants.some((V) => !V.zFix && !V.side) ? i : -1)).filter((i) => i >= 0);
  const multiV = items.map((it, i) => (it.variants.length > 1 ? i : -1)).filter((i) => i >= 0);
  // (when every part is pinned or heavy, the whole order is frozen: findIndex's -1 would walk past the end)
  const firstFree = cur0.order.findIndex((i) => rank(i) >= 1);
  const frozen = env.upright ? (firstFree < 0 ? n : firstFree) : 0;
  let curS = cur0;
  let curV = scaleFor(curS, Math.max(minS, opts.startScale ?? 0.5));
  // what the walk keeps: the smallest scale, traded against the heavy parts' height in an upright
  // outline (the whole mass half the outline's height lower is worth about 12 % of scale)
  const HW = env.upright ? 40 : 0;
  const costOf = (S: number, h: number) => (Number.isFinite(S) ? Math.log(S) / Q + HW * h : Infinity);
  let best = { st: curS, S: curV, h: Number.isFinite(curV) ? heavyOf(decode(curS, curV).placed) : 0 };
  let iters = 0;
  if (Number.isFinite(curV) && curV <= minS + 1e-9) iters = opts.iters; // a fixed size already holds everything as asked
  for (; iters < opts.iters; iters++) {
    if ((iters & 7) === 0 && performance.now() > opts.deadline) break;
    const nx: State = { order: [...curS.order], v: [...curS.v], z: [...curS.z] };
    const m = rand();
    // (in an upright outline the pinned and the heavy parts keep the head of the order, so they settle low)
    const nf = n - frozen;
    if (m < 0.45 && nf > 1) {
      const a = frozen + Math.floor(rand() * nf);
      let b = frozen + Math.floor(rand() * (nf - 1));
      if (b >= a) b++;
      [nx.order[a], nx.order[b]] = [nx.order[b]!, nx.order[a]!];
    } else if (m < 0.65 && nf > 1) {
      const a = frozen + Math.floor(rand() * nf);
      const [x] = nx.order.splice(a, 1);
      nx.order.splice(frozen + Math.floor(rand() * nf), 0, x!);
    } else if (m < 0.85 && multiV.length) {
      const i = multiV[Math.floor(rand() * multiV.length)]!;
      const k = items[i]!.variants.length;
      nx.v[i] = (nx.v[i]! + 1 + Math.floor(rand() * (k - 1))) % k;
    } else if (zFree.length) {
      const i = zFree[Math.floor(rand() * zFree.length)]!;
      nx.z[i] = ((nx.z[i]! + 1 + Math.floor(rand() * 2)) % 3) as ZMode;
    } else continue;
    // threshold walk on the scale grid: a step smaller is a win (then as far down as it goes), the
    // same scale is a sideways move, and now and then a slightly larger one to leave a dead end
    if (!Number.isFinite(curV)) {
      // (nothing has fitted yet: guess from the start scale, not from the infinite best)
      const v = scaleFor(nx, Number.isFinite(best.S) ? best.S : Math.max(minS, opts.startScale ?? 0.5));
      if (Number.isFinite(v)) {
        curS = nx;
        curV = v;
        const h = heavyOf(decode(nx, v).placed);
        if (costOf(v, h) < costOf(best.S, best.h)) best = { st: nx, S: v, h };
      }
      continue;
    }
    const k = kOf(curV);
    if (k > kMin && fits(nx, k - 1)) {
      let k2 = k - 1;
      while (k2 > kMin && fits(nx, k2 - 1)) k2--;
      curS = nx;
      fits(nx, k2);
      curV = sAt(k2);
      const h = heavyOf(lastOk);
      if (costOf(curV, h) < costOf(best.S, best.h) - 1e-9) best = { st: nx, S: curV, h };
      if (k2 <= kMin && !env.upright) break;
    } else if (fits(nx, k)) {
      curS = nx;
      const h = heavyOf(lastOk);
      if (costOf(curV, h) < costOf(best.S, best.h) - 1e-9) best = { st: nx, S: curV, h };
    } else if (rand() < 0.08 * (1 - iters / Math.max(1, opts.iters)) && fits(nx, k + 4)) {
      curS = nx;
      curV = sAt(k + 4);
    }
  }
  const S = Number.isFinite(best.S) ? best.S : 1;
  const curR = decode(best.st, S);
  return { D, placed: curR.placed, failed: curR.failed, size: S, cost: curR.left, iters };
}

/**
 * Cavity depths worth trying, thinnest first: the thickest part alone (one flat layer), then the
 * depths where two (and three) of the parts stack, up to `max`.
 */
export function depthCandidates(items0: OItem[], g: number, max: number, count = 5): number[] {
  // round 17: a held object's room (a socket the case rides on) takes a layer of its own: the other
  // parts stack in front of / behind it, so its depth is added to every candidate
  const flush = items0.filter((it) => it.flush);
  const items = flush.length && flush.length < items0.length ? items0.filter((it) => !it.flush) : items0;
  if (items !== items0) {
    const base = flush.reduce((a, it) => a + Math.min(...it.variants.map((V) => V.sz + (V.zFix?.mode === "front" ? Math.max(0, V.zFix.top) : V.zFix?.mode === "back" ? Math.max(0, V.zFix.bottom) : 0))) + g, 0);
    return depthCandidates(items, g, max - base, count).map((d) => Math.ceil((d + base) * 10 + 1e-6) / 10);
  }
  // each part's thinnest way to sit (a front / back bound one as it must)
  const zs = items.map((it) => Math.min(...it.variants.map((V) => V.sz + (V.zFix?.mode === "front" ? Math.max(0, V.zFix.top) : V.zFix?.mode === "back" ? Math.max(0, V.zFix.bottom) : 0))));
  const dMin = Math.max(4, ...zs);
  const sums = new Set<number>([Math.round(dMin * 10) / 10]);
  const big = [...zs].sort((a, b) => b - a);
  for (let i = 0; i < big.length; i++)
    for (let j = i + 1; j < big.length; j++) {
      const s = big[i]! + g + big[j]!;
      if (s > dMin + 0.4 && s <= max) sums.add(Math.round(s * 10) / 10);
      for (let k = j + 1; k < Math.min(big.length, j + 4); k++) {
        const s3 = big[i]! + big[j]! + big[k]! + 2 * g;
        if (s3 > dMin + 0.4 && s3 <= max) sums.add(Math.round(s3 * 10) / 10);
      }
    }
  const all = [...sums].sort((a, b) => a - b);
  // spread: the thinnest, then steps of at least 1.5 mm
  const out: number[] = [];
  for (const d of all) {
    if (out.length && d - out[out.length - 1]! < 1.5) continue;
    out.push(d);
    if (out.length >= count) break;
  }
  return out;
}
