// Round 6, track "power" (owner): how a device is put together (decision 0004, R2).
//
// A project is built either on a breadboard with dupont wires (desk prototypes on an Uno / Nano) or
// soldered: hand-wired point to point (or on perfboard) inside a case, which is what a pocket device
// is. The soldered style exports cut lists instead of breadboards: one line per wire with its length,
// colour and gauge, so whoever builds it (the person, or a supplier) can cut and strip them up front.
import { buildNets, type Project } from "@fabwright/project-format";
import type { PartRegistry, PartSpec } from "@fabwright/sim-core";

export type AssemblyStyle = "breadboard" | "soldered";

export interface WireCut {
  wire: string;
  /** "xiao.GP6" */
  from: string;
  to: string;
  /** Plain colour name, e.g. "red". */
  color: string;
  /** Rounded up to 5 mm; includes 10 mm of strip (5 mm per end) and slack. */
  length_mm: number;
  /** 26 for signals, 24 for power and ground. */
  gauge_awg: number;
}

/** Boards made to be built into something small: projects on them default to the soldered style. */
const POCKET_BOARDS = new Set(["seeed-xiao-rp2040", "waveshare-rp2040-zero"]);

/** The project's assembly style: fabwright.json `assembly`, else soldered for a case or a pocket board, else breadboard. */
export function assemblyStyle(project: Project, registry: PartRegistry): AssemblyStyle {
  if (project.assembly) return project.assembly;
  if (project.enclosure) return "soldered";
  const board = project.parts.find((p) => p.id === project.firmware?.board) ?? project.parts.find((p) => registry.get(p.type)?.spec.category === "board");
  const spec = board ? registry.get(board.type)?.spec : undefined;
  if (spec && (POCKET_BOARDS.has(spec.id) || spec.tags?.includes("pocket"))) return "soldered";
  return "breadboard";
}

/** Why the style is what it is, in words (set_assembly, exports). */
export function assemblyReason(project: Project, registry: PartRegistry): string {
  if (project.assembly) return `set in fabwright.json ("assembly": "${project.assembly}")`;
  if (project.enclosure) return "the project has a case, so it is hand-wired inside it";
  return assemblyStyle(project, registry) === "soldered" ? "the board is a pocket board, made to be soldered into something small" : "the default for a desk prototype on a full-size board";
}

const COLOR_NAMES: Record<string, string> = {
  "#FF4D2E": "red",
  "#2B3038": "black",
  "#F2E14A": "yellow",
  "#4DA3FF": "blue",
  "#E9EDF2": "white",
  "#B47CFF": "purple",
  "#5CF2A1": "green",
  "#FFB23F": "orange",
};

/** A wire colour as a name a supplier understands (hex colours become the nearest of the canvas palette names, else "any"). */
export function colorName(hex: string | undefined): string {
  if (!hex) return "any";
  return COLOR_NAMES[hex.toUpperCase()] ?? "any";
}

/** Strip both ends (5 mm each) and leave room to route and bend: what is added to the straight distance. */
export const STRIP_MM = 10;
export const SLACK_MM = 15;
/** Point-to-point wires do not run straight: they follow the case wall and go around parts. */
export const ROUTE_FACTOR = 1.3;

function pinOffsetMm(spec: PartSpec, pin: string): [number, number] {
  const p = spec.pins.find((x) => x.id === pin);
  const d = spec.dimensions_mm;
  if (!p || !d) return [0, 0];
  // Pin position in the part frame (R1), relative to the part's centre.
  return [(p.x / spec.size.w - 0.5) * d.w, (p.y / spec.size.h - 0.5) * d.h];
}

/**
 * Cut list for a soldered build. `positions` are 3D pin positions in mm (case frame) from the case
 * layout (keys "part.pin"); without them the length is estimated from the parts' dimensions_mm as
 * if they sat side by side, which is on the long side for a tightly packed case.
 */
