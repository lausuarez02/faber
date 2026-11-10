/**
 * Round 7: "rethink the pieces". A cheap fit test (no CAD, well under a second) of a project's
 * parts against a case (any outline, any size): what fits, what does not and by how much, and
 * concrete swaps from the parts library (a smaller part in the same role, a smaller LiPo cell, a
 * board stood on its edge) each tried with the same quick layout, plus "or make it N mm bigger".
 * The same answer drives check_fit / design_case {dry_run: true} for agents and the Case view's
 * live preview for a person.
 */
import type { Enclosure } from "@jumper/project-format";
import type { PartSpec } from "@jumper/sim-core";
import { layoutCase, LIPO_CELLS, type Layout, type LayoutInput, specWithProps } from "./layout.ts";
import { contains, outline, polyOuter } from "./plan.ts";
import type { FitCheck } from "./types.ts";

export interface FitMiss {
  part: string;
  type: string;
  /** "outline": it sticks out of the drawn outline; "depth": the stack is thicker than the case. */
  dimension: "outline" | "depth";
  short_mm: number;
  where?: string;
  message: string;
}

export interface FitSuggestion {
  kind: "swap" | "smaller-cell" | "on-edge" | "finish" | "bigger";
  part?: string;
  from?: string;
  to?: string;
  /** What to tell the person. */
  message: string;
  /** The calls that make the change (tool → arguments). */
  change: { tool: string; args: Record<string, unknown> }[];
  /** Tried with the quick layout: fits at the asked size (undefined = not tried). */
  fits?: boolean;
  /** Size it comes to with the change (mm). */
  size_mm?: { w: number; h: number; d: number };
  /** What else changes (firmware, battery life). */
  tradeoff?: string;
}

export interface FitPreviewPart {
  id: string;
  type: string;
  /** Front-view box (case frame, mm) and depth range. */
  min: [number, number, number];
  max: [number, number, number];
  /** Footprint pieces in the front view (rects as min/max, rounds as centre + r). */
  shapes: ({ shape: "rect"; min: [number, number]; max: [number, number] } | { shape: "round"; c: [number, number]; r: number })[];
  /** Part of it is outside the cavity (red in the preview). */
  collides: boolean;
  facing: string;
}

export interface FitReport {
  fits: boolean;
  shape: Enclosure["shape"];
  /** Outer size as laid out (fixed: the asked size). */
  size_mm: { w: number; h: number; d: number };
  needed_mm: { w: number; h: number; d: number };
  asked_mm?: { w?: number; h?: number; d?: number };
  misses: FitMiss[];
  suggestions: FitSuggestion[];
  /** Front-view geometry for a preview: the outer outline and the cavity (case frame, mm) and the parts. */
  preview: { outline: [number, number][]; cavity: [number, number][]; parts: FitPreviewPart[] };
  /** Layout problems other than fit (exposed features, outline warnings). */
  issues: FitCheck[];
  notes: string[];
  ms: number;
}

