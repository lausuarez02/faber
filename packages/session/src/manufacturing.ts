/**
 * Round 6, case track (decision 0004, R5): the factory pack. Everything a supplier (or the person)
 * needs to build the device: BOM with MPNs, wiring + netlists (CSV and KiCad legacy), wire cuts,
 * firmware (hex / uf2 + source + flashing steps), the case files, assembly steps with renders, the
 * test plan, and honest notes about what was only simulated. English, simple; optional zh-CN summary.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { zipSync } from "fflate";
import { buildNets, type Project } from "@jumper/project-format";
import type { PartRegistry, PartSpec } from "@jumper/sim-core";
import { partLabel, partValue } from "./exporter.ts";
import type { WireCut } from "./assembly.ts"; // round 6: the power track's wire-cut model is the one used

/** Pin positions in the case frame from a placed layout (pins on the part's top face). */
export function pinPositions(placed: { mech: { id: string; type: string; w: number; h: number; d: number }; R: number[][]; T: number[] }[], specOf: (t: string) => PartSpec | undefined): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const p of placed) {
    const spec = specOf(p.mech.type);
    if (!spec) continue;
    const { w, h, d } = p.mech;
    const sw = spec.size.w;
    const sh = spec.size.h;
    // the drawing may be turned a quarter (portrait XIAO): then svg top = part -x
    const turned = Math.abs(Math.log(sw / sh / (w / h))) > Math.abs(Math.log((sw / sh) * (w / h))) + 0.05;
    for (const pin of spec.pins) {
      const px = turned ? (pin.y / sh) * w : (pin.x / sw) * w;
      const py = turned ? (1 - pin.x / sw) * h : (pin.y / sh) * h;
      const l = [px - w / 2, h / 2 - py, d];
      const R = p.R;
      out[`${p.mech.id}.${pin.id}`] = [0, 1, 2].map((i) => R[i]![0]! * l[0]! + R[i]![1]! * l[1]! + R[i]![2]! * l[2]! + p.T[i]!) as [number, number, number];
    }
  }
  return out;
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export interface BomLine {
  line: number;
  refs: string;
  qty: number;
  name: string;
  /** What is printed on the part / goes in KiCad's value field ("100k", "1uF", "MCP1700-3.3"), "" when none. */
  value: string;
  mpn: string;
  manufacturer: string;
  lcsc: string;
  jlc: string;
  package: string;
  generic: string;
  unit_usd: number | "";
  ext_usd: number | "";
  buy_url: string;
  source: string;
  notes: string;
}

