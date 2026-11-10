import type { PartCategory, PartDefinition } from "@jumper/sim-core";
import { partDefinitions, registry } from "./registry.gen.ts";

export { partDefinitions, registry };
export { LED_COLORS, ledBrightness, type LedColor } from "./lib/led.ts";
export { resistorBands, formatOhms } from "./lib/resistorBands.ts";
export { ldrResistance } from "./parts/photoresistor/model.ts";

/** id → definition ({ spec, fidelity, svg, create }). */
export const parts: Readonly<Record<string, PartDefinition>> = Object.freeze(
  Object.fromEntries(partDefinitions.map((d) => [d.spec.id, d])),
);

/** Every part, sorted by id; optionally only one category. */
export function listParts(category?: PartCategory): PartDefinition[] {
  const all = registry.list();
  return category ? all.filter((d) => d.spec.category === category) : all;
}

/** One part by type id, or undefined. */
export function getPart(id: string): PartDefinition | undefined {
  return registry.get(id);
}

/**
 * Case-insensitive search over id, name, category, tags and description. Every whitespace-separated
 * term must match somewhere. Ranked: exact id > id/name prefix > name/tag > description. Empty
 * query returns everything.
 */
export function searchParts(query: string): PartDefinition[] {
  return rankParts(registry.list(), query);
}

// Agent-made parts (decision 0003, C4).
export * from "./custom/index.ts";

/** Rank `defs` against a query with the same rules as searchParts (for registries with project parts). */
export function rankParts(defs: readonly PartDefinition[], query: string): PartDefinition[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...defs];
  const scored: { d: PartDefinition; score: number }[] = [];
  for (const d of defs) {
    const s = d.spec;
    const id = s.id.toLowerCase();
    const name = s.name.toLowerCase();
    const tags = (s.tags ?? []).map((t) => t.toLowerCase());
    const desc = s.description.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of terms) {
      let best = 0;
      if (id === t) best = 100;
      else if (id.startsWith(t) || name.startsWith(t)) best = 50;
      else if (id.includes(t) || name.includes(t)) best = 30;
      else if (tags.some((x) => x.startsWith(t)) || s.category === t) best = 20;
      else if (desc.includes(t) || tags.some((x) => x.includes(t))) best = 5;
      if (!best) {
        all = false;
        break;
      }
      score += best;
    }
    if (all) scored.push({ d, score });
  }
  return scored.sort((a, b) => b.score - a.score || (a.d.spec.id < b.d.spec.id ? -1 : 1)).map((x) => x.d);
}
export { boardWiring, descriptionForBoard, type BoardWiring, type WiringLine } from "./wiring.ts"; // round 6 canvas
