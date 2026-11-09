import type { Project } from "@jumper/project-format";
import type { FidelityArea, PartRegistry } from "@jumper/sim-core";

const AREAS = ["logic", "timing", "analog", "power", "radio"] as const;
type Area = (typeof AREAS)[number];
const RANK: Record<FidelityArea["level"], number> = { ok: 0, approx: 1, none: 2, "n/a": -1 };
const ICON: Record<FidelityArea["level"], string> = { ok: "ok", approx: "approx", none: "not simulated", "n/a": "n/a" };

export interface FidelityReport {
  /** One line a person can read: how far to trust this simulation. */
  summary: string;
  parts: { id: string; type: string; level: string; weakest: string[] }[];
  areas: Record<Area, { level: FidelityArea["level"]; parts: string[]; notes: string[] }>;
  testOnRealDevice: string[];
  /** Things the project-level simulator does not do at all, whatever the parts. */
  global: string[];
}

export function fidelityReport(project: Project, registry: PartRegistry, faultsTested: string[] = []): FidelityReport {
  const areas = Object.fromEntries(AREAS.map((a) => [a, { level: "n/a" as FidelityArea["level"], parts: [] as string[], notes: [] as string[] }])) as FidelityReport["areas"];
  const parts: FidelityReport["parts"] = [];
  const toTest: string[] = [];
  const seenTypes = new Set<string>();
  for (const p of project.parts) {
    const def = registry.get(p.type);
    if (!def) {
      parts.push({ id: p.id, type: p.type, level: "not simulated (unknown type)", weakest: [] });
      continue;
    }
    const f = def.fidelity;
    const weakest: string[] = [];
    for (const a of AREAS) {
      const area = f.areas[a];
      if (area.level === "n/a") continue;
      const agg = areas[a];
      if (RANK[area.level] > RANK[agg.level]) agg.level = area.level;
      if (area.level !== "ok") {
        weakest.push(`${a}: ${ICON[area.level]}`);
        agg.parts.push(p.id);
        if (!seenTypes.has(p.type)) agg.notes.push(`${p.type}: ${area.note}`);
      }
    }
    parts.push({ id: p.id, type: p.type, level: f.level, weakest });
    if (!seenTypes.has(p.type)) for (const t of f.testOnRealDevice) toTest.push(`${p.id} (${p.type}): ${t}`);
    seenTypes.add(p.type);
  }
  const global = [
    "Time is virtual and deterministic: real oscillators drift and real sensors are noisy (use inject_fault noisy to rehearse).",
    "All grounds are one node and wires have no resistance or inductance; long wires, motor noise and ground bounce are not modelled.",
    "Supply rails are ideal: brownouts when motors start are not simulated; measure the real supply under load.",
  ];
  if (!faultsTested.length) toTest.push("Unplug each module while running to see how the firmware copes (or rehearse with inject_fault disconnect / i2c_nack).");
  const worst = AREAS.filter((a) => areas[a].level === "none" || areas[a].level === "approx");
  const summary =
    parts.length === 0
      ? "Empty project: nothing to rate yet."
      : `${parts.filter((p) => p.level === "exact").length} exact, ${parts.filter((p) => p.level === "behavioral").length} behavioral, ${parts.filter((p) => p.level === "stub").length} stub parts. ` +
        `Logic is ${ICON[areas.logic.level]}; ${worst.length ? `approximate or missing: ${worst.join(", ")}` : "no approximate areas"}. Check the ${toTest.length} items in testOnRealDevice on hardware before trusting it.`;
  return { summary, parts, areas, testOnRealDevice: toTest, global };
}
