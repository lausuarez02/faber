/**
 * Round 8b: what each case choice costs.
 *
 * An agent (or a person) makes choices that the parts do not need: a big dome, a part pinned to a
 * spot on a face, a speaker on the front next to the screen, a fixed outline size, a thick wall.
 * Each one can make the case bigger, and nothing said by how much. For every such choice the fast
 * proposal search (no CAD) runs again with that one choice relaxed (back to Jumper's default), and
 * the size, thickness and volume with and without it are compared. A last run relaxes them all.
 *
 * Time-boxed: the choices most likely to cost (the dome, a fixed size, pins) go first, the rest are
 * listed as skipped when the budget runs out. Every number comes from the same quick search, so
 * "with" and "without" are measured the same way (the built case can differ by a few tenths).
 */
import type { CasePlacement, Enclosure } from "@jumper/project-format";
import { resolveMech } from "./mech.ts";
import { autoLayouts, DOME_WARN_MM, type Layout, type LayoutInput, specWithProps } from "./layout.ts";
import { goalOf, layersOf, type LayoutGoal, pocketOf, proposeWithLayouts, volumeOf } from "./proposals.ts";

export interface CostSize {
  w: number;
  h: number;
  d: number;
  volume_cm3: number;
  layers: number;
  /** Every part fits (no error, a fixed size held). */
  fits: boolean;
}

export type ChoiceKind = "dome" | "dome-back" | "edge" | "size" | "depth" | "wall" | "gap" | "closure" | "pin" | "layer" | "face" | "on-edge";

export interface ChoiceCost {
  /** Stable id ("dome", "size", "pin:eyes", "face:spk"). */
  id: string;
  kind: ChoiceKind;
  part?: string;
  /** The choice in a few words ("a 6 mm dome on both faces"). */
  choice: string;
  with: CostSize;
  without: CostSize;
  /** What the choice adds: thickness, volume, the longest side (mm / cm³; negative = it saves). */
  adds_mm: number;
  adds_cm3: number;
  adds_length_mm: number;
  /** It is what makes a fixed size fail (without it the parts fit). */
  breaks_fit: boolean;
  /** For agents: what it costs and the update_case call that relaxes it. */
  message: string;
  /** For people (no tool names). */
  say: string;
  /** The update_case arguments that relax it (also what the Case view's Apply sends). */
  change: Record<string, unknown>;
  /** The Apply button ("Use a 1.5 mm dome"). */
  label: string;
  /** What is given up by relaxing it, when something is. */
  tradeoff?: string;
}

export interface CostsReport {
  /** The case as asked (quick search, the goal the enclosure asks for). */
  base: CostSize;
  goal: LayoutGoal;
  /** The choices that cost something, the costliest first. */
  costs: ChoiceCost[];
  /** Every choice relaxed at once. */
  relax_all?: { without: CostSize; adds_mm: number; adds_cm3: number; message: string; say: string; change: Record<string, unknown>; label: string; choices: string[] };
  /** A fixed outline size: the sizes the same outline works at (from the search), flat and stacked. */
  sizes_that_work?: { layers: number; size_mm: { w: number; h: number; d: number }; pocket: string; label: string; change: Record<string, unknown> }[];
  /** Choices looked at that cost nothing worth saying (ids). */
  free: string[];
  /** Choices not tried in the time budget (ids). */
  skipped: string[];
  ms: number;
}

export interface CostOptions {
  /** Whole budget for the extra searches (ms, default 10000). */
  budgetMs?: number;
  /** How many costly choices to return (default 6). */
  top?: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const DOME_EASY = 1.5;

interface Relax {
  id: string;
  kind: ChoiceKind;
  part?: string;
  choice: string;
  /** Agent-facing call value. */
  change: Record<string, unknown>;
  label: string;
  /** People-facing text for "without" ("with a 1.5 mm dome"). */
  without: string;
  tradeoff?: string;
  /** The enclosure with it relaxed. */
  apply(e: Enclosure): Enclosure;
  /** Run order (lower first). */
  prio: number;
}

/** A deep-ish merge of update_case arguments (params, size_mm, placements per part). */
export function mergeChanges(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (k === "placements" && cur && typeof cur === "object" && v && typeof v === "object") {
      const pl: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
      for (const [id, one] of Object.entries(v as Record<string, unknown>)) pl[id] = { ...((pl[id] as object) ?? {}), ...(one as object) };
      out[k] = pl;
    } else if (cur && typeof cur === "object" && v && typeof v === "object") out[k] = { ...(cur as object), ...(v as object) };
    else out[k] = v;
  }
  return out;
}

