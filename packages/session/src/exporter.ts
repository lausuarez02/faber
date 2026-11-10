import { buildNets, type PartInstance, type Project } from "@jumper/project-format";
import { AGENT_MADE_LABEL } from "@jumper/parts";
import type { PartRegistry } from "@jumper/sim-core";
import { assemblyReason, assemblyStyle, wireTotals, type AssemblyStyle, type WireCut } from "./assembly.ts";

/**
 * BOM (markdown, with buy links) and wiring table for building the real device.
 *
 * Round 5 (decision 0003, C2/C4): a part placed as a stand-in (`standIn` on the instance, set with
 * mark_stand_in) is exported as the real part it stands for, with a loud STAND-IN note, and an
 * agent-made part (fidelity.origin "agent-made") says "agent-made: behavioral, unverified", so the
 * shopping list never presents a potentiometer as a soil sensor.
 */

export { AGENT_MADE_LABEL };

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

export function bomMarkdown(project: Project, registry: PartRegistry, style: AssemblyStyle = assemblyStyle(project, registry), cuts: WireCut[] = []): string {
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
    const made = !g.p.standIn && isAgentMade(registry, g.p.type);
    const name = g.p.standIn ? `**${label.name}**` : made ? `${label.name} (${AGENT_MADE_LABEL})` : label.name;
    const note = made ? "made by the agent from a description; check it against the real part's datasheet" : label.note;
    lines.push(`| ${g.ids.length} | ${name} | ${props} | ${g.ids.join(", ")} | ${links} | ${note || "–"} |`);
    if (g.p.standIn) standIns.push(`- **${g.ids.join(", ")}**: buy a ${g.p.standIn}. Jumper had no such part, so a ${spec?.name ?? g.p.type} stood in for it: the tests checked the firmware against the stand-in, not the real part.`);
    else if (isAgentMade(registry, g.p.type)) agentMade.push(`- **${g.ids.join(", ")}** (${spec?.name ?? g.p.type}): ${AGENT_MADE_LABEL}. Its pins and behaviour came from the agent's description; check them against the real part's datasheet before wiring.`);
  }
  const wires = project.wires.length;
  if (style === "soldered") {
    // round 6 power: hand-wired in a case: cut wire per gauge (WIRE-CUTS.csv), no breadboard, no dupont.
    for (const t of wireTotals(cuts)) lines.push(`| ${(t.total_mm / 1000).toFixed(1)} m | Stranded silicone hook-up wire, ${t.gauge_awg} AWG (${t.gauge_awg <= 24 ? "power and ground" : "signals"}) | ${t.count} pieces, see WIRE-CUTS.csv | – | ${searchLinks(`${t.gauge_awg} AWG silicone wire`)} | lengths include 20 % spare |`);
    if (wires) {
      lines.push(`| 1 | Heat-shrink tubing assortment (1.5 to 3 mm) | – | – | ${searchLinks("heat shrink tubing assortment")} | one piece over every soldered joint that could touch another |`);
      lines.push(`| 1 | Rosin-core solder, 0.5 to 0.8 mm | – | – | ${searchLinks("rosin core solder 0.6mm")} | – |`);
    }
  } else {
    if (wires) lines.push(`| ${wires} | Jumper wires (dupont, male-male / male-female as needed) | – | – | ${searchLinks("dupont jumper wires")} | – |`);
    if (project.parts.some((p) => !registry.get(p.type)?.spec || registry.get(p.type)!.spec.category !== "board")) {
      lines.push(`| 1 | Half-size breadboard | 400 points | – | ${searchLinks("half size breadboard")} | – |`);
    }
  }
  if (standIns.length) lines.push("", "## STAND-IN parts (not what you buy)", "", ...standIns);
  if (agentMade.length) lines.push("", "## Agent-made parts", "", ...agentMade);
  lines.push("", `Assembly: ${style} (${assemblyReason(project, registry)}).`);
  lines.push("", "Links are generic distributor searches unless the part lists its own. Check voltage (3.3 V vs 5 V) and I2C address variants before buying.");
  return lines.join("\n") + "\n";
}

/** True for nets / wires that carry the supply (the order a soldered build wires them in). */
function isPowerWire(c: WireCut): boolean {
  return c.gauge_awg <= 24;
}

/**
 * ASSEMBLY.md for a soldered build (round 6 power): numbered steps, power path first and tested
 * before any module is connected, then signals, then insulation, flashing and the hardware tests.
 */
export function solderedAssemblyMarkdown(project: Project, registry: PartRegistry, cuts: WireCut[], estimated: boolean): string {
  const inst = new Map(project.parts.map((p) => [p.id, p]));
  const name = (id: string) => registry.get(inst.get(id)?.type ?? "")?.spec.name ?? id;
  const power = cuts.filter(isPowerWire);
  const signal = cuts.filter((c) => !isPowerWire(c));
  const battery = project.parts.find((p) => p.type === "lipo-battery" || p.type === "battery-pack");
  const diode = project.parts.find((p) => p.type === "schottky-diode" || p.type === "generic-diode");
  const board = project.parts.find((p) => p.id === project.firmware?.board);
  const line = (c: WireCut) => `   - ${c.wire}: ${c.from} → ${c.to}, ${c.color}, ${c.length_mm} mm, ${c.gauge_awg} AWG`;
  const steps: string[] = [];
  steps.push(`Cut and strip every wire in WIRE-CUTS.csv (${cuts.length} wires; 5 mm stripped at each end, then tinned). ${estimated ? "The lengths are estimated from the part sizes: lay the parts in the case first and trim them shorter if they fit tighter." : "The lengths come from the case layout."}`);
  if (battery) steps.push(`Leave ${battery.id} (${name(battery.id)}) unplugged until step ${power.length ? 4 : 3}. Never let its two wires touch.`);
  if (power.length) {
    steps.push(`Solder the power and ground wires first (24 AWG):\n${power.map(line).join("\n")}${diode ? `\n   ${diode.id} (${name(diode.id)}): the end with the stripe (C) goes towards ${board?.id ?? "the board"}. Slide heat-shrink over it.` : ""}`);
    steps.push(`Test the power path before anything else is connected to it: plug ${battery?.id ?? "the battery"} in, switch on and measure ${board ? `${board.id}'s supply pin` : "the board's supply pin"} with a multimeter (a 1S LiPo through a Schottky diode reads about 3.4 to 3.9 V). Switch off again.`);
  }
  if (signal.length) steps.push(`Solder the signal wires (26 AWG):\n${signal.map(line).join("\n")}`);
  steps.push("Insulate every joint that could touch another (heat-shrink), and check with a multimeter that the supply and GND are not shorted (more than a few hundred Ω between them with the switch off).");
  if (board) steps.push(`Flash the firmware: ${registry.get(board.type)?.spec.mcu?.backend === "rp2040js" ? "hold BOOT while plugging the board into USB, then copy firmware.uf2 to the drive that appears" : "upload firmware.hex with avrdude or arduino-cli"} (see the export's flash line).`);
  steps.push("Switch on and go through TEST-ON-HARDWARE.md.");
  return [`# Assembly (soldered): ${project.name}`, "", "Hand-wired point to point (or on perfboard), no breadboard. Pin names are the ones on the parts' silkscreen as in WIRING.md.", "", ...steps.map((t, i) => `${i + 1}. ${t}`), ""].join("\n");
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