export function bomLines(project: Project, registry: PartRegistry, opts: { soldered: boolean; cuts: WireCut[]; screws?: { count: number; size: string; inserts: string }; consumables?: { item: string; qty: number | string; why: string }[] }): BomLine[] {
  const groups = new Map<string, { ids: string[]; type: string; props: string; standIn?: string }>();
  for (const p of project.parts) {
    // round 7 voice: text props (a DFPlayer's clips) go to sd-card/, not into a BOM cell
    const textProps = new Set((registry.get(p.type)?.spec.props ?? []).filter((x) => x.type === "text").map((x) => x.id));
    const props = Object.entries(p.props ?? {}).filter(([k]) => !textProps.has(k)).map(([k, v]) => `${k}=${v}`).join("; ");
    const k = `${p.type}|${props}|${p.standIn ?? ""}`;
    const g = groups.get(k) ?? { ids: [], type: p.type, props, ...(p.standIn ? { standIn: p.standIn } : {}) };
    g.ids.push(p.id);
    groups.set(k, g);
  }
  const out: BomLine[] = [];
  for (const g of groups.values()) {
    const spec = registry.get(g.type)?.spec;
    const first = project.parts.find((p) => p.id === g.ids[0])!;
    const label = partLabel(first, registry);
    const value = g.standIn ? "" : (partValue(first, registry) ?? "");
    const s = g.standIn ? undefined : spec?.sourcing;
    const price = !g.standIn && spec?.price_usd !== undefined ? spec.price_usd : "";
    out.push({
      line: out.length + 1,
      refs: g.ids.join(" "),
      qty: g.ids.length,
      name: label.name,
      value,
      mpn: s?.mpn ?? "",
      manufacturer: s?.manufacturer ?? "",
      lcsc: s?.lcsc ?? "",
      jlc: s?.jlc ?? "",
      package: s?.package ?? "",
      generic: g.standIn ? `${g.standIn} (real part; see its datasheet)` : (s?.generic ?? spec?.footprint ?? ""),
      unit_usd: price,
      ext_usd: price === "" ? "" : Math.round(price * g.ids.length * 100) / 100,
      buy_url: spec?.buy_links?.[0]?.url ?? "",
      source: g.standIn ? "stand-in" : registry.get(g.type)?.fidelity.origin === "agent-made" ? "agent-made" : "catalog",
      notes: [g.props, label.note].filter(Boolean).join("; "),
    });
  }
  // round 7 voice: a DFPlayer needs its microSD card with the clips on it.
  const talkers = project.parts.filter((p) => registry.get(p.type)?.spec.props?.some((x) => x.id === "clips"));
  if (talkers.length) {
    out.push({ line: out.length + 1, refs: "", qty: talkers.length, name: "microSD card", value: "", mpn: "", manufacturer: "", lcsc: "", jlc: "", package: "microSD", generic: "microSD card 1 to 32 GB (any class), FAT32", unit_usd: 3, ext_usd: 3 * talkers.length, buy_url: "", source: "assembly", notes: `for ${talkers.map((t) => t.id).join(", ")}: the clips from sd-card/ (CLIPS.md)` });
  }
  if (opts.soldered) {
    const total = (awg: number) => opts.cuts.filter((c) => c.gauge_awg === awg).reduce((a, c) => a + c.length_mm, 0);
    const add = (name: string, generic: string, qty: number, notes: string, unit: number | "" = "") => out.push({ line: out.length + 1, refs: "", qty, name, value: "", mpn: "", manufacturer: "", lcsc: "", jlc: "", package: "", generic, unit_usd: unit, ext_usd: unit === "" ? "" : Math.round(unit * qty * 100) / 100, buy_url: "", source: "assembly", notes });
    if (total(26)) add("Hook-up wire 26 AWG", "Silicone stranded wire 26 AWG, assorted colours", 1, `${(total(26) / 1000).toFixed(2)} m in ${opts.cuts.filter((c) => c.gauge_awg === 26).length} cuts (WIRE-CUTS.csv)`);
    if (total(24)) add("Hook-up wire 24 AWG", "Silicone stranded wire 24 AWG, red and black", 1, `${(total(24) / 1000).toFixed(2)} m in ${opts.cuts.filter((c) => c.gauge_awg === 24).length} cuts (power)`);
    add("Heat-shrink tube", "Heat-shrink 1.5 mm and 3 mm, 2:1", 1, "over every splice and resistor lead");
    add("Foam tape", "Double-sided foam tape 1 mm", 1, "holds modules without standoffs");
    // round 12: what the assembly plan adds (the cell's Kapton strap and foam pad)
    for (const c of opts.consumables ?? []) if (/Kapton|Foam pad/.test(c.item)) add(c.item, c.item, 1, `${c.qty}: ${c.why}`);
  } else if (project.wires.length) {
    out.push({ line: out.length + 1, refs: "", qty: project.wires.length, name: "Jumper wires", value: "", mpn: "", manufacturer: "", lcsc: "", jlc: "", package: "", generic: "Dupont jumper wires 20 cm, male-male / male-female", unit_usd: "", ext_usd: "", buy_url: "", source: "assembly", notes: "breadboard build" });
  }
  if (opts.screws) {
    out.push({ line: out.length + 1, refs: "", qty: opts.screws.count, name: "Screw", value: "", mpn: "", manufacturer: "", lcsc: "", jlc: "", package: "", generic: opts.screws.size, unit_usd: "", ext_usd: "", buy_url: "", source: "case", notes: "closes the case" });
    out.push({ line: out.length + 1, refs: "", qty: opts.screws.count, name: "Heat-set insert", value: "", mpn: "", manufacturer: "", lcsc: "", jlc: "", package: "", generic: opts.screws.inserts, unit_usd: "", ext_usd: "", buy_url: "", source: "case", notes: "" });
  }
  return out;
}

/** "Resistor 1/4 W ... (value as in the BOM)" → "... 100k" so the description itself names the value. */
function withValue(generic: string, value: string): string {
  if (!value) return generic;
  return /\(value as in the BOM\)/.test(generic) ? generic.replace(/\(value as in the BOM\)/, value) : generic;
}

