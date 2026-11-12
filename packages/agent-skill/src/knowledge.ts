/**
 * Jumper's hardware know-how, written ONCE. Every face an agent sees is rendered from this file:
 * the MCP server instructions (a short block appended to AGENT_LOOP), the MCP prompts and the
 * jumper://docs/hardware resource, the Claude Code skill a project gets
 * (<project>/.claude/skills/jumper-hardware/SKILL.md), the project's AGENTS.md (Codex and others)
 * and the plugin in plugins/jumper/. Nothing here is about one device: it is how to think about any
 * device a person wants to hold, buy parts for, print and put together.
 *
 * Tool names are written with tool("name") so a test can check each one exists. A step that needs a
 * tool another track may not have merged yet names it in `needs` and carries a fallback that only
 * uses tools that exist; the renderer picks one from the live tool list.
 */

/** Pocket and hand-held devices: the thickness to aim for (mm). One number for every face. */
export const POCKET_MAX_MM = 20;

/** Every tool name the knowledge mentions, collected as the text is built (for the sync test). */
export const MENTIONED_TOOLS = new Set<string>();

/** A tool reference in the text: `name`. */
export function tool(name: string): string {
  MENTIONED_TOOLS.add(name);
  return `\`${name}\``;
}

export interface Rule {
  id: string;
  /** The rule in plain words, for the skill, AGENTS.md and the guide. */
  text: string;
  /** Short form for the server instructions (omitted: the rule is only in the long guides). */
  short?: string;
  /**
   * What every face that carries the rule must say (the sync test checks the server instructions,
   * the skill and AGENTS.md against these, so they cannot drift apart or contradict each other).
   */
  mustSay: RegExp[];
  /** What no face may say (the contradiction of the rule). */
  mustNotSay?: RegExp[];
}

