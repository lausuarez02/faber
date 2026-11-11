/**
 * Round 8: how the parts are distributed inside the case, proposed automatically.
 *
 * The optimizer (optimize.ts) lays the parts out at several cavity depths, thinnest first (one flat
 * layer, then two, then three); round 7's front-to-back stacker is one more candidate. Each goal
 * picks its best finished layout:
 *
 * - "thinnest": the least thickness, then the least volume;
 * - "smallest": the least volume;
 * - "balanced": pocket-friendly, volume weighed up past 18 mm thick (more past 22) and past a
 *   110 x 70 mm footprint.
 *
 * The case design then uses the chosen proposal (enclosure.layout, default "auto" = the best one,
 * which is "balanced"). Deterministic: the same project gives the same proposals.
 */
import type { Enclosure } from "@jumper/project-format";
import { autoLayouts, type AutoCandidate, type Layout, type LayoutInput, type LayoutOptions, stackLayout } from "./layout.ts";
import { outline, planBounds } from "./plan.ts";

export const LAYOUT_GOALS = ["thinnest", "smallest", "balanced"] as const;
export type LayoutGoal = (typeof LAYOUT_GOALS)[number];

export interface ProposalPlacement {
  /** Centre of the part's body (case frame, mm). */
  x_mm: number;
  y_mm: number;
  z_mm: number;
  rot: 0 | 90 | 180 | 270;
  on_edge: boolean;
  layer: number;
  /** The case face its exposed feature goes through (screen front, USB bottom, ...). */
  face?: string;
}

export interface ProposalLayer {
  index: number;
  /** Depth range of the layer (case frame z, mm; + is towards the front). */
  z_mm: [number, number];
  parts: string[];
}

/** Front and side views of a proposal for drawing it (case frame, mm). */
export interface ProposalViews {
  front: { outline: [number, number][]; cavity: [number, number][]; parts: { id: string; label: string; color: string; layer: number; min: [number, number]; max: [number, number] }[] };
  /** Seen from the right: z across (front on the right), y up. */
  side: { z: [number, number]; y: [number, number]; parts: { id: string; label: string; color: string; layer: number; z: [number, number]; y: [number, number] }[] };
}

export interface LayoutProposal {
  id: LayoutGoal;
  label: string;
  size_mm: { w: number; h: number; d: number };
  volume_cm3: number;
  pocket: "fits" | "tight" | "no";
  /** Parts' own volume / the cavity's volume. */
  fill_ratio: number;
  layers: ProposalLayer[];
  placements: Record<string, ProposalPlacement>;
  /** Plain-language reasons ("the cell behind the screen saves 14 mm of height"). */
  why: string[];
  /** What does not fit a fixed size, by how much. */
  misses: string[];
  warnings: string[];
  /** Where it came from: the optimizer at a cavity depth, or round 7's stacker. */
  source: string;
  views: ProposalViews;
}

export interface LayoutProposals {
  proposals: LayoutProposal[];
  /** The one design_case uses for layout "auto". */
  best: LayoutGoal;
  parts_volume_cm3: number;
  ms: number;
}

export interface ProposeOptions extends LayoutOptions {
  goals?: LayoutGoal[];
  /** Safety stop for the search (ms). */
  time_ms?: number;
}