export function bomCsv(lines: BomLine[]): string {
  const cols: (keyof BomLine)[] = ["line", "refs", "qty", "name", "value", "mpn", "manufacturer", "lcsc", "jlc", "package", "generic", "unit_usd", "ext_usd", "buy_url", "source", "notes"];
  return [cols.join(","), ...lines.map((l) => cols.map((c) => csvCell(l[c])).join(","))].join("\n") + "\n";
}

export function bomMd(lines: BomLine[], title: string): string {
  const total = lines.reduce((a, l) => a + (typeof l.ext_usd === "number" ? l.ext_usd : 0), 0);
  return [`# BOM: ${title}`, "", "| # | Refs | Qty | Part | Value | MPN | What to ask for | Unit USD |", "| --- | --- | --- | --- | --- | --- | --- | --- |", ...lines.map((l) => `| ${l.line} | ${l.refs || "–"} | ${l.qty} | ${l.name} | ${l.value || "–"} | ${l.mpn || "–"} | ${withValue(l.generic, l.value) || "–"} | ${l.unit_usd === "" ? "–" : l.unit_usd.toFixed(2)} |`), "", `Parts total about **USD ${total.toFixed(2)}** (typical single-unit prices; volume prices are lower).`, "", "LCSC / JLC columns are filled only for numbers checked on lcsc.com; empty means: quote from the MPN or the description."].join("\n") + "\n";
}

export function netlistCsv(project: Project): string {
  const nets = buildNets(project);
  const lines = ["net,part,pin"];
  nets.forEach((n, i) => {
    const name = netName(n.pins, i);
    for (const p of n.pins) lines.push(`${csvCell(name)},${csvCell(p.part)},${csvCell(p.pin)}`);
  });
  return lines.join("\n") + "\n";
}

function netName(pins: readonly { part: string; pin: string }[], i: number): string {
  const pwr = pins.map((p) => p.pin).find((p) => /^(GND(\.\d+)?|3V3|VBUS|VSYS|VCC|5V|BAT)$/i.test(p));
  if (pwr) return pwr.replace(/\.\d+$/, "") + (pwr.toUpperCase().startsWith("GND") ? "" : `_${i + 1}`);
  return `N${String(i + 1).padStart(3, "0")}`;
}

/** KiCad legacy (S-expression) netlist: components + nets, readable by KiCad's Pcbnew / Eeschema import. */
export function kicadNetlist(project: Project, registry: PartRegistry): string {
  const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
  const comps = project.parts.map((p) => {
    const spec = registry.get(p.type)?.spec;
    const value = p.standIn ? undefined : partValue(p, registry);
    return `    (comp (ref ${q(p.id)})\n      (value ${q(value ?? spec?.sourcing?.mpn ?? spec?.name ?? p.type)})\n      (footprint ${q(spec?.sourcing?.package ?? spec?.footprint ?? "")})\n      (libsource (lib "jumper") (part ${q(p.type)}))\n      (fields (field (name "Description") ${q(spec?.sourcing?.generic ?? spec?.name ?? p.type)})))`;
  });
  const nets = buildNets(project).map((n, i) => `    (net (code ${i + 1}) (name ${q(netName(n.pins, i))})\n${n.pins.map((p) => `      (node (ref ${q(p.part)}) (pin ${q(p.pin)}))`).join("\n")})`);
  return `(export (version D)\n  (design\n    (source "jumper.json")\n    (tool "Jumper")\n    (comment (number 1) (value ${q(project.name)})))\n  (components\n${comps.join("\n")})\n  (nets\n${nets.join("\n")}))\n`;
}

/** Zip a folder (deterministic: sorted, fixed mtime). */
export function zipFolder(dir: string, prefix: string): Uint8Array {
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const mtime = new Date(Date.UTC(2026, 0, 1));
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[`${prefix}/${relative(dir, p).split("\\").join("/")}`] = [readFileSync(p), { mtime }];
    }
  };
  walk(dir);
  return zipSync(files, { level: 6 });
}

export function listFiles(dir: string): { path: string; bytes: number; sha256: string }[] {
  const out: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const b = readFileSync(p);
        out.push({ path: relative(dir, p).split("\\").join("/"), bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") });
      }
    }
  };
  walk(dir);
  return out;
}

export function writeText(root: string, path: string, text: string | Uint8Array): void {
  const p = join(root, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export function copyTree(from: string, to: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  if (!existsSync(from)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(from, p).split("\\").join("/");
      if (skip(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else {
        writeText(to, rel, readFileSync(p));
        out.push(rel);
      }
    }
  };
  walk(from);
  return out;
}

export function clearDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