export const RULES: Rule[] = [
  {
    id: "pocket-thickness",
    text: `Pocket and hand-held devices (a keychain, a pet, a remote, an egg): aim for ${POCKET_MAX_MM} mm thick or less. Thickness is what makes a pocket device feel wrong; width and length matter less.`,
    short: `Pocket and hand-held devices: aim for ${POCKET_MAX_MM} mm thick or less.`,
    mustSay: [new RegExp(`${POCKET_MAX_MM} mm thick or less`)],
    mustNotSay: [/(?:aim for|keep it|target)\s+(?!20\b)\d+ mm thick/i],
  },
  {
    id: "smallest-parts",
    text: `Pick the smallest parts that do the job, then prove they fit: ${tool("check_fit")} (under a second, nothing written) says what misses by how many mm and which smaller parts would fit (a smaller cell, a smaller screen, a board on its edge). Tell the person the trade-off (a smaller cell means shorter battery life) and let them choose.`,
    short: `Smallest parts that fit: check_fit (the size the person wants, or the shape's own) then propose_layout, both before design_case, even when it looks like it fits; tell the person each trade-off.`,
    mustSay: [/check_fit/],
  },
  {
    id: "built-in-charger",
    text: `Battery devices: prefer a board with a built-in LiPo charger and USB-C: ${tool("search_parts")} {"query": "charger", "category": "board"} lists them first. One board instead of board + charger module is fewer wires, less room, one USB port and one fewer thing to assemble. If ${tool("plan_device")} picked a board without one, say so and offer the swap (the board's language and pins may change).`,
    short: 'Battery devices: prefer a board with a built-in charger (search_parts {"query": "charger", "category": "board"}); if plan_device picked one without, offer the swap.',
    mustSay: [/built-in (?:LiPo )?charger/],
  },
  {
    id: "no-pinning",
    text: `Do not pin positions (placements x_mm / y_mm / layer / face) unless the person asked for that spot: Jumper's layout is usually smaller. Pinned parts show up in costs with what they add.`,
    short: "Do not pin positions unless the person asked for that spot.",
    mustSay: [/do not pin/i],
    mustNotSay: [/always pin/i, /pin (?:every|each) part/i],
  },
  {
    id: "dome-auto",
    text: `Leave dome_mm and the edges on auto: each mm of dome is a mm of thickness on each face.`,
    short: "Leave dome_mm and the edges on auto.",
    mustSay: [/dome_mm`? and the edges on auto/],
    mustNotSay: [/"dome_mm":\s*\d/],
  },
  {
    id: "read-costs",
    text: `Read costs in every ${tool("check_fit")} / ${tool("propose_layout")} / ${tool("design_case")} / ${tool("update_case")} answer (what each of your choices adds, in mm and cm³, with the call that relaxes it) and relax the costly ones unless the person asked for them.`,
    short: "Read costs in every case answer and relax the costly choices.",
    mustSay: [/costs/],
  },
  {
    id: "layout-first",
    text: `Call ${tool("propose_layout")} before ${tool("design_case")}: it shows the thinnest, smallest and balanced ways to put the parts inside, with the reasons. Tell the person which one and why; layout: "<id>" picks it.`,
    short: "Call propose_layout before design_case.",
    mustSay: [/propose_layout`? before `?design_case/],
  },
  {
    id: "honest",
    text: `Be honest about what was not simulated: ${tool("fidelity_report")} and plan_device's cannot_check list it (real feel, sound, battery life, stand-ins). The print, the fit of real parts and the hand feel were not tested: say so, and say what to check on the first real unit.`,
    short: "Say honestly what was not simulated: the print, the real fit and the hand feel were not tested.",
    mustSay: [/not (?:simulated|tested)/],
    mustNotSay: [/fully (?:tested|verified) (?:print|case)/i],
  },
  {
    id: "no-keys-in-firmware",
    text: `Never put API keys, passwords or tokens in firmware or in jumper.json: ${tool("set_network")} takes secrets by NAME and the values live in the project's .env. Firmware that talks to a service gets its key at run time, never in the source.`,
    short: "Never put API keys in firmware: secrets by name (set_network), values in .env.",
    mustSay: [/[Nn]ever put API keys/],
    mustNotSay: [/(?:paste|put|hard-?code) (?:the|your) (?:API )?key (?:in|into) (?:the )?(?:firmware|sketch)/i],
  },
];

/** What to think through before the case exists: how every part goes inside (generic, any device). */
export const ASSEMBLY_CHECKLIST: { title: string; text: string }[] = [
  {
    title: "Where each part mounts",
    text: "For every part, say what holds it: the screen sits behind its window on ledges, the board on standoffs or in a pocket, the cell in its own pocket, the speaker against its grille, buttons under their plungers, a sensor at its window or air holes. A part nothing holds rattles or breaks a joint.",
  },
  {
    title: "Insertion order",
    text: "Write the order a person puts it together, front shell face down: window part (screen) first, then buttons / plungers / light pipes, then the board, then the wires, the battery last, then close. If a part cannot go in after the one before it, change the layout (layers) now, not after printing.",
  },
  {
    title: "Wire room",
    text: `Hand-wired devices need room for solder joints and bends (about 3 to 5 mm above pins, more where many wires meet) and a short service loop so the halves open without tearing a joint. Route wires away from the closing seam and screw bosses. Battery devices are built soldered: ${tool("set_assembly")} "soldered" so the pack has wire cuts and soldering steps.`,
  },
  {
    title: "Access from outside",
    text: "The USB-C port must reach its wall with room for the plug's body (charging and flashing), every button must line up with its plunger, a power switch must be reachable, and a screen must face its window. Boards that need BOOT / RESET to flash: flash before closing, or leave a pin hole.",
  },
  {
    title: "Battery safety",
    text: "Use a protected LiPo cell (with its protection circuit) on a connector so it can be unplugged, charged only by a charger (the board's built-in one or a charger module), with the switch after the charger. Nothing presses on the cell: no screw, boss or sharp edge over it, a little room for swelling, and keep it away from the regulator's heat. Never solder onto the cell's tabs.",
  },
  {
    title: "Closing and opening",
    text: "Choose how the halves close (snap clips or screws; the case answer says which and where) and whether the person must open it again (a cell that is not charged over USB, an SD card). Heavy parts low, the cell flat.",
  },
  {
    title: "Printing it",
    text: "Each body is written in its print orientation with PRINT.md (material, layer height, supports, tolerances). Suggest a test print of the front half first to check the screen and buttons with the real parts; tolerances differ per printer.",
  },
];

export interface LoopStep {
  title: string;
  /** Tools this step needs; when one is missing the fallback text is used instead. */
  needs?: string[];
  text: () => string;
  fallback?: () => string;
}

export const LOOP: LoopStep[] = [
  {
    title: "Goal",
    text: () => `Say back what the device does in one sentence in the person's words. If the wish is ambiguous (or they changed their mind mid-sentence: take the last version), ask ONE question and wait.`,
  },
  {
    title: "Plan",
    text: () => `${tool("plan_device")} {goal, constraints} first (pocket: true for anything carried), then tell the person the plan in plain words: what it does, the board and parts and why, size, battery life, price, and what is simulated. One project per idea: ${tool("new_project")} {"folder": true, "name": …}.`,
  },
  {
    title: "Smallest parts that fit",
    text: () => `Choose the smallest parts that do the job (${tool("search_parts")}, ${tool("get_part")}), place and wire them (${tool("place_part")}, ${tool("connect")}), ${tool("check_design")} until it is clean. Before any case: ${tool("check_fit")} with the shape and size the person wants, then ${tool("propose_layout")}; read costs and relax what is costly.`,
  },
  {
    title: "Think assembly",
    needs: ["get_assembly_plan"],
    text: () => `Think how it goes together before the case exists: ${tool("get_assembly_plan")} gives what mounts where, the insertion order, the wire room and the access checks; read it, fix what it flags (change the layout or a part), and tell the person the order in a few steps.`,
    fallback: () => `Think how it goes together before the case exists, using propose_layout's placements and layers: what mounts where, the insertion order, the wire room, access to USB / buttons / switch, battery safety (the checklist below). If a part cannot go in, change the layout or the part now.`,
  },
  {
    title: "Design the case",
    text: () => `${tool("design_case")} with the chosen layout (any shape: a preset or "custom" with an outline you draw), show the renders and the measured size and checks (pocket verdict, screen window, button travel, USB access). ${tool("update_case")} to change it.`,
  },
  {
    title: "Firmware and tests",
    text: () => `${tool("write_file")} the firmware, ${tool("run")} it, ${tool("write_scenario")} for each behaviour of the goal and ${tool("run_tests")} until they pass; ${tool("fidelity_report")} for what the simulation cannot check.`,
  },
  {
    title: "The build kit",
    needs: ["get_build_kit"],
    text: () => `${tool("get_build_kit")}: everything to buy, print, assemble and flash, with totals; ${tool("export_manufacturing")} when the person wants the files for a supplier or a printer.`,
    fallback: () => `${tool("export_manufacturing")} writes the build pack (BOM with prices, case files and PRINT.md, wiring and wire cuts, ASSEMBLY.md, firmware and FLASHING.md); read its parts with ${tool("read_file")} and summarise (see "What do I need to build it?").`,
  },
];

/** How to answer "what do I need to build it / buy / print / how do I put it together". */
export const BUILD_KIT_ANSWER: LoopStep = {
  title: "What do I need to build it?",
  needs: ["get_build_kit"],
  text: () => `Call ${tool("get_build_kit")} (after ${tool("design_case")}; it says what is missing when there is no case yet) and answer in four short parts, with totals:`,
  fallback: () =>
    `There is no single build-kit tool in this Jumper yet. Make sure there is a case (${tool("get_case")}; if none, ${tool("check_fit")} → ${tool("propose_layout")} → ${tool("design_case")}), set ${tool("set_assembly")} "soldered" for a battery device, then ${tool("export_manufacturing")}. Its answer lists the files: ${tool("read_file")} the pack's BOM.md, enclosure/PRINT.md (or case/PRINT.md), assembly/ASSEMBLY.md and firmware/FLASHING.md (paths relative to the project, e.g. "manufacturing/<pack>/BOM.md"), and answer in four short parts, with totals:`,
};

export const BUILD_KIT_PARTS: { title: string; text: string }[] = [
  { title: "Buy", text: "each part with quantity, price and where, plus wire, heat-shrink and screws; the total price. Name the real part when a stand-in was simulated." },
  { title: "Print", text: "each printed body (front, back, plungers, light pipes) with the material, layer height and supports from PRINT.md, and print time or grams when given; where the STL / 3MF files are." },
  { title: "Assemble", text: "the numbered steps in insertion order (power path first when soldered), the tools needed (soldering iron, wire strippers, screwdriver) and the checks before closing." },
  { title: "Flash", text: "how the firmware gets on the board (the file and one line on how), and the quick test once it is closed." },
];

export const PROMPTS = [
  {
    name: "design-device",
    title: "Design a device",
    description: "Design a real device from a wish: plan, smallest parts that fit, how it goes together, the case, tests and what to buy and print.",
    arguments: [{ name: "goal", description: 'What the device should do, in the person\'s words (e.g. "a keychain with a little screen that shows a smiley").', required: true }],
  },
  {
    name: "build-kit",
    title: "What do I need to build it?",
    description: "Everything to buy, print, assemble and flash for the open project, with totals.",
    arguments: [],
  },
  {
    name: "design-for-assembly",
    title: "Think how it goes together",
    description: "Walk through how every part of the open project mounts, the insertion order, wire room, access and battery safety, and fix the layout before printing.",
    arguments: [],
  },
] as const;

export type PromptName = (typeof PROMPTS)[number]["name"];