const LABEL: Record<LayoutGoal, string> = { thinnest: "Thinnest", smallest: "Smallest", balanced: "Balanced (pocket)" };
const PALETTE = ["#4DA3FF", "#FF7A59", "#5CF2A1", "#F2E14A", "#B47CFF", "#FF4D8D", "#3DD6D0", "#FFB23F", "#9BE15D", "#E9EDF2", "#7A8CFF", "#FF9DCB"];

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function polyArea(P: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i]!;
    const q = P[(i + 1) % P.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** Outer volume estimate (cm³): plan area x thickness, less what the rounded rims take. */
export function volumeOf(L: Layout): number {
  const area = polyArea(outline(L.plan, L.params.wall_mm, 160));
  const d = L.outer.d;
  // a quarter round of radius r along the rim takes (1 - π/4) r² per mm of perimeter
  const per = (() => {
    const P = outline(L.plan, L.params.wall_mm, 160);
    let s = 0;
    for (let i = 0; i < P.length; i++) s += Math.hypot(P[(i + 1) % P.length]![0] - P[i]![0], P[(i + 1) % P.length]![1] - P[i]![1]);
    return s;
  })();
  const rims = (1 - Math.PI / 4) * (L.rf * L.rf + L.rfBack * L.rfBack) * per;
  return Math.max(0, area * d - rims) / 1000;
}

function errorsOf(L: Layout): number {
  return L.issues.filter((i) => i.severity === "error").length;
}

function missOf(L: Layout): number {
  const f = L.fit;
  if (!f) return 0;
  return (f.fixed.w || f.fixed.h ? Math.max(0, f.scale - 1) * 1e3 : 0) + (f.depthMiss ? f.depthMiss.needed_mm - f.depthMiss.available_mm : 0);
}

function pocketOf(s: { w: number; h: number; d: number }): "fits" | "tight" | "no" {
  const [a, b, c] = [s.w, s.h, s.d].sort((x, y) => y - x) as [number, number, number];
  if (c <= 18 && a <= 110 && b <= 70) return "fits";
  if (c <= 22 && a <= 130 && b <= 80) return "tight";
  return "no";
}

/** What each goal minimises (errors and a missed fixed size first). */
export function goalCost(goal: LayoutGoal, L: Layout): number {
  const base = errorsOf(L) * 1e15 + missOf(L) * 1e12;
  const v = volumeOf(L);
  const d = L.outer.d;
  const [a, b] = [L.outer.w, L.outer.h].sort((x, y) => y - x) as [number, number];
  if (goal === "thinnest") return base + Math.round(d * 10) * 1e7 + v;
  if (goal === "smallest") return base + v * 1e3 + d;
  // balanced: a pocket takes about 18 mm comfortably (22 tight) and 110 x 70 mm
  const k = 1 + 0.06 * Math.max(0, d - 18) + 0.12 * Math.max(0, d - 22) + 0.03 * Math.max(0, a - 110) + 0.04 * Math.max(0, b - 70);
  return base + v * k * 1e3 + d;
}

/** Layers from the placed parts: a part behind another (overlapping it seen from the front) is one layer further back. */
export function layersOf(L: Layout): { layer: Map<string, number>; layers: ProposalLayer[] } {
  const P = [...L.placed].sort((a, b) => b.max[2] - a.max[2]);
  const layer = new Map<string, number>();
  for (const p of P) {
    let k = 0;
    for (const q of P) {
      if (q === p || !layer.has(q.mech.id)) continue;
      const xy = q.min[0] < p.max[0] - 1e-6 && p.min[0] < q.max[0] - 1e-6 && q.min[1] < p.max[1] - 1e-6 && p.min[1] < q.max[1] - 1e-6;
      if (xy && q.min[2] >= p.max[2] - 1e-6) k = Math.max(k, layer.get(q.mech.id)! + 1);
    }
    layer.set(p.mech.id, k);
  }
  const n = Math.max(0, ...layer.values()) + 1;
  const layers: ProposalLayer[] = [];
  for (let i = 0; i < n; i++) {
    const ps = L.placed.filter((p) => layer.get(p.mech.id) === i);
    if (!ps.length) continue;
    layers.push({ index: i, z_mm: [r1(Math.min(...ps.map((p) => p.min[2]))), r1(Math.max(...ps.map((p) => p.max[2])))], parts: ps.map((p) => p.mech.id) });
  }
  return { layer, layers };
}

function partsVolume(L: Layout): number {
  return L.placed.reduce((a, p) => a + p.mech.w * p.mech.h * p.mech.d, 0) / 1000;
}

function cavityVolume(L: Layout): number {
  return (polyArea(outline(L.plan, 0, 160)) * (L.zFront - L.zBack)) / 1000;
}

function views(L: Layout, layer: Map<string, number>): ProposalViews {
  const t = L.params.wall_mm;
  const thin = (P: [number, number][], n: number) => (P.length <= n ? P : Array.from({ length: n }, (_, i) => P[Math.floor((i * P.length) / n)]!));
  const rr = (P: [number, number][]) => thin(P, 96).map(([x, y]) => [r2(x), r2(y)] as [number, number]);
  const color = new Map(L.placed.map((p, i) => [p.mech.id, PALETTE[i % PALETTE.length]!]));
  const label = (id: string) => id;
  const parts = [...L.placed].sort((a, b) => (layer.get(b.mech.id) ?? 0) - (layer.get(a.mech.id) ?? 0));
  const ob = planBounds(L.plan, t);
  return {
    front: {
      outline: rr(outline(L.plan, t, 160)),
      cavity: rr(outline(L.plan, 0, 160)),
      parts: parts.map((p) => ({ id: p.mech.id, label: label(p.mech.id), color: color.get(p.mech.id)!, layer: layer.get(p.mech.id) ?? 0, min: [r2(p.bodyMin[0]), r2(p.bodyMin[1])], max: [r2(p.bodyMax[0]), r2(p.bodyMax[1])] })),
    },
    side: {
      z: [r2(L.outer.min[2]), r2(L.outer.max[2])],
      y: [r2(ob.minY), r2(ob.maxY)],
      parts: parts.map((p) => ({ id: p.mech.id, label: label(p.mech.id), color: color.get(p.mech.id)!, layer: layer.get(p.mech.id) ?? 0, z: [r2(p.bodyMin[2]), r2(p.bodyMax[2])], y: [r2(p.bodyMin[1]), r2(p.bodyMax[1])] })),
    },
  };
}

interface Cand {
  L: Layout;
  source: string;
}

/** Everything the goals choose from: the optimizer's layouts (one per depth) and round 7's stacker. */
function candidates(input: LayoutInput, opts: ProposeOptions): Cand[] {
  const out: Cand[] = [];
  const auto: AutoCandidate[] = autoLayouts(input, { ...(opts.quick ? { iters: 220, depths: 3 } : {}), ...(opts.time_ms ? { timeMs: opts.time_ms } : {}) });
  for (const c of auto) out.push({ L: c.layout, source: `optimizer, ${c.D.toFixed(1)} mm deep inside${c.container === "outline" ? "" : ` (${c.container})`}` });
  // round 7's stacker does not know a part pinned by its centre or its layer: it only competes without such pins
  const pins = Object.entries(input.enclosure.placements ?? {}).some(([, pl]) => pl.layer !== undefined || ((pl.x_mm !== undefined || pl.y_mm !== undefined) && !pl.face));
  if (!pins || !out.length) out.push({ L: stackLayout(input, { quick: true }), source: "stacked front to back (round 7)" });
  return out;
}

function pick(cands: Cand[], goal: LayoutGoal): Cand {
  let best = cands[0]!;
  let bc = goalCost(goal, best.L);
  for (const c of cands.slice(1)) {
    const v = goalCost(goal, c.L);
    if (v < bc - 1e-9) {
      best = c;
      bc = v;
    }
  }
  return best;
}

function describe(goal: LayoutGoal, c: Cand, all: { goal: LayoutGoal; c: Cand }[], stack: Cand | undefined): LayoutProposal {
  const L = c.L;
  const { layer, layers } = layersOf(L);
  const size = { w: L.outer.w, h: L.outer.h, d: L.outer.d };
  const vol = volumeOf(L);
  const placements: Record<string, ProposalPlacement> = {};
  for (const p of L.placed)
    placements[p.mech.id] = {
      x_mm: r1((p.bodyMin[0] + p.bodyMax[0]) / 2),
      y_mm: r1((p.bodyMin[1] + p.bodyMax[1]) / 2),
      z_mm: r1((p.bodyMin[2] + p.bodyMax[2]) / 2),
      rot: p.rotation,
      on_edge: Math.abs(p.R[2][2]) < 0.5,
      layer: layer.get(p.mech.id) ?? 0,
      ...(p.bound ? { face: p.bound.face } : {}),
    };
  const why: string[] = [];
  const behind = (id: string) => {
    const p = L.placed.find((q) => q.mech.id === id)!;
    return L.placed.filter((q) => q !== p && (layer.get(q.mech.id) ?? 0) < (layer.get(id) ?? 0) && q.min[0] < p.max[0] && p.min[0] < q.max[0] && q.min[1] < p.max[1] && p.min[1] < q.max[1]).map((q) => q.mech.id);
  };
  if (layers.length <= 1) why.push(`One layer: every part lies side by side, so the case is only as thick as its thickest part (${r1(L.inner.d)} mm inside).`);
  else {
    const stacked = layers.slice(1).flatMap((l) => l.parts).map((id) => `${id} behind ${behind(id).join(" and ") || "the front layer"}`);
    why.push(`${layers.length} layers: ${stacked.join(", ")}.`);
  }
  // compared with the other proposals
  const flat = all.map((x) => x.c).filter((x) => x !== c && layersOf(x.L).layers.length < layers.length).sort((a, b) => a.L.outer.d - b.L.outer.d)[0];
  if (flat && layers.length > 1) {
    const dh = r1(Math.max(flat.L.outer.h, flat.L.outer.w) - Math.max(L.outer.h, L.outer.w));
    const dd = r1(L.outer.d - flat.L.outer.d);
    if (dh > 0.5) why.push(`Stacking saves ${dh} mm of length (${Math.max(L.outer.w, L.outer.h)} instead of ${Math.max(flat.L.outer.w, flat.L.outer.h)} mm) for ${dd} mm more thickness.`);
  }
  if (stack && stack !== c && stack.L.outer.d - L.outer.d > 0.5) why.push(`${r1(stack.L.outer.d - L.outer.d)} mm thinner than stacking every part front to back (${stack.L.outer.w} x ${stack.L.outer.h} x ${stack.L.outer.d} mm).`);
  if (goal === "smallest") why.push(`The least volume of the layouts tried: ${r1(vol)} cm³.`);
  if (goal === "thinnest") why.push(`The thinnest of the layouts tried: ${size.d} mm.`);
  if (goal === "balanced") why.push(`Weighs thickness first (a pocket takes about 18 mm comfortably, 22 tight) and a footprint up to 110 x 70 mm.`);
  const heavy = [...L.placed].sort((a, b) => b.mech.w * b.mech.h * b.mech.d * (b.mech.soft ? 2 : 1) - a.mech.w * a.mech.h * a.mech.d * (a.mech.soft ? 2 : 1))[0];
  if (heavy && L.plan.kind === "poly" && L.outer.h > 1.15 * L.outer.w && (heavy.min[1] + heavy.max[1]) / 2 < (L.outer.min[1] + L.outer.max[1]) / 2) why.push(`${heavy.mech.id}, the heaviest part, sits low so it stands steady.`);
  const misses: string[] = [];
  for (const m of L.fit?.outlineMisses ?? []) misses.push(`${m.part} sticks out ${m.short_mm} mm at the ${m.side}`);
  if (L.fit?.depthMiss) misses.push(`the parts need ${L.fit.depthMiss.needed_mm} mm of thickness, ${r1(L.fit.depthMiss.needed_mm - L.fit.depthMiss.available_mm)} mm more than asked`);
  const warnings = L.issues.filter((i) => i.severity !== "info" && !(i.id === "fits" && misses.length)).map((i) => i.message);
  const cav = cavityVolume(L);
  return {
    id: goal,
    label: LABEL[goal],
    size_mm: size,
    volume_cm3: r1(vol),
    pocket: pocketOf(size),
    fill_ratio: Math.round((partsVolume(L) / Math.max(1e-9, cav)) * 100) / 100,
    layers,
    placements,
    why,
    misses,
    warnings,
    source: c.source,
    views: views(L, layer),
  };
}

/**
 * Propose the ways to distribute the parts (the three goals), each a finished layout. Returns them
 * with the layouts themselves (for design_case).
 */
export function proposeWithLayouts(input: LayoutInput, opts: ProposeOptions = {}): LayoutProposals & { layouts: Record<LayoutGoal, Layout> } {
  const t0 = performance.now();
  const cands = candidates(input, opts);
  const goals = opts.goals?.length ? opts.goals : [...LAYOUT_GOALS];
  const chosen = goals.map((goal) => ({ goal, c: pick(cands, goal) }));
  const stack = cands.find((c) => c.source.startsWith("stacked"));
  const proposals = chosen.map(({ goal, c }) => describe(goal, c, chosen, stack));
  const layouts = Object.fromEntries(LAYOUT_GOALS.map((g) => [g, (chosen.find((x) => x.goal === g)?.c ?? pick(cands, g)).L])) as Record<LayoutGoal, Layout>;
  const any = cands[0]!.L;
  return { proposals, best: goals.includes("balanced") ? "balanced" : goals[0]!, parts_volume_cm3: r1(partsVolume(any)), ms: Math.round(performance.now() - t0), layouts };
}

/** proposeLayouts without the layouts (what tools and the web get). */
export function proposeLayouts(input: LayoutInput, opts: ProposeOptions = {}): LayoutProposals {
  const { layouts: _l, ...rest } = proposeWithLayouts(input, opts);
  void _l;
  return rest;
}

/** The goal an enclosure asks for (layout "auto" or unset: the best one, balanced). */
export function goalOf(enc: Enclosure): LayoutGoal {
  const l = (enc as { layout?: string }).layout;
  return l === "thinnest" || l === "smallest" || l === "balanced" ? l : "balanced";
}

// a few recent answers (design_case lays out the same project two or three times in a row)
const memo = new Map<string, { L: Layout; proposals: LayoutProposals }>();
function keyOf(input: LayoutInput, opts: LayoutOptions): string {
  return JSON.stringify({ e: input.enclosure, q: !!opts.quick, p: input.parts.map((p) => [p.id, p.type, p.props ?? null, p.spec.dimensions_mm ?? null, p.spec.mechanical ?? null]) });
}

/**
 * The case layout design_case builds: the proposal the enclosure asks for (enclosure.layout, default
 * "auto" = balanced). The proposals ride along on the layout (`proposal`).
 */
export function layoutCase(input: LayoutInput, opts: LayoutOptions = {}): Layout {
  const key = keyOf(input, opts);
  const hit = memo.get(key);
  if (hit) return hit.L;
  const goal = goalOf(input.enclosure);
  const all = proposeWithLayouts(input, opts);
  const p = all.proposals.find((x) => x.id === goal)!;
  const L: Layout = { ...all.layouts[goal], proposal: { id: p.id, label: p.label, fill_ratio: p.fill_ratio, layers: p.layers, why: p.why, source: p.source, asked: (input.enclosure as { layout?: string }).layout ?? "auto" } };
  const { layouts: _l, ...proposals } = all;
  void _l;
  memo.set(key, { L, proposals });
  if (memo.size > 8) memo.delete(memo.keys().next().value!);
  return L;
}

/** The proposals of the last layoutCase for this input (computed when not cached). */
export function proposalsFor(input: LayoutInput, opts: LayoutOptions = {}): LayoutProposals {
  const key = keyOf(input, opts);
  if (!memo.has(key)) layoutCase(input, opts);
  return memo.get(key)!.proposals;
}

