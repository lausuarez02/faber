/**
 * Round 12: the assembly plan. Faber works out HOW the parts go inside, at design time, for any
 * case shape, and checks it (design for assembly):
 *
 * - which shell each part goes into and in what order (a part covered by another goes in first;
 *   a switch whose lever pokes through its hole slides in before what would block it; a plunger
 *   goes into its hole before the part behind it);
 * - when each wire is soldered (as soon as both of its ends are in; a pad that a later part will
 *   cover gets its lead soldered on the bench before; wires between the shells with the case open
 *   like a book, with the slack that needs);
 * - the battery placed late (or early but connected last), insulated, on a foam pad, a power-on
 *   test before closing, then the closure, then a test with the case closed;
 * - checks with what failed, why and the fix: a part that cannot go in after another, a pad that
 *   cannot be soldered, wires that do not fit, a port or the boot button out of reach when closed,
 *   something sharp near the cell, a screw without a tool path, foam tape where a clip would do.
 *
 * Pure (no CAD): the layout carries the mounts (mounts.ts); the engine renders a picture per step.
 */
import type { Project } from "@faber/project-format";
import type { PartSpec } from "@faber/sim-core";
import { buildNets } from "@faber/project-format";
import type { Layout, Placed } from "./layout.ts";
import type { Mount } from "./mounts.ts";
import { isHeldMech } from "./held.ts";
import { outline } from "./plan.ts";
import type { FitCheck, Vec3 } from "./types.ts";

export type AssemblyAction = "place" | "press-fit" | "screw" | "glue" | "solder" | "tape" | "route-wire" | "close" | "flash" | "test";
export type AssemblyCamera = "bench" | "front-shell" | "back-shell" | "open-book" | "exploded" | "closed";

export interface AssemblyWire {
  id: string;
  /** "xiao.GP6" */
  from: string;
  to: string;
  /** Cut length, mm (strip and slack included). */
  length_mm: number;
  gauge: number;
  color: string;
  /** Round 12: where it runs (in one shell, between the shells, in the harness, to the cell). */
  route?: "front" | "back" | "between" | "harness" | "battery" | "outside";
  /** Between the shells: the length the case needs to open like a book (mm), included in length_mm. */
  open_mm?: number;
}

export interface AssemblyStep {
  n: number;
  title: string;
  /** Plain words for a person. */
  say: string;
  shell: "front" | "back" | "both" | "bench" | "closed";
  parts: string[];
  action: AssemblyAction;
  fasteners: { kind: string; size: string; qty: number }[];
  wires: AssemblyWire[];
  tools: string[];
  cautions: string[];
  view: { explode: number; highlight: string[]; camera: AssemblyCamera };
  /** case/ path of the step's picture, when rendered. */
  image?: string;
}

export interface AssemblyCheck extends FitCheck {
  /** The sizes and positions behind it (mm). */
  facts?: Record<string, number | string>;
}

export interface AssemblyPlan {
  title: string;
  steps: AssemblyStep[];
  checks: AssemblyCheck[];
  consumables: { item: string; qty: number | string; why: string }[];
  tools: string[];
  /** Order of the parts in each shell (inserts as cap-<part> / light-pipe-<part>). */
  order: { front: string[]; back: string[] };
  /** Side of the outline the case opens on like a book while the wires between the shells are soldered. */
  hinge: "left" | "right" | "top" | "bottom";
  wires: AssemblyWire[];
  mounts: { part: string; shell: "front" | "back"; how: string[]; insert: string; say: string; missing?: string }[];
  /** sha-free summary of the wiring the plan was made for (part.pin pairs), to spot a stale plan. */
  wires_key: string;
  /** Round 13: whether the firmware reads a memory card (undefined: not known); a board's own slot gets a card step only then. */
  firmware_card?: boolean;
}

export interface AssemblyInput {
  project: Project;
  layout: Layout;
  specOf: (type: string) => PartSpec | undefined;
  /** The cut list (session's wireCuts on this layout); estimated here from the pin positions when absent. */
  wires?: AssemblyWire[];
  title?: string;
  /** Round 13: the firmware's source text: a board's own card slot (XIAO ESP32-S3 Sense) gets a card only when it reads one. */
  firmwareText?: string;
}

/** Round 13: firmware that reads a memory card (SD / SD_MMC / SdFat). */
export function firmwareUsesCard(text: string): boolean {
  return /#\s*include\s*[<"](SD|SD_MMC|SdFat)\.h[>"]|\bSD(_MMC)?\.begin\s*\(/.test(text);
}

