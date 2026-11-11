/**
 * Round 8 (view): the parts advice (advice.ts, "parts you may not need") in a person's words, for
 * the Case view: a short title, the reason, what it saves in mm, and, when the change is a plain
 * swap or removal, the agent operations that make it (remove, place_part, connect), so the page can
 * offer one Apply button that does exactly what an agent would. The rest stay notes.
 */
import { buildNets, pinKey, type Project } from "@jumper/project-format";
import type { PartRegistry } from "@jumper/sim-core";
import { partsAdvice } from "./advice.ts";
import { fail } from "./errors.ts";

export interface AdviceNote {
  /** code:part, stable while the project does not change. */
  id: string;
  code: string;
  title: string;
  /** The reason, from the advice's own "Why:". */
  why: string;
  saves: { area_mm2?: number; depth_mm?: number; mass_g?: number };
  parts: string[];
  /** Present when one click can make the change (what the button says). */
  apply?: { label: string; result: string };
}

export interface AdviceOp {
  op: "remove" | "place_part" | "connect";
  args: Record<string, unknown>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The advice for this project as notes for people (no tool names). */
export function adviceNotes(project: Project, registry: PartRegistry): AdviceNote[] {
  const dims = (id: string) => registry.get(project.parts.find((p) => p.id === id)?.type ?? "")?.spec;
  const out: AdviceNote[] = [];
  for (const i of partsAdvice(project, registry)) {
    const part = i.parts[0]!;
    const why = plain(i.message.split("Why: ")[1]?.split(" Fix:")[0] ?? i.message);
    const spec = dims(part);
    const d = spec?.dimensions_mm;
    const base = { id: `${i.code}:${part}`, code: i.code, why, parts: i.parts };
    if (i.code === "boost-not-needed") {
      out.push({ ...base, title: `The 5 V booster (${part}) may not be needed`, saves: { ...(d ? { area_mm2: Math.round(d.w * d.h) } : {}), ...(spec?.mass_g ? { mass_g: spec.mass_g } : {}) }, ...(applyOps(project, registry, base.id).length ? { apply: { label: `Remove ${part}`, result: `Removed ${part} and wired the battery straight to the parts it fed.` } } : {}) });
    } else if (i.code === "smaller-speaker") {
      const small = registry.get("speaker-20mm")?.spec.dimensions_mm;
      out.push({ ...base, title: `A 20 mm speaker is enough for speech (${part})`, saves: d && small ? { area_mm2: Math.round(d.w * d.h - small.w * small.h), depth_mm: r1(d.d - small.d) } : {}, apply: { label: "Swap to 20 mm", result: `${part} is now a 20 mm speaker, wired the same way.` } });
    } else if (i.code === "combine-charge-boost") {
      const m = /\((\d+) → (\d+) mm²\)/.exec(i.message);
      out.push({ ...base, title: `The charger and the booster could be one module`, saves: m ? { area_mm2: Number(m[1]) - Number(m[2]) } : {} });
    } else if (i.code === "board-bigger-than-needed") {
      out.push({ ...base, title: `A smaller board has enough pins for ${part}`, saves: d ? { area_mm2: Math.round(d.w * d.h) } : {} });
    } else if (i.code === "charger-not-needed") {
      out.push({ ...base, title: `The board charges the battery itself, so ${part} may not be needed`, saves: d ? { area_mm2: Math.round(d.w * d.h) } : {} });
    } else out.push({ ...base, title: i.message.split(". Why:")[0] ?? i.code, saves: {} });
  }
  return out;
}

/** Tool names and wiring jargon out of a reason meant for a person. */
function plain(s: string): string {
  return s
    .replace(/\b(check_design|place_part|get_part|plan_device|connect|remove)\b(\s*\{[^}]*\})?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The agent operations that apply one note (in order; run them with one `why` so they are one
 * undoable step). Empty when the note has no simple change.
 */
export function applyOps(project: Project, registry: PartRegistry, id: string): AdviceOp[] {
  const [code, part] = id.split(":");
  const p = project.parts.find((q) => q.id === part);
  if (!p || !code) return [];
  const touching = project.wires.filter((w) => w.from.part === p.id || w.to.part === p.id);
  const ends = (pin: string) => touching.flatMap((w) => (w.from.part === p.id && w.from.pin === pin ? [{ ref: w.to, color: w.color }] : w.to.part === p.id && w.to.pin === pin ? [{ ref: w.from, color: w.color }] : []));
  const ref = (r: { part: string; pin: string }) => `${r.part}.${r.pin}`;
  if (code === "smaller-speaker") {
    if (!registry.get("speaker-20mm")) return [];
    const ops: AdviceOp[] = [{ op: "remove", args: { id: p.id } }, { op: "place_part", args: { type: "speaker-20mm", id: p.id, x: p.x, y: p.y, ...(p.rotation ? { rotation: p.rotation } : {}) } }];
    for (const w of touching) {
      const mine = w.from.part === p.id ? w.from : w.to;
      const other = w.from.part === p.id ? w.to : w.from;
      if (other.part === p.id) continue;
      ops.push({ op: "connect", args: { from: ref(mine), to: ref(other), ...(w.color ? { color: w.color } : {}) } });
    }
    return ops;
  }
  if (code === "boost-not-needed") {
    // what fed the boost takes over its output; its output ground joins its input ground
    const inPlus = ends("VIN+").map((e) => e.ref);
    const inMinus = ends("VIN-").map((e) => e.ref);
    const feeder = inPlus.find((r) => project.parts.find((q) => q.id === r.part)?.type === "slide-switch") ?? inPlus[0];
    const ground = inMinus[0];
    if (!feeder) return [];
    const rest = { ...project, wires: project.wires.filter((w) => !touching.includes(w)) };
    const nets = buildNets(rest);
    const netOf = (r: { part: string; pin: string }) => nets.find((n) => n.pins.some((x) => pinKey(x) === pinKey(r)))?.id ?? pinKey(r);
    const ops: AdviceOp[] = [{ op: "remove", args: { id: p.id } }];
    const joined = new Set<string>();
    const join = (a: { part: string; pin: string }, b: { part: string; pin: string }, color?: string) => {
      const k = [netOf(a), netOf(b)].sort().join("|");
      if (netOf(a) === netOf(b) || joined.has(k)) return;
      joined.add(k);
      ops.push({ op: "connect", args: { from: ref(a), to: ref(b), ...(color ? { color } : {}) } });
    };
    for (const e of ends("VOUT+")) join(feeder, e.ref, e.color);
    if (ground) for (const e of ends("VOUT-")) join(ground, e.ref, e.color);
    else if (ends("VOUT-").length) return []; // no ground to join the output's to: not a simple change
    return ops;
  }
  return [];
}

/** The ops for a note that must exist and be appliable (the Apply button), or a clear error. */
export function opsForApply(project: Project, registry: PartRegistry, id: string): AdviceOp[] {
  const note = adviceNotes(project, registry).find((n) => n.id === id);
  if (!note) fail("unknown-advice", `Nothing to apply for '${id}'`, "the project changed and that advice no longer holds", "reload the Case view to see the current notes");
  if (!note.apply) fail("advice-not-simple", `'${note.title}' has no one-click change`, "it needs new parts wired to different pins, or the sketch changes", "ask the agent to make the change, or make it on the canvas");
  return applyOps(project, registry, id);
}