export interface FitInput extends LayoutInput {
  /** The parts library, for swap suggestions. */
  catalog?: PartSpec[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Run the quick layout and turn it into a fit report (suggestions when it does not fit). */
export function checkFit(input: FitInput, opts: { suggest?: boolean; budgetMs?: number; layout?: Layout } = {}): FitReport {
  const t0 = performance.now();
  const L = opts.layout ?? layoutCase(input, { quick: true });
  const fit = L.fit;
  const fits = fit ? fit.fits : !L.issues.some((i) => i.id === "fits" && i.severity === "error");
  const typeOf = (id: string) => input.parts.find((p) => p.id === id)?.type ?? "";
  const misses: FitMiss[] = [];
  for (const m of fit?.outlineMisses ?? []) misses.push({ part: m.part, type: typeOf(m.part), dimension: "outline", short_mm: m.short_mm, where: m.side, message: `${m.part} (${typeOf(m.part)}) sticks out ${m.short_mm} mm at the ${m.side} of the outline.` });
  if (fit?.depthMiss) {
    const short = r1(fit.depthMiss.needed_mm - fit.depthMiss.available_mm);
    for (const id of fit.depthMiss.parts) misses.push({ part: id, type: typeOf(id), dimension: "depth", short_mm: short, message: `The stack is ${fit.depthMiss.needed_mm} mm deep for a ${fit.depthMiss.available_mm} mm case: ${short} mm too thick; ${id} (${typeOf(id)}) is one of the thickest.` });
  }
  const suggestions: FitSuggestion[] = [];
  // suggestions are each tried with the quick layout while the time budget lasts (the rest are listed untried)
  if (!fits && opts.suggest !== false) suggestions.push(...suggest(input, L, misses, t0 + (opts.budgetMs ?? 900)));
  return {
    fits,
    shape: L.shape,
    size_mm: { w: L.outer.w, h: L.outer.h, d: L.outer.d },
    needed_mm: fit?.needed_mm ?? { w: L.outer.w, h: L.outer.h, d: L.outer.d },
    ...(fit?.asked_mm ? { asked_mm: fit.asked_mm } : {}),
    misses,
    suggestions,
    preview: preview(L),
    issues: L.issues.filter((i) => i.id !== "fits"),
    notes: L.outlineNotes ?? [],
    ms: Math.round(performance.now() - t0),
  };
}

/** Front-view geometry of a layout: outer outline, cavity and part footprints (red where outside the cavity). */
export function preview(L: Layout): FitReport["preview"] {
  const t = L.params.wall_mm;
  const thin = (P: [number, number][], n: number) => (P.length <= n ? P : Array.from({ length: n }, (_, i) => P[Math.floor((i * P.length) / n)]!));
  const rr = (P: [number, number][]) => P.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as [number, number]);
  const outer = L.plan.kind === "poly" && !L.plan.flats.length ? polyOuter(L.plan, t - (L.plan.w0 ?? 0)) : outline(L.plan, t, 160);
  const cavity = outline(L.plan, 0, 160);
  const parts: FitPreviewPart[] = L.placed.map((p) => {
    const shapes: FitPreviewPart["shapes"] = [];
    const flat = Math.abs(p.R[2][2]) > 0.5;
    if (flat)
      for (const fp of p.mech.footprint) {
        const c = [p.R[0][0] * fp.cx + p.R[0][1] * fp.cy + p.T[0], p.R[1][0] * fp.cx + p.R[1][1] * fp.cy + p.T[1]] as [number, number];
        if (fp.shape === "round") shapes.push({ shape: "round", c, r: fp.r });
        else {
          const hx = Math.abs(p.R[0][0] * fp.hw) + Math.abs(p.R[0][1] * fp.hh);
          const hy = Math.abs(p.R[1][0] * fp.hw) + Math.abs(p.R[1][1] * fp.hh);
          shapes.push({ shape: "rect", min: [c[0] - hx, c[1] - hy], max: [c[0] + hx, c[1] + hy] });
        }
      }
    else shapes.push({ shape: "rect", min: [p.bodyMin[0], p.bodyMin[1]], max: [p.bodyMax[0], p.bodyMax[1]] });
    let collides = false;
    for (const s of shapes) {
      const pts: [number, number][] = s.shape === "rect" ? [s.min, [s.max[0], s.min[1]], s.max, [s.min[0], s.max[1]]] : Array.from({ length: 16 }, (_, i) => [s.c[0] + Math.cos((i / 16) * Math.PI * 2) * s.r, s.c[1] + Math.sin((i / 16) * Math.PI * 2) * s.r] as [number, number]);
      if (pts.some(([x, y]) => !contains(L.plan, x, y, 0))) collides = true;
    }
    if (L.fit?.outlineMisses.some((m) => m.part === p.mech.id)) collides = true;
    return { id: p.mech.id, type: p.mech.type, min: p.bodyMin.map(r1) as [number, number, number], max: p.bodyMax.map(r1) as [number, number, number], shapes, collides, facing: p.facing };
  });
  return { outline: rr(thin(outer, 160)), cavity: rr(thin(cavity, 160)), parts };
}

// ------------------------------------------------------------------ suggestions

/** What a part does in the device: swaps stay within a role. */
export function roleOf(spec: PartSpec): string {
  const f = spec.mechanical?.features ?? [];
  const tags = spec.tags ?? [];
  const name = `${spec.id} ${spec.name}`.toLowerCase();
  if (f.some((x) => x.kind === "screen")) return "display";
  if (spec.category === "board") return `board:${(spec as { mcu?: { chip?: string } }).mcu?.chip ?? spec.id}`;
  if (spec.mechanical?.soft || (spec.category === "power" && /battery|cell/.test(name))) return "battery";
  if (/speaker/.test(name)) return "speaker";
  if (f.some((x) => x.kind === "grille")) return "sound";
  return `${spec.category}:${tags[0] ?? spec.id}`;
}

function footArea(s: PartSpec): number {
  const d = s.dimensions_mm ?? { w: 10, h: 10, d: 5 };
  return s.mechanical?.outline === "round" ? (Math.PI * d.w * d.w) / 4 : d.w * d.h;
}

function suggest(input: FitInput, L: Layout, misses: FitMiss[], deadline: number): FitSuggestion[] {
  const out: FitSuggestion[] = [];
  const enc = input.enclosure;
  const asked = L.fit?.asked_mm ?? {};
  const outlineShort = misses.some((m) => m.dimension === "outline");
  const depthShort = misses.some((m) => m.dimension === "depth");
  // parts to rethink: the ones that miss first, then the biggest of the rest
  const inCase = new Set(L.placed.map((p) => p.mech.id));
  const parts = input.parts.filter((p) => inCase.has(p.id));
  const missIds = [...new Set(misses.map((m) => m.part))];
  const bySize = [...parts].sort((a, b) => footArea(specWithProps(b.spec, b.props)) - footArea(specWithProps(a.spec, a.props)));
  const focus = [...missIds.map((id) => parts.find((p) => p.id === id)!).filter(Boolean), ...bySize.filter((p) => !missIds.includes(p.id))].slice(0, 5);
  const tryIt = (parts2: FitInput["parts"], enc2: Enclosure = enc): { fits: boolean; size_mm: { w: number; h: number; d: number } } | undefined => {
    if (performance.now() > deadline) return undefined;
    try {
      const L2 = layoutCase({ parts: parts2, enclosure: enc2 }, { quick: true });
      return { fits: L2.fit ? L2.fit.fits : true, size_mm: L2.fit?.fits ? { w: L2.outer.w, h: L2.outer.h, d: L2.outer.d } : (L2.fit?.needed_mm ?? { w: L2.outer.w, h: L2.outer.h, d: L2.outer.d }) };
    } catch {
      return undefined;
    }
  };
  const cands: FitSuggestion[] = [];
  // the rounded rims take room from the parts near the front and back: a smaller round-over
  if (outlineShort && Math.max(L.rf, L.rfBack) > 3) {
    const f = Math.max(1.5, Math.round(L.rf * 0.45 * 10) / 10);
    const b = Math.max(1.5, Math.round(L.rfBack * 0.45 * 10) / 10);
    cands.push({ kind: "finish", message: `Round the rims less: ${f} mm at the front and ${b} mm at the back instead of ${L.rf.toFixed(1)} and ${L.rfBack.toFixed(1)} mm (the round-over eats into the room near the front and back faces).`, change: [{ tool: "update_case", args: { params: { edge_radius_front_mm: f, edge_radius_back_mm: b } } }], tradeoff: "a flatter rim: less pebble-like from the side" });
  }
  for (const p of focus) {
    const spec = specWithProps(p.spec, p.props);
    const dims = spec.dimensions_mm ?? { w: 10, h: 10, d: 5 };
    const role = roleOf(p.spec);
    // a smaller LiPo cell (the capacity prop picks the cell size)
    if (role === "battery" && (p.spec.tags ?? []).includes("lipo")) {
      const cap = typeof p.props?.capacity === "number" ? p.props.capacity : 500;
      for (const c of [...LIPO_CELLS].filter((x) => x.mAh < cap && (outlineShort ? x.w * x.h < dims.w * dims.h : x.d < dims.d)).reverse().slice(0, 2)) {
        cands.push({ kind: "smaller-cell", part: p.id, from: `${cap} mAh`, to: `${c.mAh} mAh (${c.code}, ${c.w} x ${c.h} x ${c.d} mm)`, message: `Use a ${c.mAh} mAh cell (${c.code}, ${c.w} x ${c.h} x ${c.d} mm) instead of the ${cap} mAh one (${dims.w} x ${dims.h} x ${dims.d} mm).`, change: [{ tool: "set_part_property", args: { id: p.id, prop: "capacity", value: c.mAh } }], tradeoff: `about ${Math.round((c.mAh / cap) * 100)} % of the battery life` });
      }
    }
    // the same role from the library, smaller where it is short
    for (const s of input.catalog ?? []) {
      if (s.id === p.type || roleOf(s) !== role || !s.dimensions_mm) continue;
      const d2 = s.dimensions_mm;
      const smaller = outlineShort ? footArea(s) < footArea(spec) * 0.97 && Math.max(d2.w, d2.h) <= Math.max(dims.w, dims.h) + 0.5 : d2.d < dims.d - 0.2;
      if (!smaller || (depthShort && !outlineShort && footArea(s) > footArea(spec) * 1.3)) continue;
      const fw = role === "display" ? "the display code changes (another controller / resolution): update the sketch" : role.startsWith("board") ? "same chip, so the sketch keeps working; the pin numbers change" : role === "speaker" ? "a smaller speaker is quieter" : "check the wiring";
      cands.push({ kind: "swap", part: p.id, from: p.type, to: s.id, message: `Swap ${p.id} (${p.type}, ${dims.w} x ${dims.h} x ${dims.d} mm) for ${s.name} (${s.id}, ${d2.w} x ${d2.h} x ${d2.d} mm).`, change: [{ tool: "remove", args: { id: p.id } }, { tool: "place_part", args: { type: s.id, id: p.id } }, { tool: "connect", args: { note: `the same signals as before (get_part ${s.id} lists its pins)` } }], tradeoff: fw });
    }
    // stand a flat board / module on its edge (narrower, thicker)
    if (outlineShort && !depthShort && p.id !== L.front && Math.min(dims.w, dims.h) > dims.d * 2.5 && !enc.placements?.[p.id]?.on_edge && !p.spec.mechanical?.soft) {
      cands.push({ kind: "on-edge", part: p.id, message: `Stand ${p.id} (${p.type}) on its edge instead of lying flat: it then takes ${dims.d} mm instead of ${Math.min(dims.w, dims.h)} mm across.`, change: [{ tool: "update_case", args: { placements: { [p.id]: { on_edge: true } } } }], tradeoff: "the case gets thicker where it stands" });
    }
  }
  // try each (quick layout), keep the ones that help most
  for (const c of cands) {
    let parts2 = input.parts;
    let enc2 = enc;
    if (c.kind === "smaller-cell") parts2 = input.parts.map((p) => (p.id === c.part ? { ...p, props: { ...(p.props ?? {}), capacity: (c.change[0]!.args as { value: number }).value } } : p));
    else if (c.kind === "swap") {
      const s = input.catalog!.find((x) => x.id === c.to)!;
      parts2 = input.parts.map((p) => (p.id === c.part ? { id: p.id, type: s.id, spec: s } : p));
    } else if (c.kind === "on-edge") enc2 = { ...enc, placements: { ...(enc.placements ?? {}), [c.part!]: { ...(enc.placements?.[c.part!] ?? {}), on_edge: true } } };
    else if (c.kind === "finish") enc2 = { ...enc, params: { ...(enc.params ?? {}), ...((c.change[0]!.args as { params: object }).params) } };
    const r = tryIt(parts2, enc2);
    if (r) {
      c.fits = r.fits;
      c.size_mm = r.size_mm;
    }
  }
  const need = L.fit?.needed_mm;
  const score = (c: FitSuggestion) => (c.fits ? 0 : 1e6) + (c.size_mm && need ? c.size_mm.w * c.size_mm.h * c.size_mm.d / (need.w * need.h * need.d) : 1e3);
  cands.sort((a, b) => score(a) - score(b));
  const perPart = new Map<string, number>();
  for (const c of cands) {
    const n = perPart.get(c.part ?? c.kind) ?? 0;
    if (n >= 2 || out.length >= 6) continue;
    // keep a suggestion only if it helps (fits, or needs less than now)
    if (c.fits === false && c.size_mm && need && c.size_mm.w * c.size_mm.h * c.size_mm.d >= need.w * need.h * need.d - 1) continue;
    perPart.set(c.part ?? c.kind, n + 1);
    out.push(c);
  }
  // or make it bigger
  if (need) {
    const grow: string[] = [];
    if (asked.w !== undefined && need.w > asked.w + 0.05) grow.push(`${r1(need.w - asked.w)} mm wider`);
    if (asked.h !== undefined && need.h > asked.h + 0.05) grow.push(`${r1(need.h - asked.h)} mm taller`);
    if (asked.d !== undefined && need.d > asked.d + 0.05) grow.push(`${r1(need.d - asked.d)} mm thicker`);
    const size = { ...(asked.w !== undefined ? { w: Math.ceil(need.w * 10) / 10 } : {}), ...(asked.h !== undefined ? { h: Math.ceil(need.h * 10) / 10 } : {}), ...(asked.d !== undefined ? { d: Math.ceil(need.d * 10) / 10 } : {}) };
    if (grow.length) out.push({ kind: "bigger", message: `Or make it ${grow.join(" and ")}: ${need.w} x ${need.h} x ${need.d} mm holds every part as it is.`, change: [{ tool: "update_case", args: { size_mm: size } }], fits: true, size_mm: need });
  }
  return out;
}