function withParams(e: Enclosure, patch: Record<string, unknown>): Enclosure {
  const p: Record<string, unknown> = { ...(e.params ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete p[k];
    else p[k] = v;
  }
  return { ...e, params: p as Enclosure["params"] };
}

function withPlacement(e: Enclosure, id: string, patch: Record<string, unknown>): Enclosure {
  const all: Record<string, CasePlacement> = { ...(e.placements ?? {}) };
  const one: Record<string, unknown> = { ...(all[id] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete one[k];
    else one[k] = v;
  }
  if (Object.keys(one).length) all[id] = one as CasePlacement;
  else delete all[id];
  return { ...e, placements: all };
}

function withSize(e: Enclosure, keys: ("w" | "h" | "d")[]): Enclosure {
  const sz: Record<string, unknown> = { ...(e.size_mm ?? {}) };
  for (const k of keys) delete sz[k];
  const out: Enclosure = { ...e };
  if (Object.keys(sz).length) out.size_mm = sz as Enclosure["size_mm"];
  else delete out.size_mm;
  return out;
}

const fmtMm = (v: number) => `${r1(v)}`;

/** The choices in an enclosure that the parts do not need, each with how to relax it. */
export function choicesOf(input: LayoutInput): Relax[] {
  const e = input.enclosure;
  const p = e.params ?? {};
  const out: Relax[] = [];
  const domeF = typeof p.dome_mm === "number" ? p.dome_mm : undefined;
  const domeB = typeof p.dome_back_mm === "number" ? p.dome_back_mm : undefined;
  if (domeF !== undefined && domeF > DOME_EASY) {
    const both = domeB === undefined;
    out.push({ id: "dome", kind: "dome", choice: `a ${fmtMm(domeF)} mm dome${both ? " on both faces" : " on the front"}`, change: { params: { dome_mm: DOME_EASY } }, label: `Use a ${DOME_EASY} mm dome`, without: `with a ${DOME_EASY} mm dome`, tradeoff: "the faces bulge less, still rounded", apply: (x) => withParams(x, { dome_mm: DOME_EASY }), prio: 0 });
  }
  if (domeB !== undefined && domeB > DOME_EASY) out.push({ id: "dome-back", kind: "dome-back", choice: `a ${fmtMm(domeB)} mm dome on the back`, change: { params: { dome_back_mm: DOME_EASY } }, label: `Use a ${DOME_EASY} mm dome on the back`, without: `with a ${DOME_EASY} mm back dome`, tradeoff: "the back bulges less", apply: (x) => withParams(x, { dome_back_mm: DOME_EASY }), prio: 0 });
  const sz = e.size_mm ?? {};
  if (sz.w !== undefined || sz.h !== undefined) {
    const keys = (["w", "h"] as const).filter((k) => sz[k] !== undefined);
    out.push({ id: "size", kind: "size", choice: `the fixed ${sz.w ?? "auto"} x ${sz.h ?? "auto"} mm size`, change: { size_mm: Object.fromEntries(keys.map((k) => [k, null])) }, label: "Let Jumper size it", without: "at the size Jumper picks", tradeoff: "the outline's size is no longer the one asked", apply: (x) => withSize(x, [...keys]), prio: 1 });
  }
  const depth = sz.d ?? (typeof p.depth_mm === "number" ? p.depth_mm : undefined);
  if (depth !== undefined) out.push({ id: "depth", kind: "depth", choice: `the fixed ${fmtMm(depth)} mm thickness`, change: sz.d !== undefined ? { size_mm: { d: null } } : { params: { depth_mm: "auto" } }, label: "Let Jumper pick the thickness", without: "at the thickness Jumper picks", apply: (x) => withParams(withSize(x, ["d"]), { depth_mm: null }), prio: 1 });
  for (const [k, name] of [["edge_radius_front_mm", "front"], ["edge_radius_back_mm", "back"]] as const) {
    const v = p[k];
    if (typeof v === "number") out.push({ id: `edge-${name}`, kind: "edge", choice: `the ${fmtMm(v)} mm ${name} rim round-over`, change: { params: { [k]: "auto" } }, label: `Automatic ${name} rim`, without: `with the automatic ${name} rim`, apply: (x) => withParams(x, { [k]: null }), prio: 3 });
  }
  if (typeof p.wall_mm === "number" && p.wall_mm > 1.6 + 1e-9) out.push({ id: "wall", kind: "wall", choice: `the ${fmtMm(p.wall_mm)} mm wall`, change: { params: { wall_mm: 1.6 } }, label: "Use a 1.6 mm wall", without: "with a 1.6 mm wall", tradeoff: "a thinner wall, still sturdy", apply: (x) => withParams(x, { wall_mm: 1.6 }), prio: 3 });
  if (typeof p.gap_mm === "number" && p.gap_mm > 1.5 + 1e-9) out.push({ id: "gap", kind: "gap", choice: `${fmtMm(p.gap_mm)} mm of wiring room`, change: { params: { gap_mm: 1.5 } }, label: "Use 1.5 mm of wiring room", without: "with 1.5 mm of wiring room", tradeoff: "less room for wires round each part", apply: (x) => withParams(x, { gap_mm: 1.5 }), prio: 3 });
  if (p.closure === "screws") out.push({ id: "closure", kind: "closure", choice: "screws to close it", change: { params: { closure: "snap" } }, label: "Snap it shut", without: "with a snap fit", tradeoff: "a snap fit instead of screws", apply: (x) => withParams(x, { closure: "snap" }), prio: 4 });
  const ids = new Set(input.parts.map((q) => q.id));
  const grille = (id: string) => {
    const q = input.parts.find((x) => x.id === id);
    if (!q) return false;
    try {
      return resolveMech(q.id, specWithProps(q.spec, q.props)).features.some((f) => f.kind === "grille" && f.expose);
    } catch {
      return false;
    }
  };
  const frontId = e.front;
  for (const [id, pl] of Object.entries(e.placements ?? {})) {
    if (!ids.has(id)) continue;
    if (pl.x_mm !== undefined || pl.y_mm !== undefined) {
      const at = [pl.x_mm !== undefined ? `x ${pl.x_mm}` : "", pl.y_mm !== undefined ? `y ${pl.y_mm}` : ""].filter(Boolean).join(", ");
      out.push({ id: `pin:${id}`, kind: "pin", part: id, choice: `${id} pinned at ${at} mm${pl.face ? ` on the ${pl.face}` : ""}`, change: { placements: { [id]: { x_mm: null, y_mm: null } } }, label: `Let Jumper place ${id}`, without: `with ${id} placed by Jumper`, apply: (x) => withPlacement(x, id, { x_mm: null, y_mm: null }), prio: 2 });
    }
    if (pl.layer !== undefined) out.push({ id: `layer:${id}`, kind: "layer", part: id, choice: `${id} kept in layer ${pl.layer}`, change: { placements: { [id]: { layer: null } } }, label: `Let Jumper pick ${id}'s layer`, without: `with ${id}'s layer picked by Jumper`, apply: (x) => withPlacement(x, id, { layer: null }), prio: 2 });
    if (pl.on_edge) out.push({ id: `on-edge:${id}`, kind: "on-edge", part: id, choice: `${id} stood on its edge`, change: { placements: { [id]: { on_edge: null } } }, label: `Lay ${id} flat`, without: `with ${id} lying flat`, apply: (x) => withPlacement(x, id, { on_edge: null }), prio: 3 });
    if (pl.face && pl.face !== "inside" && id !== frontId && !(pl.face === "front" && !frontId && isScreen(input, id))) {
      // a speaker on the front competes with the screen for the front: its grille can go on the back
      if (pl.face === "front" && grille(id))
        out.push({ id: `face:${id}`, kind: "face", part: id, choice: `${id}'s grille on the front`, change: { placements: { [id]: { face: "back", y_mm: null, x_mm: null } } }, label: `Put ${id}'s grille on the back`, without: `with ${id}'s grille on the back`, tradeoff: "the sound comes out of the back, a little quieter facing you; the front stays free for the screen", apply: (x) => withPlacement(x, id, { face: "back", x_mm: null, y_mm: null }), prio: 2 });
      else out.push({ id: `face:${id}`, kind: "face", part: id, choice: `${id} on the ${pl.face}`, change: { placements: { [id]: { face: null } } }, label: `Let Jumper pick ${id}'s side`, without: `with ${id}'s side picked by Jumper`, tradeoff: `${id} may end up on another side`, apply: (x) => withPlacement(x, id, { face: null }), prio: 3 });
    }
  }
  return out.sort((a, b) => a.prio - b.prio);
}

function isScreen(input: LayoutInput, id: string): boolean {
  const q = input.parts.find((x) => x.id === id);
  return !!q && (q.spec.category === "display" || !!q.spec.mechanical?.features?.some((f) => (f as { kind?: string }).kind === "screen"));
}

function measure(input: LayoutInput, enc: Enclosure, goal: LayoutGoal, timeMs: number): CostSize & { pocket: string } {
  const all = proposeWithLayouts({ ...input, enclosure: enc }, { quick: true, light: true, goals: [goal], time_ms: timeMs });
  const L = all.layouts[goal];
  const pr = all.proposals[0]!;
  const fits = !L.issues.some((i) => i.severity === "error") && L.fit?.fits !== false;
  return { w: L.outer.w, h: L.outer.h, d: L.outer.d, volume_cm3: r1(volumeOf(L)), layers: layersOf(L).layers.length, fits, pocket: pr.pocket };
}

const sizeText = (s: CostSize) => `${s.w} x ${s.h} x ${s.d} mm`;

function effects(w: CostSize, wo: CostSize, without: string): string {
  const dd = r1(w.d - wo.d);
  const dl = r1(Math.max(w.w, w.h) - Math.max(wo.w, wo.h));
  const dv = r1(w.volume_cm3 - wo.volume_cm3);
  const bits: string[] = [];
  if (dd >= 0.5) bits.push(`adds ${dd} mm of thickness`);
  else if (dd <= -0.5) bits.push(`saves ${-dd} mm of thickness`);
  if (dl >= 1) bits.push(`${!bits.length ? "adds " : dd >= 0.5 ? "and " : "but adds "}${dl} mm of length`);
  else if (dl <= -1) bits.push(`${bits.length ? "but " : ""}keeps it ${-dl} mm shorter`);
  if (!bits.length) bits.push(dv >= 0 ? `adds ${dv} cm³` : `saves ${-dv} cm³`);
  const sizes = Math.abs(dl) < 1 && w.w === wo.w && w.h === wo.h ? `${w.d} -> ${wo.d} mm thick` : `${sizeText(w)} -> ${sizeText(wo)}`;
  return `${bits.join(" ")} (${sizes} ${without})`;
}

const toolCall = (change: Record<string, unknown>) => `update_case ${JSON.stringify(change)}`;

/**
 * What each choice in the enclosure costs (see the file comment). `budgetMs` bounds the extra
 * searches; choices not reached are in `skipped`.
 */
export function choiceCosts(input: LayoutInput, opts: CostOptions = {}): CostsReport {
  const t0 = performance.now();
  const budget = opts.budgetMs ?? 10000;
  const goal = goalOf(input.enclosure);
  const per = Math.max(600, Math.min(3000, budget / 4));
  const base = measure(input, input.enclosure, goal, per);
  const relax = choicesOf(input);
  const costs: ChoiceCost[] = [];
  const free: string[] = [];
  const skipped: string[] = [];
  const left = () => budget - (performance.now() - t0);
  const fixedWH = input.enclosure.size_mm?.w !== undefined || input.enclosure.size_mm?.h !== undefined;
  // every choice relaxed at once, first (it says how far the case can go), then one at a time (the pins, faces, dome and size all back to Jumper's defaults)
  let relax_all: CostsReport["relax_all"];
  const allR = relax;
  if (allR.length > 1 && left() > per * 0.5) {
    let e = input.enclosure;
    let change: Record<string, unknown> = {};
    for (const r of allR) {
      e = r.apply(e);
      change = mergeChanges(change, r.change);
    }
    const wo = measure(input, e, goal, per);
    const lead = effects(base, wo, "with all of them relaxed");
    const adds_mm = r1(base.d - wo.d);
    const adds_cm3 = r1(base.volume_cm3 - wo.volume_cm3);
    if (wo.fits && (adds_mm >= 0.5 || adds_cm3 >= 3 || !base.fits))
      relax_all = {
        without: wo,
        adds_mm,
        adds_cm3,
        choices: allR.map((r) => r.id),
        message: `Together (${allR.map((r) => r.choice).join("; ")}) they ${lead.replace(/^adds/, "add").replace(/^saves/, "save").replace("keeps it", "keep it")}. Fix: ${toolCall(change)}.`,
        say: `Letting Jumper decide all of these (${allR.map((r) => r.choice).join("; ")}) makes it ${fmtSay(wo)} instead of ${fmtSay(base)}.`,
        change,
        label: "Let Jumper decide all of these",
      };
  } else if (allR.length > 1) skipped.push("relax-all");
  const runs: Relax[] = [...relax];
  for (const r of runs) {
    if (left() < per * 0.5) {
      skipped.push(r.id);
      continue;
    }
    const wo = measure(input, r.apply(input.enclosure), goal, per);
    const breaks = !base.fits && wo.fits;
    const adds_mm = r1(base.d - wo.d);
    const adds_cm3 = r1(base.volume_cm3 - wo.volume_cm3);
    const adds_length_mm = r1(Math.max(base.w, base.h) - Math.max(wo.w, wo.h));
    const worth = breaks || (wo.fits && (adds_mm >= 0.5 || adds_length_mm >= 3 || adds_cm3 >= Math.max(3, 0.05 * base.volume_cm3)));
    if (!worth) {
      free.push(r.id);
      continue;
    }
    const lead = effects(base, wo, r.without);
    const who = r.part && r.choice.startsWith(r.part) ? r.choice : cap(r.choice);
    const what = breaks ? `${who} is what keeps the parts from fitting: ${r.without} they fit (${sizeText(wo)})` : `${who} ${lead}`;
    const say = breaks ? `${who} is what keeps the parts from fitting. ${cap(r.without)} they fit (${fmtSay(wo)}).` : `${who} ${lead.replace(/ -> /g, " → ").replace(/(\d) x (\d)/g, "$1 × $2").replace(/(\d) x (\d)/g, "$1 × $2")}.`;
    costs.push({
      id: r.id,
      kind: r.kind,
      ...(r.part ? { part: r.part } : {}),
      choice: r.choice,
      with: base,
      without: wo,
      adds_mm,
      adds_cm3,
      adds_length_mm,
      breaks_fit: breaks,
      message: `${what}. Fix: ${toolCall(r.change)}${r.tradeoff ? ` (trade-off: ${r.tradeoff})` : ""}.`,
      say: r.tradeoff ? `${say} Trade-off: ${r.tradeoff}.` : say,
      change: r.change,
      label: r.label,
      ...(r.tradeoff ? { tradeoff: r.tradeoff } : {}),
    });
  }
  costs.sort((a, b) => Number(b.breaks_fit) - Number(a.breaks_fit) || b.adds_mm - a.adds_mm || b.adds_cm3 - a.adds_cm3);
  costs.sort((a, b) => Number(b.breaks_fit) - Number(a.breaks_fit) || b.adds_mm - a.adds_mm || b.adds_cm3 - a.adds_cm3);
  // a fixed outline size: the sizes the same outline works at, flat and stacked
  let sizes_that_work: CostsReport["sizes_that_work"];
  if (fixedWH && left() > per * 0.5) {
    const e = withSize(input.enclosure, ["w", "h"]);
    const cands = autoLayouts({ ...input, enclosure: e }, { iters: 160, depths: 4, timeMs: per });
    const best = new Map<number, { L: Layout; v: number }>();
    for (const c of cands) {
      const L = c.layout;
      if (L.issues.some((i) => i.severity === "error")) continue;
      const n = layersOf(L).layers.length;
      const v = volumeOf(L);
      const cur = best.get(n);
      if (!cur || v < cur.v) best.set(n, { L, v });
    }
    sizes_that_work = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([n, { L }]) => {
      const size_mm = { w: L.outer.w, h: L.outer.h, d: L.outer.d };
      return { layers: n, size_mm, pocket: pocketOf(size_mm), label: n === 1 ? "flat (1 layer)" : `stacked (${n} layers)`, change: { size_mm: { w: size_mm.w, h: size_mm.h } } };
    });
  } else if (fixedWH) skipped.push("sizes-that-work");
  return { base, goal, costs: costs.slice(0, opts.top ?? 6), ...(relax_all ? { relax_all } : {}), ...(sizes_that_work?.length ? { sizes_that_work } : {}), free, skipped, ms: Math.round(performance.now() - t0) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtSay = (s: CostSize) => `${s.w} × ${s.h} × ${s.d} mm`;

