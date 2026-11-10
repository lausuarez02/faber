import { buildNets, type Project } from "@jumper/project-format";
import { AGENT_MADE_LABEL } from "@jumper/parts";
import type { PartRegistry } from "@jumper/sim-core";

/** BOM (markdown, with buy links) and wiring table for building the real device. */

export function bomMarkdown(project: Project, registry: PartRegistry): string {
  const groups = new Map<string, { type: string; ids: string[]; props: string }>();
  for (const p of project.parts) {
    const props = Object.entries(p.props ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const k = `${p.type}|${props}`;
    const g = groups.get(k) ?? { type: p.type, ids: [], props };
    g.ids.push(p.id);
    groups.set(k, g);
  }
  const lines = [`# Bill of materials: ${project.name}`, "", "| Qty | Part | Value / options | Ids | Buy |", "| --- | --- | --- | --- | --- |"];
  for (const g of groups.values()) {
    const spec = registry.get(g.type)?.spec;
    const links = (spec?.buy_links ?? []).map((l) => `[${l.vendor}](${l.url})`).join(", ") || searchLinks(spec?.name ?? g.type);
    const agentMade = registry.get(g.type)?.fidelity.origin === "agent-made" ? ` (${AGENT_MADE_LABEL})` : ""; // agentparts, C4
    lines.push(`| ${g.ids.length} | ${spec?.name ?? g.type}${agentMade} | ${g.props || "–"} | ${g.ids.join(", ")} | ${links} |`);
  }
  const wires = project.wires.length;
  if (wires) lines.push(`| ${wires} | Jumper wires (dupont, male-male / male-female as needed) | – | – | ${searchLinks("dupont jumper wires")} |`);
  if (project.parts.some((p) => !registry.get(p.type)?.spec || registry.get(p.type)!.spec.category !== "board")) {
    lines.push(`| 1 | Half-size breadboard | 400 points | – | ${searchLinks("half size breadboard")} |`);
  }
  lines.push("", "Links are generic distributor searches unless the part lists its own. Check voltage (3.3 V vs 5 V) and I2C address variants before buying.");
  if (project.parts.some((p) => registry.get(p.type)?.fidelity.origin === "agent-made")) lines.push("", `Parts marked ${AGENT_MADE_LABEL} were described by an AI agent for this project; their pinout and behaviour were not checked against the real module. Compare with the seller's pinout before wiring.`);
  return lines.join("\n") + "\n";
}

function searchLinks(name: string): string {
  const q = encodeURIComponent(name);
  return `[DigiKey](https://www.digikey.com/en/products/result?keywords=${q}), [Adafruit](https://www.adafruit.com/search?q=${q})`;
}

export function wiringMarkdown(project: Project, registry: PartRegistry): string {
  const label = (part: string, pin: string) => {
    const inst = project.parts.find((p) => p.id === part);
    const spec = inst ? registry.get(inst.type)?.spec : undefined;
    const ps = spec?.pins.find((x) => x.id === pin);
    return ps && ps.label !== pin ? `${part}.${pin} (${ps.label})` : `${part}.${pin}`;
  };
  const lines = [`# Wiring: ${project.name}`, "", "| # | From | To | Colour |", "| --- | --- | --- | --- |"];
  project.wires.forEach((w, i) => lines.push(`| ${i + 1} | ${label(w.from.part, w.from.pin)} | ${label(w.to.part, w.to.pin)} | ${w.color ?? "–"} |`));
  const made = project.parts.filter((p) => registry.get(p.type)?.fidelity.origin === "agent-made").map((p) => `${p.id} (${p.type})`); // agentparts, C4
  if (made.length) lines.push("", `Note: ${made.join(", ")} ${made.length > 1 ? "are" : "is"} ${AGENT_MADE_LABEL}: the pin names come from an AI agent's description, so check them against the real module before wiring.`);
  lines.push("", "## Nets (everything on one line is electrically connected)", "");
  for (const n of buildNets(project)) lines.push(`- ${n.pins.map((p) => label(p.part, p.pin)).join(" · ")}`);
  return lines.join("\n") + "\n";
}
