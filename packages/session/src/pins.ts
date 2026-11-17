import type { PartInstance, PinRef, Project } from "@faber/project-format";
import type { PartRegistry, PartSpec, PinSpec } from "@faber/sim-core";
import { didYouMean, fail } from "./errors.ts";

/** Split "uno.D13" / "uno:D13" into part and pin. The part id never contains a dot; the pin may ("uno.GND.1"). */
export function splitRef(ref: string, what = "pin reference"): { part: string; rest: string } {
  if (typeof ref !== "string" || !ref.trim()) {
    fail("bad-ref", `Invalid ${what}`, `got ${JSON.stringify(ref)}`, `write it as "part.pin", e.g. "uno.D13" or "led1.A"`);
  }
  const s = ref.trim();
  const m = s.match(/^([A-Za-z][A-Za-z0-9_-]*)[.:](.+)$/);
  if (!m) fail("bad-ref", `Invalid ${what} '${s}'`, "it has no part id before a '.'", `write it as "part.pin", e.g. "uno.D13" or "led1.A"`);
  return { part: m[1]!, rest: m[2]! };
}

export function findPart(project: Project, id: string): PartInstance {
  if (typeof id !== "string" || !id) {
    const ids = project.parts.map((x) => x.id);
    fail("missing-arg", "No part id was given", "the tool takes the part's id in 'id' (a name like 'part' or a number is not read)", `pass {"id": "${ids[0] ?? "led1"}", …}${ids.length ? `; the parts are: ${ids.join(", ")}` : ""}`);
  }
  const p = project.parts.find((x) => x.id === id);
  if (!p) {
    const ids = project.parts.map((x) => x.id);
    fail(
      "unknown-part",
      `No part '${id}' in the project`,
      ids.length ? `the parts are: ${ids.join(", ")}` : "the project has no parts yet",
      `use one of the ids above (get_project lists them), or place it first with place_part.${didYouMean(id, ids)}`,
    );
  }
  return p;
}

export function specOf(registry: PartRegistry, part: PartInstance): PartSpec {
  const def = registry.get(part.type);
  if (!def) {
    fail("unknown-part-type", `Part '${part.id}' has type '${part.type}'`, "that type is not in the parts catalog", "remove it and place a type from search_parts");
  }
  return def.spec;
}

const GROUND_ALIASES = new Set(["gnd", "ground", "-", "0v", "vss"]);
const POWER_ALIASES: Record<string, string[]> = {
  vcc: ["VCC", "5V", "VIN", "V+", "+", "VDD", "3V3"],
  "5v": ["5V", "VCC", "VBUS"],
  "3.3v": ["3V3"],
  "3v3": ["3V3"],
  vdd: ["VDD", "VCC"],
  "+": ["+", "VCC", "POS"],
};

/**
 * Resolve a pin name on a part spec, forgivingly but never ambiguously:
 * exact id → case-insensitive id → label → aliases ("GND" → the first free ground pin, "13" → "D13" on boards).
 * `used` = pin ids already wired on this part (to pick a free GND).
 */
export function resolvePin(partId: string, spec: PartSpec, name: string, used: ReadonlySet<string> = new Set()): PinSpec {
  const pins = spec.pins;
  const exact = pins.find((p) => p.id === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const ci = pins.filter((p) => p.id.toLowerCase() === lower);
  if (ci.length === 1) return ci[0]!;
  if (GROUND_ALIASES.has(lower)) {
    const grounds = pins.filter((p) => p.type === "ground");
    if (grounds.length) return grounds.find((p) => !used.has(p.id)) ?? grounds[0]!;
  }
  if (spec.category === "board" && /^\d+$/.test(name)) {
    const d = pins.find((p) => p.id === `D${name}`) ?? pins.find((p) => p.id === `GP${name}`);
    if (d) return d;
  }
  // RP2040 boards: "GPIO25" → GP25.
  const gpio = /^gpio(\d+)$/.exec(lower);
  if (spec.category === "board" && gpio) {
    const d = pins.find((p) => p.id === `GP${gpio[1]}`);
    if (d) return d;
  }
  const byLabel = pins.filter((p) => p.label.toLowerCase() === lower && p.type !== "ground");
  if (byLabel.length === 1) return byLabel[0]!;
  // Silkscreen with several names ("D0/A0", "D4/SDA" on a XIAO): any one of them.
  const byLabelPart = pins.filter((p) => p.type !== "ground" && p.label.includes("/") && p.label.toLowerCase().split("/").includes(lower));
  if (byLabelPart.length === 1) return byLabelPart[0]!;
  for (const alias of POWER_ALIASES[lower] ?? []) {
    const p = pins.find((x) => x.id === alias);
    if (p) return p;
  }
  const ids = pins.map((p) => p.id);
  fail(
    "unknown-pin",
    `Part '${partId}' (${spec.id}) has no pin '${name}'`,
    `its pins are: ${ids.join(", ")}`,
    `use one of those ids, e.g. "${partId}.${ids[0]}" (get_part ${spec.id} explains each pin).${didYouMean(name, ids)}`,
  );
}

/** Parse + resolve "part.pin" against the project. */
export function resolveRef(project: Project, registry: PartRegistry, ref: string): { ref: PinRef; spec: PartSpec; pin: PinSpec } {
  const { part, rest } = splitRef(ref);
  const inst = findPart(project, part);
  const spec = specOf(registry, inst);
  const used = new Set<string>();
  for (const w of project.wires) for (const end of [w.from, w.to]) if (end.part === part) used.add(end.pin);
  const pin = resolvePin(part, spec, rest, used);
  return { ref: { part, pin: pin.id }, spec, pin };
}

export function fmtRef(r: PinRef): string {
  return `${r.part}.${r.pin}`;
}