export function wireCuts(project: Project, registry: PartRegistry, positions?: Record<string, [number, number, number]>): WireCut[] {
  const inst = new Map(project.parts.map((p) => [p.id, p]));
  const specOf = (part: string) => {
    const t = inst.get(part)?.type;
    return t ? registry.get(t)?.spec : undefined;
  };
  // Nets that carry power: any power or ground pin on them.
  const powerNets = new Set<string>();
  const netOf = new Map<string, string>();
  for (const n of buildNets(project)) {
    for (const r of n.pins) {
      netOf.set(`${r.part}.${r.pin}`, n.id);
      const t = specOf(r.part)?.pins.find((x) => x.id === r.pin)?.type;
      if (t === "power" || t === "ground") powerNets.add(n.id);
    }
  }
  // A switch or diode in a power path carries the supply too (cell → switch → diode → VBUS).
  const PASS = new Set(["slide-switch", "schottky-diode", "generic-diode"]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of project.parts) {
      if (!PASS.has(p.type)) continue;
      const ids = (registry.get(p.type)?.spec.pins ?? []).map((x) => netOf.get(`${p.id}.${x.id}`)).filter((n): n is string => !!n);
      if (ids.some((n) => powerNets.has(n)) && ids.some((n) => !powerNets.has(n))) {
        for (const n of ids) powerNets.add(n);
        changed = true;
      }
    }
  }
  const half = (s: PartSpec | undefined) => (s?.dimensions_mm ? Math.max(s.dimensions_mm.w, s.dimensions_mm.h) / 2 : 10);
  return project.wires.map((w) => {
    const from = `${w.from.part}.${w.from.pin}`;
    const to = `${w.to.part}.${w.to.pin}`;
    let straight: number;
    const a = positions?.[from];
    const b = positions?.[to];
    if (a && b) straight = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    else if (w.from.part === w.to.part) {
      const s = specOf(w.from.part);
      const [ax, ay] = s ? pinOffsetMm(s, w.from.pin) : [0, 0];
      const [bx, by] = s ? pinOffsetMm(s, w.to.pin) : [0, 0];
      straight = Math.hypot(ax - bx, ay - by);
    } else {
      const sa = specOf(w.from.part);
      const sb = specOf(w.to.part);
      const [ax, ay] = sa ? pinOffsetMm(sa, w.from.pin) : [0, 0];
      const [bx, by] = sb ? pinOffsetMm(sb, w.to.pin) : [0, 0];
      // Centres one part-size apart with a 5 mm gap; the pins' offsets from their centres on top.
      straight = half(sa) + half(sb) + 5 + Math.hypot(ax, ay) * 0.5 + Math.hypot(bx, by) * 0.5;
    }
    const length = Math.ceil((straight * ROUTE_FACTOR + STRIP_MM + SLACK_MM) / 5) * 5;
    const net = netOf.get(from) ?? netOf.get(to);
    return { wire: w.id, from, to, color: colorName(w.color), length_mm: length, gauge_awg: net && powerNets.has(net) ? 24 : 26 };
  });
}

/** WIRE-CUTS.csv: wire,from,to,color,length_mm,gauge_awg,note. */
export function wireCutsCsv(cuts: WireCut[], estimated: boolean): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["wire,from,to,color,length_mm,gauge_awg,note"];
  for (const c of cuts) lines.push([c.wire, c.from, c.to, c.color, String(c.length_mm), String(c.gauge_awg), estimated ? "estimated from part sizes; measure in the case before cutting" : "from the case layout"].map(q).join(","));
  return lines.join("\n") + "\n";
}

/** Totals per gauge for the BOM (mm, rounded up to 10 cm, + 20 % spare). */
export function wireTotals(cuts: WireCut[]): { gauge_awg: number; total_mm: number; count: number }[] {
  const by = new Map<number, { total: number; count: number }>();
  for (const c of cuts) {
    const g = by.get(c.gauge_awg) ?? { total: 0, count: 0 };
    g.total += c.length_mm;
    g.count++;
    by.set(c.gauge_awg, g);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([gauge_awg, g]) => ({ gauge_awg, count: g.count, total_mm: Math.ceil((g.total * 1.2) / 100) * 100 }));
}
