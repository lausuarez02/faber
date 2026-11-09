import { buildNets, type PartInstance, type Project } from "@jumper/project-format";
import type { PartRegistry } from "@jumper/sim-core";

/**
 * BOM (markdown, with buy links) and wiring table for building the real device.
 *
 * Round 5 (decision 0003, C2/C4): a part placed as a stand-in (`standIn` on the instance, set with
 * mark_stand_in) is exported as the real part it stands for, with a loud STAND-IN note, and an
 * agent-made part (fidelity.origin "agent-made") says "agent-made: behavioral, unverified", so the
 * shopping list never presents a potentiometer as a soil sensor.
 */

export const AGENT_MADE_LABEL = "agent-made: behavioral, unverified";

function isAgentMade(registry: PartRegistry, type: string): boolean {
  return registry.get(type)?.fidelity.origin === "agent-made";
}

/** How a part instance is described to the person who builds it. */
export function partLabel(p: PartInstance, registry: PartRegistry): { name: string; note: string } {
  const spec = registry.get(p.type)?.spec;
  const simName = spec?.name ?? p.type;
  if (p.standIn) return { name: p.standIn, note: `STAND-IN: Jumper simulated it as a ${simName}; buy the real part and wire its matching pins (check its datasheet)` };
  if (!spec) return { name: p.type, note: "not in the catalog: not simulated" };
  if (isAgentMade(registry, p.type)) return { name: simName, note: `${AGENT_MADE_LABEL} (made by the agent from a description, check it against the real part's datasheet)` };
  return { name: simName, note: "" };
}

export function bomMarkdown(project: Project, registry: PartRegistry): string {
  const groups = new Map<string, { p: PartInstance; ids: string[]; props: string }>();
  for (const p of project.parts) {
    const props = Object.entries(p.props ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const k = `${p.type}|${props}|${p.standIn ?? ""}`;
    const g = groups.get(k) ?? { p, ids: [], props };
    g.ids.push(p.id);
    groups.set(k, g);
  }
  const lines = [`# Bill of materials: ${project.name}`, "", "| Qty | Part | Value / options | Ids | Buy | Note |", "| --- | --- | --- | --- | --- | --- |"];
  const standIns: string[] = [];
  const agentMade: string[] = [];
  for (const g of groups.values()) {
    const spec = registry.get(g.p.type)?.spec;
    const label = partLabel(g.p, registry);
    const links = g.p.standIn ? searchLinks(g.p.standIn) : (spec?.buy_links ?? []).map((l) => `[${l.vendor}](${l.url})`).join(", ") || searchLinks(spec?.name ?? g.p.type);
    const props = g.p.standIn ? "see the real part" : g.props || "–";
    lines.push(`| ${g.ids.length} | ${g.p.standIn ? `**${label.name}**` : label.name} | ${props} | ${g.ids.join(", ")} | ${links} | ${label.note || "–"} |`);
    if (g.p.standIn) standIns.push(`- **${g.ids.join(", ")}**: buy a ${g.p.standIn}. Jumper had no such part, so a ${spec?.name ?? g.p.type} stood in for it: the tests checked the firmware against the stand-in, not the real part.`);
    else if (isAgentMade(registry, g.p.type)) agentMade.push(`- **${g.ids.join(", ")}** (${spec?.name ?? g.p.type}): ${AGENT_MADE_LABEL}. Its pins and behaviour came from the agent's description; check them against the real part's datasheet before wiring.`);
  }
  const wires = project.wires.length;
  if (wires) lines.push(`| ${wires} | Jumper wires (dupont, male-male / male-female as needed) | – | – | ${searchLinks("dupont jumper wires")} | – |`);
  if (project.parts.some((p) => !registry.get(p.type)?.spec || registry.get(p.type)!.spec.category !== "board")) {
    lines.push(`| 1 | Half-size breadboard | 400 points | – | ${searchLinks("half size breadboard")} | – |`);
  }
  if (standIns.length) lines.push("", "## STAND-IN parts (not what you buy)", "", ...standIns);
  if (agentMade.length) lines.push("", "## Agent-made parts", "", ...agentMade);
  lines.push("", "Links are generic distributor searches unless the part lists its own. Check voltage (3.3 V vs 5 V) and I2C address variants before buying.");
  return lines.join("\n") + "\n";
}

function searchLinks(name: string): string {
  const q = encodeURIComponent(name);
  return `[DigiKey](https://www.digikey.com/en/products/result?keywords=${q}), [Adafruit](https://www.adafruit.com/search?q=${q})`;
}

export function wiringMarkdown(project: Project, registry: PartRegistry): string {
  const inst = new Map(project.parts.map((p) => [p.id, p]));
  const label = (part: string, pin: string) => {
    const p = inst.get(part);
    const spec = p ? registry.get(p.type)?.spec : undefined;
    const ps = spec?.pins.find((x) => x.id === pin);
    const base = ps && ps.label !== pin ? `${part}.${pin} (${ps.label})` : `${part}.${pin}`;
    return p?.standIn ? `${base} [STAND-IN for ${p.standIn}]` : base;
  };
  const lines = [`# Wiring: ${project.name}`, ""];
  const flagged = project.parts.filter((p) => p.standIn || isAgentMade(registry, p.type));
  if (flagged.length) {
    lines.push("## Parts to check before wiring", "", "| Id | Real part | Note |", "| --- | --- | --- |");
    for (const p of flagged) {
      const l = partLabel(p, registry);
      lines.push(`| ${p.id} | ${l.name} | ${l.note} |`);
    }
    lines.push("", "Pin names below are the simulated part's. For a STAND-IN, connect the real part's pins with the same job (supply, ground, signal).", "");
  }
  lines.push("| # | From | To | Colour |", "| --- | --- | --- | --- |");
  project.wires.forEach((w, i) => lines.push(`| ${i + 1} | ${label(w.from.part, w.from.pin)} | ${label(w.to.part, w.to.pin)} | ${w.color ?? "–"} |`));
  lines.push("", "## Nets (everything on one line is electrically connected)", "");
  for (const n of buildNets(project)) lines.push(`- ${n.pins.map((p) => label(p.part, p.pin)).join(" · ")}`);
  return lines.join("\n") + "\n";
}