/** Round 17: firmware that deep-sleeps (Arduino / ESP-IDF / MicroPython): the board's native USB port is off while it sleeps. */
export function firmwareDeepSleeps(text: string): boolean {
  return /\besp_deep_sleep_start\s*\(|\besp_deep_sleep\s*\(|\bdeepSleep\s*\(|\bmachine\.deepsleep\s*\(|\bdeepsleep\s*\(/.test(text);
}

interface Box {
  min: Vec3;
  max: Vec3;
}

const OD: Record<number, number> = { 22: 1.6, 24: 1.3, 26: 1.1, 28: 0.9, 30: 0.8 };
const od = (g: number) => OD[g] ?? 1.2;
const r1 = (v: number) => Math.round(v * 10) / 10;
const ceil5 = (v: number) => Math.ceil(v / 5) * 5;

function xyOverlap(a: Box, b: Box, g = 0): boolean {
  return a.min[0] < b.max[0] + g - 1e-9 && b.min[0] < a.max[0] + g - 1e-9 && a.min[1] < b.max[1] + g - 1e-9 && b.min[1] < a.max[1] + g - 1e-9;
}
function overlaps(a: Box, b: Box, g = 0): boolean {
  for (let k = 0; k < 3; k++) if (!(a.min[k]! < b.max[k]! + g - 1e-9 && b.min[k]! < a.max[k]! + g - 1e-9)) return false;
  return true;
}
const env = (p: Placed): Box => ({ min: p.min, max: p.max });

/** Pin positions (case frame, mm) on each placed part's top face: "part.pin" → xyz. */
export function pinPositionsOf(placed: Pick<Placed, "mech" | "R" | "T">[], specOf: (t: string) => PartSpec | undefined): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const p of placed) {
    const spec = specOf(p.mech.type);
    if (!spec) continue;
    const { w, h, d } = p.mech;
    const sw = spec.size.w;
    const sh = spec.size.h;
    // the drawing may be turned a quarter (a portrait XIAO): then the drawing's top is the part's -x
    const turned = Math.abs(Math.log(sw / sh / (w / h))) > Math.abs(Math.log((sw / sh) * (w / h))) + 0.05;
    for (const pin of spec.pins) {
      const px = turned ? (pin.y / sh) * w : (pin.x / sw) * w;
      const py = turned ? (1 - pin.x / sw) * h : (pin.y / sh) * h;
      const l: Vec3 = [px - w / 2, h / 2 - py, d];
      out[`${p.mech.id}.${pin.id}`] = [0, 1, 2].map((i) => p.R[i]![0]! * l[0] + p.R[i]![1]! * l[1] + p.R[i]![2]! * l[2] + p.T[i]!) as Vec3;
    }
  }
  return out;
}

/** A cut list estimated from the layout (used when the caller has none): straight pin distance x 1.3, + 10 mm strip, + 15 mm slack. */
function estimateWires(project: Project, L: Layout, specOf: AssemblyInput["specOf"]): AssemblyWire[] {
  const pos = pinPositionsOf(L.placed, specOf);
  const power = new Set<string>();
  const netOf = new Map<string, string>();
  for (const n of buildNets(project))
    for (const r of n.pins) {
      netOf.set(`${r.part}.${r.pin}`, n.id);
      const type = project.parts.find((p) => p.id === r.part)?.type;
      const t = type ? specOf(type)?.pins.find((x) => x.id === r.pin)?.type : undefined;
      if (t === "power" || t === "ground") power.add(n.id);
    }
  return project.wires.map((w) => {
    const a = pos[`${w.from.part}.${w.from.pin}`];
    const b = pos[`${w.to.part}.${w.to.pin}`];
    const straight = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 30;
    const net = netOf.get(`${w.from.part}.${w.from.pin}`);
    return { id: w.id, from: `${w.from.part}.${w.from.pin}`, to: `${w.to.part}.${w.to.pin}`, length_mm: ceil5(straight * 1.3 + 25), gauge: net && power.has(net) ? 24 : 26, color: w.color ?? "any" };
  });
}

export function assemblyPlan(input: AssemblyInput): AssemblyPlan {
  const { project, specOf } = input;
  // round 15: held objects (a tin...) are not assembled: they go in at the end (or, captive, before closing)
  const full = input.layout;
  const heldPlaced = full.placed.filter((p) => isHeldMech(p.mech));
  const L: Layout = heldPlaced.length ? { ...full, placed: full.placed.filter((p) => !isHeldMech(p.mech)), mounts: (full.mounts ?? []).filter((m) => !heldPlaced.some((h) => h.mech.id === m.part)) } : full;
  const title = input.title ?? project.name;
  const checks: AssemblyCheck[] = [];
  const byId = new Map(L.placed.map((p) => [p.mech.id, p]));
  const mounts = new Map<string, Mount>((L.mounts ?? []).map((m) => [m.part, m]));
  const name = (id: string) => {
    const p = byId.get(id);
    const t = project.parts.find((x) => x.id === id)?.type;
    return `${id} (${p?.mech.name ?? (t ? specOf(t)?.name : undefined) ?? t ?? "part"})`;
  };
  const shellOf = (id: string): "front" | "back" => mounts.get(id)?.shell ?? ((byId.get(id)?.min[2] ?? 0) + (byId.get(id)?.max[2] ?? 0) > L.zFront + L.zBack ? "front" : "back");
  const isCell = (id: string) => !!byId.get(id)?.mech.soft;
  const board = project.parts.find((p) => p.id === project.firmware?.board) ?? project.parts.find((p) => specOf(p.type)?.mcu);

  // ---------------------------------------------------------------- 1. the case must close
  for (const a of L.placed)
    for (const b of L.placed) {
      if (a === b || shellOf(a.mech.id) !== "front" || shellOf(b.mech.id) !== "back") continue;
      if (!xyOverlap(env(a), env(b), -0.05) || a.max[2] > b.min[2] + 0.05) continue;
      checks.push({ id: "assembly-close", ok: false, severity: "error", message: `The case cannot close: ${a.mech.id} goes into the front shell but sits behind ${b.mech.id} of the back shell (they overlap ${r1(Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]))} x ${r1(Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]))} mm seen from the front). Why: the front shell comes straight down onto the back one, so ${a.mech.id} would pass through ${b.mech.id}. Fix: put ${a.mech.id} on another face, or let Faber place both (remove their placements).`, parts: [a.mech.id, b.mech.id], facts: { front_part_back_z: r1(a.min[2]), back_part_front_z: r1(b.max[2]) } });
    }

  // ---------------------------------------------------------------- 2. insertion order per shell
  const order: { front: string[]; back: string[] } = { front: [], back: [] };
  const conflicts: string[] = [];
  for (const shell of ["front", "back"] as const) {
    const parts = L.placed.filter((p) => shellOf(p.mech.id) === shell);
    // deeper = nearer that shell's wall: goes in first when another part covers it
    const depth = (p: Placed) => (shell === "front" ? p.max[2] : -p.min[2]);
    const before = new Map<string, Set<string>>(parts.map((p) => [p.mech.id, new Set<string>()]));
    const why = new Map<string, string>();
    for (const a of parts)
      for (const b of parts) {
        if (a === b || !xyOverlap(env(a), env(b), -0.05)) continue;
        // a nearer the wall than b and under it (seen from the open side): a first
        const aUnder = shell === "front" ? a.min[2] >= b.max[2] - 0.5 || (depth(a) > depth(b) + 0.05 && a.min[2] > b.min[2]) : a.max[2] <= b.min[2] + 0.5 || (depth(a) > depth(b) + 0.05 && a.max[2] < b.max[2]);
        if (aUnder) {
          before.get(b.mech.id)!.add(a.mech.id);
          why.set(`${a.mech.id}>${b.mech.id}`, `${b.mech.id} covers it`);
        }
      }
    // a part that slides sideways at the end (a lever through its hole) goes in before what would block its path
    const shellFeatures: Box[] = [...L.ribs.filter((r) => r.shell === shell).map((r) => ({ min: r.min, max: r.max, part: r.part })), ...L.posts.filter((q) => q.shell === shell).map((q) => ({ min: [q.x - q.d / 2, q.y - q.d / 2, q.z0] as Vec3, max: [q.x + q.d / 2, q.y + q.d / 2, q.z1] as Vec3, part: q.part }))] as (Box & { part?: string })[];
    for (const s of parts) {
      const m = mounts.get(s.mech.id);
      if (m?.insert !== "slide" || !m.slide) continue;
      const d = m.slide.dir;
      const need = m.slide.need_mm;
      const path: Box = { min: [Math.min(s.bodyMin[0], s.bodyMin[0] - d[0] * need), Math.min(s.bodyMin[1], s.bodyMin[1] - d[1] * need), s.bodyMin[2]], max: [Math.max(s.bodyMax[0], s.bodyMax[0] - d[0] * need), Math.max(s.bodyMax[1], s.bodyMax[1] - d[1] * need), s.bodyMax[2]] };
      if (m.slide.have_mm + 1e-6 < need)
        checks.push({ id: "assembly-insert", ok: false, severity: "error", message: `${name(s.mech.id)} cannot go in: its ${m.slide.opening.split(" on ")[0]} pokes ${r1(need - 0.5)} mm through the ${m.slide.opening.split(" on the ")[1]} wall, so it must be held ${need} mm away from that wall and slid into place, and there is only ${m.slide.have_mm} mm of room behind it. Why: the cavity (or a rib of the same shell) is too close behind it. Fix: put the seam through its opening (a part whose hole straddles the two shells just drops in), give it more room (gap_mm), or put it on another face with placements.`, parts: [s.mech.id], facts: { need_mm: need, have_mm: m.slide.have_mm } });
      for (const f of shellFeatures)
        if ((f as { part?: string }).part !== s.mech.id && overlaps(f, path) && !overlaps(f, { min: s.bodyMin, max: s.bodyMax }))
          checks.push({ id: "assembly-insert", ok: false, severity: "error", message: `${name(s.mech.id)} cannot slide into place: a ${shell}-shell rib or post (for ${(f as { part?: string }).part ?? "another part"}) sits in the ${need} mm it has to move. Why: its lever goes through the wall, so it goes in held away from the wall and slides out to it. Fix: give it more room (gap_mm) or put it on another face.`, parts: [s.mech.id], facts: { need_mm: need } });
      for (const b of parts) {
        if (b === s || !overlaps(env(b), path, -0.05)) continue;
        if (before.get(s.mech.id)!.has(b.mech.id)) {
          conflicts.push(`${s.mech.id} must slide in before ${b.mech.id} (which sits in its ${need} mm slide path) but ${b.mech.id} goes in first because it lies under ${s.mech.id}`);
          continue;
        }
        before.get(b.mech.id)!.add(s.mech.id);
        why.set(`${s.mech.id}>${b.mech.id}`, `${b.mech.id} would block its slide`);
      }
    }
    // Kahn's order: deeper first, then the larger, then the id (deterministic)
    const done = new Set<string>();
    const seq: string[] = [];
    const rank = (p: Placed) => [-depth(p), -(p.max[0] - p.min[0]) * (p.max[1] - p.min[1]), p.mech.id] as const;
    const cmp = (a: Placed, b: Placed) => {
      const x = rank(a);
      const y = rank(b);
      return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
    };
    while (seq.length < parts.length) {
      const ready = parts.filter((p) => !done.has(p.mech.id) && [...before.get(p.mech.id)!].every((q) => done.has(q))).sort(cmp);
      let next = ready[0];
      if (!next) {
        // a cycle: two parts each need to go in before the other
        const left = parts.filter((p) => !done.has(p.mech.id)).sort(cmp);
        next = left[0]!;
        const blockers = [...before.get(next.mech.id)!].filter((q) => !done.has(q));
        conflicts.push(`${next.mech.id} and ${blockers.join(", ")} each need to go in before the other (${blockers.map((q) => why.get(`${q}>${next!.mech.id}`) ?? "overlap").join("; ")})`);
      }
      done.add(next.mech.id);
      seq.push(next.mech.id);
    }
    order[shell] = seq;
  }
  if (conflicts.length) checks.push({ id: "assembly-insert", ok: false, severity: "error", message: `No order puts every part in: ${conflicts.join("; ")}. Why: each one blocks the other's way in. Fix: put one of them on another face or layer with placements, or let Faber place them (remove their placements).`, parts: [...new Set(conflicts.flatMap((c) => c.split(" ").filter((w) => byId.has(w))))] });

  // a cell nothing goes over: placed last (with the battery step); one under other parts goes in in order, connected last
  const deferred = new Set<string>();
  for (const shell of ["front", "back"] as const)
    for (const id of order[shell]) {
      if (!isCell(id)) continue;
      const i = order[shell].indexOf(id);
      const later = order[shell].slice(i + 1).some((q) => xyOverlap(env(byId.get(q)!), env(byId.get(id)!), -0.05));
      if (!later) deferred.add(id);
    }

  // ---------------------------------------------------------------- 3. wires: routes, slack, solder moments
  let wires = (input.wires ?? estimateWires(project, L, specOf)).map((w) => ({ ...w }));
  const pos = pinPositionsOf(L.placed, specOf);
  const inline = new Set(L.inline);
  const outside = new Set(L.outside.map((o) => o.id));
  const partOf = (end: string) => end.split(".")[0]!;
  for (const w of wires) {
    const a = partOf(w.from);
    const b = partOf(w.to);
    if (outside.has(a) || outside.has(b)) w.route = "outside";
    else if (inline.has(a) || inline.has(b)) w.route = "harness";
    else if (isCell(a) || isCell(b)) w.route = "battery";
    else if (!byId.has(a) || !byId.has(b)) w.route = "harness";
    else w.route = shellOf(a) === shellOf(b) ? shellOf(a) : "between";
  }
  // the hinge: the side nearest the ends of the wires between the shells (the case opens like a book there)
  const cross = wires.filter((w) => w.route === "between" || (w.route === "battery" && shellOf(partOf(w.from)) !== shellOf(partOf(w.to))));
  const ob = { minX: L.outer.min[0], maxX: L.outer.max[0], minY: L.outer.min[1], maxY: L.outer.max[1] };
  const sides = { left: (p: Vec3) => p[0] - ob.minX, right: (p: Vec3) => ob.maxX - p[0], bottom: (p: Vec3) => p[1] - ob.minY, top: (p: Vec3) => ob.maxY - p[1] } as const;
  let hinge: AssemblyPlan["hinge"] = "left";
  {
    let best = Infinity;
    for (const [side, dist] of Object.entries(sides) as [AssemblyPlan["hinge"], (p: Vec3) => number][]) {
      let sum = 0;
      for (const w of cross) for (const e of [w.from, w.to]) sum += pos[e] ? dist(pos[e]!) : 0;
      // (prefer a side without a port opening: the case lies on it while open)
      const ports = L.openings.filter((o) => o.face === side && o.kind === "connector").length;
      const score = sum + ports * 15;
      if (score < best - 1e-6) {
        best = score;
        hinge = side;
      }
    }
  }
  for (const w of cross) {
    const a = pos[w.from];
    const b = pos[w.to];
    if (!a || !b) continue;
    const dist = sides[hinge];
    const open = dist(a) + dist(b) + Math.abs(a[2] - L.split) + Math.abs(b[2] - L.split) + 10 + 15;
    w.open_mm = ceil5(open);
    if (w.length_mm < w.open_mm) w.length_mm = w.open_mm;
  }

  // pads: when is each wire soldered, and is its pad reachable then
  type End = { wire: AssemblyWire; end: string; part: string };
  const placeTime = new Map<string, number>();
  let t = 0;
  for (const shell of ["front", "back"] as const) for (const id of order[shell]) if (!deferred.has(id)) placeTime.set(id, t++);
  const BOOK = t + 1;
  const BATTERY = t + 2;
  for (const id of deferred) placeTime.set(id, BATTERY);
  const solderAt = (w: AssemblyWire): number => {
    if (w.route === "outside") return -1;
    // a wire to a part riding in the wiring (a resistor, a diode): its end on a placed part is soldered when that part is in
    if (w.route === "harness") {
      const placed = [partOf(w.from), partOf(w.to)].filter((p) => placeTime.has(p));
      return placed.length ? Math.max(...placed.map((p) => placeTime.get(p)!)) : -1;
    }
    if (w.route === "battery") return BATTERY;
    if (w.route === "between") return BOOK;
    return Math.max(placeTime.get(partOf(w.from)) ?? 0, placeTime.get(partOf(w.to)) ?? 0);
  };
  const coveredBy = (e: End, until: number): string | undefined => {
    const P = pos[e.end];
    const p = byId.get(e.part);
    if (!P || !p || isCell(e.part)) return undefined; // a cell comes with its leads
    const shell = shellOf(e.part);
    const t0 = placeTime.get(e.part) ?? 0;
    const disc: Box = { min: [P[0] - 2, P[1] - 2, -1e9], max: [P[0] + 2, P[1] + 2, 1e9] };
    for (const id of order[shell]) {
      const tc = placeTime.get(id) ?? 0;
      if (id === e.part || tc <= t0 || tc > until) continue;
      const c = byId.get(id)!;
      if (!xyOverlap(env(c), disc)) continue;
      // on the open side of the pad (the side the iron comes from)
      if (shell === "back" ? c.min[2] >= P[2] - 0.5 : c.max[2] <= P[2] + 0.5) return id;
    }
    return undefined;
  };
  const leads = new Map<string, { end: string; wire: AssemblyWire; under: string }[]>(); // part → ends to pre-solder before it goes in
  const splices: { wire: AssemblyWire; ends: string[] }[] = [];
  const solderSteps = new Map<number, AssemblyWire[]>();
  for (const w of wires) {
    const at = solderAt(w);
    if (at < 0) continue;
    const ends: End[] = [w.from, w.to].map((e) => ({ wire: w, end: e, part: partOf(e) }));
    const covered = ends.map((e) => coveredBy(e, at === BOOK || at === BATTERY ? Infinity : at));
    covered.forEach((c, i) => {
      if (!c) return;
      const e = ends[i]!;
      const list = leads.get(e.part) ?? [];
      list.push({ end: e.end, wire: w, under: c });
      leads.set(e.part, list);
    });
    if (covered.every(Boolean)) splices.push({ wire: w, ends: ends.map((e) => e.end) });
    const list = solderSteps.get(at) ?? [];
    list.push(w);
    solderSteps.set(at, list);
  }
  const leadCount = [...leads.values()].reduce((s, l) => s + l.length, 0);
  checks.push(
    splices.length
      ? { id: "assembly-solder", ok: true, severity: "warning", message: `${splices.length} wire${splices.length > 1 ? "s" : ""} (${splices.map((s) => `${s.wire.id}: ${s.ends.join(" - ")}`).join("; ")}) cannot be soldered in place at either end: both pads end up under other parts. Why: each end is covered before the other end's part is in. Plan: a lead is soldered to each pad on the bench and the two leads are joined with a splice and heat-shrink in the wiring room. Fix (no splice): put one of the parts on another layer or face, or change the order with placements.`, parts: [...new Set(splices.flatMap((s) => s.ends.map(partOf)))], facts: { splices: splices.length, leads: leadCount } }
      : { id: "assembly-solder", ok: true, severity: "info", message: leadCount ? `Every joint can be soldered: ${leadCount} pad${leadCount > 1 ? "s" : ""} that a later part covers get${leadCount > 1 ? "" : "s"} its lead soldered on the bench first (${[...leads.entries()].map(([p, l]) => `${p}: ${l.map((x) => x.end.split(".")[1]).join(", ")} under ${[...new Set(l.map((x) => x.under))].join(", ")}`).join("; ")}); the rest in place.` : `Every joint can be soldered in place, each as soon as both of its parts are in.`, facts: { leads: leadCount } },
  );

  // ---------------------------------------------------------------- 4. do the wires fit
  const gap = L.params.gap_mm;
  const thickest = Math.max(0, ...wires.filter((w) => w.route !== "outside").map((w) => od(w.gauge)));
  const cavPoly = outline(L.plan, 0, 120);
  let area = 0;
  for (let i = 0; i < cavPoly.length; i++) {
    const [x0, y0] = cavPoly[i]!;
    const [x1, y1] = cavPoly[(i + 1) % cavPoly.length]!;
    area += x0 * y1 - x1 * y0;
  }
  area = Math.abs(area) / 2;
  const depth = L.zFront - L.zBack;
  const partsVol = L.placed.reduce((s, p) => s + (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]) * (p.max[2] - p.min[2]), 0);
  const featVol = L.ribs.reduce((s, r) => s + (r.max[0] - r.min[0]) * (r.max[1] - r.min[1]) * (r.max[2] - r.min[2]), 0) + L.posts.reduce((s, q) => s + Math.PI * (q.d / 2) ** 2 * (q.z1 - q.z0), 0);
  // a rounded cavity holds less than its plan x depth: the rim round-overs (about 15 % on a pebble)
  const free = Math.max(1, area * depth * (L.ri > 0 || L.riBack > 0 ? 0.85 : 0.97) - partsVol - featVol);
  const wireVol = wires.filter((w) => w.route !== "outside").reduce((s, w) => s + w.length_mm * Math.PI * (od(w.gauge) / 2) ** 2, 0) * 2; // x 2: bends and the room between wires
  const ratio = wireVol / free;
  const crossN = cross.length;
  const bundle = crossN ? thickest * Math.sqrt(crossN / 0.6) : 0;
  const splitParts = L.placed.filter((p) => p.min[2] < L.split && p.max[2] > L.split);
  const splitFree = Math.max(0, area - splitParts.reduce((s, p) => s + (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]), 0));
  const facts = { wiring_room_mm: gap, thickest_wire_mm: thickest, wires: wires.length, wire_volume_cm3: r1(wireVol / 1000), free_volume_cm3: r1(free / 1000), between_shells: crossN, bundle_mm: r1(bundle), free_at_seam_mm2: Math.round(splitFree) };
  if (wires.length && gap < thickest + 0.2)
    checks.push({ id: "assembly-wires", ok: false, severity: "error", message: `The wires do not fit between the parts: the thickest is ${thickest} mm (${wires.find((w) => od(w.gauge) === thickest)?.gauge} AWG silicone) and the wiring room round each part is ${gap} mm. Why: gap_mm is the room the wires run in. Fix: update_case {"params": {"gap_mm": ${r1(Math.max(1.5, thickest + 0.4))}}}, or thinner wire (28 AWG for signals).`, facts });
  else if (ratio > 0.6)
    checks.push({ id: "assembly-wires", ok: false, severity: "error", message: `The wires will not fit in the case: about ${r1(wireVol / 1000)} cm³ of wire (${wires.length} wires with their slack, bundled) for ${r1(free / 1000)} cm³ of free room. Why: the parts fill the cavity. Fix: update_case {"params": {"gap_mm": ${r1(gap + 1)}}}, shorter wires (fewer between the shells), or thinner wire.`, facts });
  else if (ratio > 0.3)
    checks.push({ id: "assembly-wires", ok: true, severity: "warning", message: `Tight for the wires: about ${r1(wireVol / 1000)} cm³ of wire for ${r1(free / 1000)} cm³ of free room (${Math.round(ratio * 100)} %). Why: the parts fill most of the cavity. Fix: cut the wires to the lengths in WIRE-CUTS.csv (no extra), or update_case {"params": {"gap_mm": ${r1(gap + 0.5)}}}.`, facts });
  else if (crossN && splitFree < 3 * (Math.PI * (bundle / 2) ** 2))
    checks.push({ id: "assembly-wires", ok: true, severity: "warning", message: `The ${crossN} wires between the shells (a bundle about ${r1(bundle)} mm across) have little room at the seam: ${Math.round(splitFree)} mm² free where the shells meet. Why: parts span the seam. Fix: route them along the wall on the ${hinge} side, or more gap_mm.`, facts });
  else checks.push({ id: "assembly-wires", ok: true, severity: "info", message: `The wires fit: ${wires.length} wires (thickest ${thickest} mm) in ${gap} mm of wiring room, about ${r1(wireVol / 1000)} of ${r1(free / 1000)} cm³ free${crossN ? `; ${crossN} run between the shells (a ${r1(bundle)} mm bundle) and are cut long enough to open the case like a book on the ${hinge}` : ""}.`, facts });

  // ---------------------------------------------------------------- 5. ports and the boot button when closed
  const access: string[] = [];
  const cards: { part: string; what: string }[] = [];
  for (const p of L.placed) {
    for (const f of p.mech.features) {
      if (f.kind !== "connector") continue;
      const opened = L.openings.some((o) => o.part === p.mech.id && o.feature === f.id);
      const role = p.mech.id === board?.id ? "flashing and power" : p.mech.category === "power" ? "charging" : "its cable";
      // a card slot inside is fine: the card goes in before closing (a step of the plan)
      if (!opened && /sd/i.test(f.connector ?? "")) {
        // a board's own slot is optional: a card only when the firmware reads one (modules with a slot, DFPlayer, need theirs)
        if (p.mech.category === "board" && input.firmwareText !== undefined && !firmwareUsesCard(input.firmwareText)) continue;
        cards.push({ part: p.mech.id, what: f.connector === "microsd" ? "microSD card" : "SD card" });
        continue;
      }
      if (opened) access.push(`${p.mech.id}.${f.id} (${role}) through its opening on the ${L.openings.find((o) => o.part === p.mech.id && o.feature === f.id)!.face}`);
      else checks.push({ id: "assembly-access", ok: false, severity: "warning", message: `${name(p.mech.id)}'s ${f.connector ?? "connector"} (${role}) is inside the closed case. Why: it has no opening (its part data does not expose it, or it was placed away from the walls). Fix: ${role === "charging" || role === "flashing and power" ? `put ${p.mech.id} against a wall (placements {"${p.mech.id}": {"face": "bottom"}}) so its port gets an opening` : "open the case to plug it in"}.`, parts: [p.mech.id] });
    }
  }
  const boardP = board ? byId.get(board.id) : undefined;
  const hidden = boardP ? boardP.mech.features.filter((f) => f.kind === "button" && !L.openings.some((o) => o.part === boardP.mech.id && o.feature === f.id)) : [];
  const boot = hidden.find((f) => /boot/i.test(f.id));
  const sleeps = input.firmwareText !== undefined && firmwareDeepSleeps(input.firmwareText);
  checks.push({ id: "assembly-access", ok: true, severity: boot ? "warning" : "info", message: `${access.length ? `Reachable with the case closed: ${access.join("; ")}.` : "No port is reachable with the case closed."}${cards.length ? ` ${cards.map((c) => `${c.part}'s ${c.what} stays inside (it goes in before closing)`).join("; ")}.` : ""}${boot ? ` ${boardP!.mech.id}'s ${boot.id.toUpperCase()} button is inside: flash it before closing (step "Flash the firmware"); ${sleeps ? `later updates need the board awake: it deep-sleeps, and its USB port is switched off while it sleeps, so the computer cannot see it. Why: the IDE can reset a board into its bootloader only over a live USB port. Fix: give the firmware a way to stay awake for a minute or two (a long button hold, or while USB power is present) and upload in that window; otherwise open the case and hold ${boot.id.toUpperCase()} while plugging in.` : `later updates go over USB without it (the IDE resets the board into its bootloader). If new firmware ever hangs USB, open the case and hold ${boot.id.toUpperCase()} while plugging in.`}` : ""}`, parts: boardP ? [boardP.mech.id] : [], facts: { reachable: access.length, hidden_buttons: hidden.map((h) => h.id).join(", "), ...(sleeps ? { firmware_deep_sleeps: 1 } : {}) } });

  // ---------------------------------------------------------------- 6. the cell
  for (const p of L.placed.filter((x) => x.mech.soft)) {
    const m = mounts.get(p.mech.id);
    const shell = shellOf(p.mech.id);
    const swell = (p.bodyMax[2] - p.bodyMin[2]) * 0.1;
    const face = shell === "back" ? p.bodyMax[2] : p.bodyMin[2];
    const near: string[] = [];
    let closest = Infinity;
    const cell: Box = { min: p.bodyMin, max: p.bodyMax };
    for (const q of L.placed) {
      if (q === p || !xyOverlap({ min: q.bodyMin, max: q.bodyMax }, cell, -0.05)) continue;
      const g = shell === "back" ? q.bodyMin[2] - face : face - q.bodyMax[2];
      if (g >= -0.05 && g < swell + 0.5) {
        near.push(`${q.mech.id}'s edge ${r1(Math.max(0, g))} mm from the cell`);
        closest = Math.min(closest, g);
      }
    }
    for (const q of L.posts) {
      const b: Box = { min: [q.x - q.d / 2, q.y - q.d / 2, q.z0], max: [q.x + q.d / 2, q.y + q.d / 2, q.z1] };
      if (!xyOverlap(b, cell, -0.05)) continue;
      const g = shell === "back" ? b.min[2] - face : face - b.max[2];
      if (g >= -0.05 && g < swell + 0.5) {
        near.push(`a post (${q.why}) ${r1(Math.max(0, g))} mm from the cell`);
        closest = Math.min(closest, g);
      }
    }
    for (const b of L.bosses)
      if (b.x > p.bodyMin[0] - b.od / 2 && b.x < p.bodyMax[0] + b.od / 2 && b.y > p.bodyMin[1] - b.od / 2 && b.y < p.bodyMax[1] + b.od / 2) {
        near.push(`a screw boss over the cell's edge`);
        closest = 0;
      }
    if (near.length) checks.push({ id: "assembly-battery", ok: true, severity: "warning", message: `${name(p.mech.id)} may be pressed by a hard edge: ${near.join("; ")}, while a pouch cell swells about ${r1(swell)} mm. Why: a corner pressing on a LiPo can pierce it as it swells. Fix: a 1 mm foam pad between them (the plan adds it), or more room (update_case {"params": {"gap_mm": ${r1(L.params.gap_mm + 1)}}}).`, parts: [p.mech.id], facts: { closest_mm: r1(Math.max(0, closest)), swell_mm: r1(swell) } });
    // (no cradle is a warning, not a failure: the strap on a foam pad holds it)
    else checks.push({ id: "assembly-battery", ok: true, severity: m && (m.how.includes("cradle") || m.how.includes("corners")) ? "info" : "warning", message: m && (m.how.includes("cradle") || m.how.includes("corners")) ? `${name(p.mech.id)}: ${m.how.includes("cradle") ? "a cradle with two strap slots" : "corner locators"} on the ${shell} wall, a foam pad under it, Kapton over its tab; nothing hard within ${r1(swell + 0.5)} mm of it (it may swell ${r1(swell)} mm). It is connected last, after a test on USB.` : `${name(p.mech.id)} has no cradle or corner locators. Why: ${m?.missing ?? "the parts round it leave no room"}. Fix: hold it with a Kapton strap on a foam pad, or more room round it (gap_mm).`, parts: [p.mech.id], facts: { swell_mm: r1(swell) } });
  }

  // ---------------------------------------------------------------- 7. screws
  if (L.bosses.length) {
    const bad: string[] = [];
    if (L.params.belt_clip) {
      const H = L.outer.h;
      const lenC = Math.min(50, Math.max(20, H * 0.6));
      const yTop = L.outer.max[1] - Math.max(4, H * 0.15);
      for (const b of L.bosses) if (Math.abs(b.x) < 9 + 2.1 && b.y < yTop + 2.1 && b.y > yTop - lenC - 2.1) bad.push(`the screw at (${r1(b.x)}, ${r1(b.y)}) mm is under the belt clip`);
    }
    if (L.tab) for (const b of L.bosses) if (Math.abs(b.x - L.tab.x) < L.tab.w / 2 + 2.1 && Math.abs(b.y - L.tab.y) < L.tab.h / 2 + 2.1) bad.push(`the screw at (${r1(b.x)}, ${r1(b.y)}) mm is under the lanyard tab`);
    checks.push(bad.length ? { id: "assembly-screws", ok: false, severity: "error", message: `A screw has no way in for the screwdriver: ${bad.join("; ")}. Why: the screws go in from the back, straight along the case's depth. Fix: drop the belt clip (glue it on after closing is not possible over a screw head), or closure "snap".`, facts: { screws: L.bosses.length } } : { id: "assembly-screws", ok: true, severity: "info", message: `${L.bosses.length} M2 screws go in from the back, each counterbored, straight down into a heat-set insert in the front shell: a PH0 (or 1.5 mm hex) driver reaches every one.`, facts: { screws: L.bosses.length } });
  }

  // ---------------------------------------------------------------- 8. how each part is held
  // (a tiny part with nothing to expose, a diode or a resistor, is fine on a strip of tape and its wires)
  const tiny = (id: string) => {
    const p = byId.get(id);
    return !!p && p.mech.w * p.mech.h * p.mech.d < 150 && !p.mech.features.some((f) => f.expose);
  };
  const taped = [...mounts.values()].filter((m) => m.how.includes("foam-tape") && !tiny(m.part));
  checks.push(taped.length ? { id: "assembly-held", ok: true, severity: "warning", message: `Held with foam tape where a printed clip would be better: ${taped.map((m) => `${m.part} (${m.missing ?? "no room for a rib or post"})`).join("; ")}. Why: there is no free room for the feature that would hold it. Fix: more room round it (update_case {"params": {"gap_mm": ${r1(L.params.gap_mm + 1)}}}) and design again; foam tape works if you clean both surfaces first.`, parts: taped.map((m) => m.part), facts: { taped: taped.length } } : { id: "assembly-held", ok: true, severity: "info", message: `Every part is held: ${[...mounts.values()].map((m) => `${m.part}: ${tiny(m.part) && m.how.includes("foam-tape") ? "a strip of tape and its wires (a small part)" : m.how.filter((h) => h !== "foam-pad").join(", ")}`).join("; ")}.` });

  // ---------------------------------------------------------------- 9. the steps
  const steps: AssemblyStep[] = [];
  const add = (s: Omit<AssemblyStep, "n" | "fasteners" | "wires" | "tools" | "cautions" | "view"> & Partial<AssemblyStep> & { view?: Partial<AssemblyStep["view"]> }) =>
    steps.push({ n: steps.length + 1, fasteners: [], wires: [], tools: [], cautions: [], ...s, view: { explode: 0, highlight: [], camera: "bench", ...(s.view ?? {}) } } as AssemblyStep);
  const caps = L.openings.filter((o) => o.insert);
  const printed = ["front shell", "back shell", ...caps.map((o) => `${o.insert!.kind === "cap" ? "button plunger" : "light pipe"} for ${o.part}`), ...(L.params.belt_clip ? ["belt clip"] : [])];
  add({ title: "Check the printed parts", say: `Print the case (enclosure/PRINT.md): ${printed.join(", ")}. Remove the brim, clear each hole with a 2 mm drill or a knife, then press the two shells together once without anything inside: they should close evenly${L.lip ? " and click" : ""}. If they do not, fix the print (or the tolerance) before going on.`, shell: "bench", parts: [], action: "test", tools: ["flush cutters", "hobby knife"], cautions: ["Do not force a tight fit: sand the lip or reprint with tolerance_mm 0.3."], view: { camera: "exploded", explode: 1, highlight: [] } });
  if (L.bosses.length) add({ title: "Press in the heat-set inserts", say: `Press an M2 heat-set insert into each of the ${L.bosses.length} bosses of the front shell with the soldering iron at about 220 °C, straight down until it is flush; let them cool.`, shell: "front", parts: [], action: "press-fit", fasteners: [{ kind: "heat-set insert", size: "M2 x 3 mm (3.2 mm hole)", qty: L.bosses.length }], tools: ["soldering iron (insert tip or a conical tip)", "tweezers"], cautions: ["Keep the iron straight: a tilted insert makes the screw bind."], view: { camera: "front-shell", explode: 0, highlight: [] } });
  if (board) add({ title: "Flash the firmware", say: `Before anything is soldered, flash the firmware onto the bare ${name(board.id)} (firmware/FLASHING.md) and check it starts: the serial monitor prints or the screen lights. A board that does not flash is easy to swap now.`, shell: "bench", parts: [board.id], action: "flash", tools: ["USB cable for the board", "computer"], cautions: ["Flash it bare: once it is wired, a short could hide a flashing problem."], view: { camera: "bench", explode: 0, highlight: [board.id] } });
  const solderTools = ["soldering iron (fine tip, about 330 °C)", "solder (0.5 mm, rosin core)", "flux", "tweezers", "helping hands"];
  if (wires.length) add({ title: "Cut, strip and tin the wires", say: `Cut the ${wires.length} wires to the lengths in electronics/WIRE-CUTS.csv${cross.length ? ` (the ${cross.length} between the shells are longer so the case can open like a book)` : ""}, strip 5 mm at each end and tin every end. Label each with its wire id on a bit of tape.`, shell: "bench", parts: [], action: "solder", wires, tools: ["wire stripper (24 to 26 AWG)", "flush cutters", ...solderTools.slice(0, 3)], cautions: [], view: { camera: "bench", explode: 0, highlight: [] } });
  const harness = wires.filter((w) => w.route === "harness");
  if (harness.length) {
    const ids = [...new Set(harness.flatMap((w) => [partOf(w.from), partOf(w.to)]).filter((p) => inline.has(p) || !byId.has(p)))];
    add({ title: "Solder the small parts into the wires", say: `${ids.map(name).join(", ")} ride in the wiring: solder ${ids.length > 1 ? "each" : "it"} in line between its wires and cover the joints with heat-shrink.`, shell: "bench", parts: ids, action: "solder", wires: harness, tools: [...solderTools, "heat gun or lighter"], cautions: ["Slide the heat-shrink on before soldering."], view: { camera: "bench", explode: 0, highlight: ids } });
  }
  for (const shell of ["front", "back"] as const) {
    // a plunger / light pipe goes into the shell whose wall has its hole
    const shellCaps = caps.filter((o) => (o.at[2] >= L.split ? "front" : "back") === shell);
    if (shellCaps.length) add({ title: `Put the ${shellCaps.some((o) => o.insert!.kind === "cap") ? "button plungers" : "light pipes"} into the ${shell} shell`, say: `From the inside of the ${shell} shell, push ${shellCaps.map((o) => `the ${o.insert!.kind === "cap" ? "plunger" : "light pipe"} for ${o.part} into its hole on the ${o.face}`).join(", and ")}, flange inside. They go in before the parts behind them.`, shell, parts: shellCaps.map((o) => `${o.insert!.kind === "cap" ? "cap" : "light-pipe"}-${o.part}`), action: "place", cautions: ["Check each one moves freely before the part goes behind it."], view: { camera: shell === "front" ? "front-shell" : "back-shell", explode: 6, highlight: shellCaps.map((o) => `${o.insert!.kind === "cap" ? "cap" : "light-pipe"}-${o.part}`) } });
    for (const id of order[shell]) {
      if (deferred.has(id)) continue;
      const m = mounts.get(id);
      const p = byId.get(id)!;
      const pre = leads.get(id);
      if (pre?.length) add({ title: `Solder leads to ${id} first`, say: `Before ${name(id)} goes in, solder these wires to it on the bench (their pads end up under ${[...new Set(pre.map((x) => x.under))].join(", ")}): ${pre.map((x) => `${x.wire.id} on ${x.end}`).join(", ")}. Leave the other ends free.`, shell: "bench", parts: [id], action: "solder", wires: pre.map((x) => x.wire), tools: solderTools, cautions: ["Keep the leads along the part's edge so it still sits flat."], view: { camera: "bench", explode: 0, highlight: [id] } });
      const after = order[shell].slice(order[shell].indexOf(id) + 1).filter((q) => xyOverlap(env(byId.get(q)!), env(p), -0.05));
      const action: AssemblyAction = m?.how.includes("foam-tape") ? "tape" : m?.insert === "press" ? "press-fit" : "place";
      const cautions: string[] = [];
      if (p.mech.category === "board") cautions.push("Hold boards by the edges (static).");
      if (L.front === id) cautions.push("Leave the screen's protective film on until the case is closed; do not press on the glass.");
      if (m?.insert === "slide") cautions.push(`Hold it ${m.slide!.need_mm} mm away from the ${m.slide!.opening.split(" on the ")[1]} wall, push the lever through its slot, then lay it down.`);
      if (isCell(id)) cautions.push("Do not connect the cell yet: tape its bare lead ends with Kapton.");
      if (m?.how.includes("foam-tape")) cautions.push(`Why tape: ${m.missing ?? "no room for a printed clip"}.`);
      const how = m ? m.say : `${id} goes into the ${shell} shell.`;
      add({ title: `${action === "press-fit" ? "Press" : m?.insert === "slide" ? "Slide" : "Put"} ${id} into the ${shell} shell`, say: `${how}${after.length ? ` It goes in before ${after.join(", ")}, which ${after.length > 1 ? "cover" : "covers"} it.` : ""}`, shell, parts: [id], action, tools: m?.how.includes("foam-tape") ? ["1 mm double-sided foam tape"] : [], cautions, view: { camera: shell === "front" ? "front-shell" : "back-shell", explode: 8, highlight: [id] } });
      const now = (solderSteps.get(placeTime.get(id)!) ?? []).filter((w) => w.route === shell || w.route === "harness");
      if (now.length) add({ title: `Solder the wires to ${id}`, say: `With ${id} in place, solder ${now.map((w) => `${w.id} (${w.from} to ${w.to}, ${w.color}, ${w.length_mm} mm)`).join(", ")}. Run each along the wall or the edge of a part, through the wiring room, never over the seam.`, shell, parts: [...new Set(now.flatMap((w) => [partOf(w.from), partOf(w.to)]))], action: "solder", wires: now, tools: solderTools, cautions: ["Point the iron away from the plastic: PLA softens at about 60 °C.", "Cover any bare joint near another one with heat-shrink or Kapton."], view: { camera: shell === "front" ? "front-shell" : "back-shell", explode: 0, highlight: [id] } });
    }
  }
  const book = solderSteps.get(BOOK) ?? [];
  if (book.length) add({ title: "Open it like a book and join the two shells' wires", say: `Lay the front shell face down next to the back shell on its ${hinge} side, both open sides up, as if the case were a book opened on the ${hinge}. Solder the ${book.length} wires that run between them: ${book.map((w) => `${w.id} (${w.from} to ${w.to}, ${w.length_mm} mm)`).join(", ")}. ${splices.length ? `Join the leads of ${splices.map((s) => s.wire.id).join(", ")} with a splice and heat-shrink. ` : ""}Bundle them with a strip of Kapton near the ${hinge} wall so they fold in when the case closes.`, shell: "both", parts: [...new Set(book.flatMap((w) => [partOf(w.from), partOf(w.to)]))], action: "route-wire", wires: book, tools: [...solderTools, "Kapton tape"], cautions: ["Keep the bundle away from the lip and the screw bosses."], view: { camera: "open-book", explode: 0, highlight: [...new Set(book.flatMap((w) => [partOf(w.from), partOf(w.to)]))] } });
  for (const c of cards) add({ title: `Put the ${c.what} into ${c.part}`, say: `Copy the files from sd-card/ onto the ${c.what} (sd-card/CLIPS.md), then push it into ${name(c.part)} until it clicks. It stays inside the closed case: to change it later, open the case.`, shell: shellOf(c.part), parts: [], action: "place", tools: [], cautions: ["Format it FAT32 first; copy the files in order."], view: { camera: shellOf(c.part) === "front" ? "front-shell" : "back-shell", explode: 0, highlight: [c.part] } });
  const hasBattery = L.placed.some((p) => p.mech.soft);
  // what the person can check from outside: only what this device has (a screen, buttons, a switch, sound, lights)
  const kinds = new Set(L.placed.flatMap((p) => p.mech.features.filter((f) => f.expose !== false).map((f) => f.kind)));
  const seen = [kinds.has("screen") ? "the screen" : "", kinds.has("button") ? "the buttons" : "", kinds.has("switch") ? "the switch" : "", kinds.has("knob") ? "the knob" : "", kinds.has("grille") ? "the sound" : "", kinds.has("led") ? "the lights" : ""].filter(Boolean);
  const seenWords = seen.length > 1 ? `${seen.slice(0, -1).join(", ")} and ${seen.at(-1)}` : seen[0];
  const closedChecks = [caps.some((o) => o.insert!.kind === "cap") ? "press every button through its plunger" : kinds.has("button") ? "press every button" : "", kinds.has("switch") ? "slide the switch both ways" : "", kinds.has("screen") ? "check the screen through the window" : ""].filter(Boolean);
  const usb = access.find((a) => a.startsWith(`${board?.id}.`)) ?? access[0];
  add({ title: "Test it on USB before the battery", say: `${usb ? `Plug a USB cable into ${usb.split(" (")[0]}` : "Power it"} with the case still open${hasBattery ? " and the battery not connected" : ""}. Run through test/TEST-PLAN.md: ${seenWords ? `${seenWords} should behave` : "it should behave"} as in the simulation. Fix anything now, while every joint is easy to reach.`, shell: "both", parts: board ? [board.id] : [], action: "test", tools: ["USB cable", "multimeter"], cautions: ["Look for a hot part in the first seconds: unplug at once if anything warms up."], view: { camera: "open-book", explode: 0, highlight: board ? [board.id] : [] } });
  const cells = L.placed.filter((p) => p.mech.soft);
  for (const c of cells) {
    const m = mounts.get(c.mech.id);
    const bw = solderSteps.get(BATTERY) ?? [];
    add({ title: `Place and connect the battery ${c.mech.id}`, say: `${deferred.has(c.mech.id) ? `Stick a 1 mm foam pad on the ${shellOf(c.mech.id)} wall where the cell goes and lay ${name(c.mech.id)} on it${m?.how.includes("cradle") ? " in its cradle" : m?.how.includes("corners") ? " between its corner locators" : ""}. ` : `${c.mech.id} is already in place. `}Put Kapton tape over its protection board and tab, then a Kapton strap over it${m?.how.includes("cradle") ? " through the cradle's slots" : ""}. Last, connect its leads: ${bw.length ? bw.map((w) => `${w.id} (${w.from} to ${w.to})`).join(", ") : "its connector"}, red to + first, one lead at a time.`, shell: shellOf(c.mech.id), parts: [c.mech.id], action: "tape", wires: bw, tools: ["Kapton tape", "1 mm foam pad", ...solderTools.slice(0, 3)], cautions: ["Never let the two bare leads touch, and never solder with both connected to anything else.", "Do not bend, press or pierce the cell; nothing hard may press on it (it swells up to 10 %).", "Check the polarity with a multimeter before connecting: a reversed LiPo destroys the charger."], view: { camera: shellOf(c.mech.id) === "front" ? "front-shell" : "back-shell", explode: 8, highlight: [c.mech.id] } });
  }
  const sw = L.placed.find((p) => p.mech.features.some((f) => f.kind === "switch"));
  if (cells.length) add({ title: "Test it on the battery", say: `Unplug USB${sw ? ` and switch it on with ${sw.mech.id}` : ""}: it should start from the battery. Then plug USB into the charging port and check the charge light.`, shell: "both", parts: cells.map((c) => c.mech.id), action: "test", tools: ["multimeter"], cautions: ["If it does not start, switch off and check the battery wiring before anything else."], view: { camera: "open-book", explode: 0, highlight: cells.map((c) => c.mech.id) } });
  for (const h of (full.held ?? []).filter((x) => !x.removable)) add({ title: `Put ${h.name} in`, say: `${h.name} stays inside: lay it into its room in the back shell now (${h.room_mm.w} x ${h.room_mm.h} x ${h.room_mm.d} mm, the sleeve walls round it), before the front shell goes on.`, shell: "back", parts: [], action: "place", tools: [], cautions: [h.measure], view: { camera: "back-shell", explode: 0, highlight: [] } });
  add({ title: "Close the case", say: `Fold the wires in so none crosses the seam${L.lip ? " or the lip" : ""}, line the front shell up with the back and ${L.bosses.length ? `fit the ${L.bosses.length} M2 screws from the back into the inserts, finger tight (they strip plastic easily)` : "press it on evenly all round until the lip clicks"}. Nothing should need force: if it does, a wire or a part is in the way.`, shell: "closed", parts: [], action: L.bosses.length ? "screw" : "close", fasteners: L.bosses.length ? [{ kind: "screw", size: "M2 pan head (length in enclosure/PRINT.md)", qty: L.bosses.length }] : [], tools: L.bosses.length ? ["PH0 screwdriver (or 1.5 mm hex)"] : [], cautions: ["A pinched wire can short: look along the seam before the last press."], view: { camera: "exploded", explode: 1, highlight: [] } });
  // round 17: a socket: the case goes onto the object (a lid-topper on a can's lid)
  for (const h of (full.held ?? []).filter((x) => x.removable && x.engage_mm !== undefined)) add({ title: `Put the case on ${h.name}`, say: `${h.fit === "snap" ? "Press" : "Push"} the case onto ${h.name}: its socket on the ${h.from} (${h.opening_mm ? `${h.opening_mm.w} x ${h.opening_mm.h} mm` : "the opening"}) takes ${h.engage_mm} mm of it${h.fit === "snap" ? " and its rim clicks over the edge" : h.fit === "press" ? " tightly" : ` with ${h.clearance_mm} mm to spare`}; ${h.proud_mm !== undefined ? `the rest (${h.proud_mm} mm) stays outside` : "the rest stays outside"}.${h.sensing ? ` Glue the magnet on ${h.name} where the held-sensor check puts it (outside the socket, on the side facing ${h.sensing.sensor}, about ${h.sensing.mounted_mm} mm from it with the case on), then lift the case off and on a few times: ${h.sensing.sensor} must switch each time.` : ""}`, shell: "closed", parts: [], action: "place", tools: [], cautions: [h.measure], view: { camera: "closed", explode: 0, highlight: [] } });
  for (const h of (full.held ?? []).filter((x) => x.removable && x.engage_mm === undefined)) add({ title: `Put ${h.name} in`, say: `${h.insert === "slide" ? `Slide ${h.name} into the slot on the ${h.from}` : h.insert === "snap" ? `Press ${h.name} into the opening on the ${h.from} until the rim clicks over it` : `Drop ${h.name} into the opening on the ${h.from}`} (${h.opening_mm ? `${h.opening_mm.w} x ${h.opening_mm.h} mm` : "its opening"}). It should go in by hand with ${h.clearance_mm} mm to spare and come out the same way; the electronics stay put.`, shell: "closed", parts: [], action: "place", tools: [], cautions: [h.measure], view: { camera: "closed", explode: 0, highlight: [] } });
  add({ title: "Final test, closed", say: `With the case closed: ${access.length ? `plug a cable into ${access.map((a) => a.split(" (")[0]).join(" and ")}` : "power it on"}; ${closedChecks.length ? `${closedChecks.join("; ")}; ` : ""}then run test/TEST-PLAN.md and test/TEST-ON-HARDWARE.md once more.`, shell: "closed", parts: [], action: "test", tools: ["USB cable"], cautions: ["Peel the screen's film last."], view: { camera: "closed", explode: 0, highlight: [] } });

  // ---------------------------------------------------------------- 10. consumables and tools
  const byGauge = new Map<number, number>();
  for (const w of wires) byGauge.set(w.gauge, (byGauge.get(w.gauge) ?? 0) + w.length_mm);
  const consumables: AssemblyPlan["consumables"] = [];
  for (const [g, mm] of [...byGauge.entries()].sort((a, b) => a[0] - b[0])) consumables.push({ item: `Silicone hook-up wire ${g} AWG`, qty: `${(Math.ceil((mm * 1.2) / 100) / 10).toFixed(1)} m`, why: `${wires.filter((w) => w.gauge === g).length} wires (lengths in WIRE-CUTS.csv) + 20 % spare` });
  const shrink = harness.length * 2 + splices.length + 4;
  consumables.push({ item: "Heat-shrink tubing 1.5 to 3 mm", qty: `${shrink} pieces`, why: "inline parts, splices and any joint near another" });
  consumables.push({ item: "Solder 0.5 mm rosin core and flux", qty: "a few grams", why: `${wires.length * 2} joints` });
  if (cells.length) consumables.push({ item: "Kapton tape 10 mm", qty: "30 cm", why: "over the cell's tab and as its strap; wire bundles" }, { item: "Foam pad 1 mm (EVA or PU, adhesive)", qty: `${cells.length} piece${cells.length > 1 ? "s" : ""} the size of the cell`, why: "under the cell: room to swell, no hard edge" });
  if (taped.length) consumables.push({ item: "Double-sided foam tape 1 mm", qty: `${taped.length} strip${taped.length > 1 ? "s" : ""}`, why: `holds ${taped.map((m) => m.part).join(", ")}` });
  if (L.bosses.length) consumables.push({ item: "M2 screws, pan head", qty: L.bosses.length, why: "close the case (length in PRINT.md)" }, { item: "M2 x 3 mm brass heat-set inserts", qty: L.bosses.length, why: "front shell bosses" });
  if (L.params.belt_clip) consumables.push({ item: "CA glue or 3M VHB tape", qty: "a little", why: "the belt clip on the back" });
  const tools = [...new Set(steps.flatMap((s) => s.tools))];
  return {
    title,
    steps,
    checks,
    consumables,
    tools,
    order: {
      front: [...caps.filter((o) => o.at[2] >= L.split).map((o) => `${o.insert!.kind === "cap" ? "cap" : "light-pipe"}-${o.part}`), ...order.front],
      back: [...caps.filter((o) => o.at[2] < L.split).map((o) => `${o.insert!.kind === "cap" ? "cap" : "light-pipe"}-${o.part}`), ...order.back],
    },
    hinge,
    wires,
    mounts: [...mounts.values()].map((m) => ({ part: m.part, shell: m.shell, how: m.how, insert: m.insert, say: m.say, ...(m.missing ? { missing: m.missing } : {}) })),
    wires_key: wiresKey(project),
    ...(input.firmwareText !== undefined ? { firmware_card: firmwareUsesCard(input.firmwareText) } : {}),
  };
}

/** The wiring a plan was made for (to spot a plan made before the wires changed). */
export function wiresKey(project: Project): string {
  return project.wires.map((w) => `${w.id}:${w.from.part}.${w.from.pin}-${w.to.part}.${w.to.pin}`).sort().join(",");
}
