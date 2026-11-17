/**
 * Fabwright's hardware know-how, written ONCE. Every face an agent sees is rendered from this file:
 * the MCP server instructions (a short block appended to AGENT_LOOP), the MCP prompts and the
 * fabwright://docs/hardware resource, the Claude Code skill a project gets
 * (<project>/.claude/skills/fabwright-hardware/SKILL.md), the project's AGENTS.md (Codex and others)
 * and the plugin in plugins/fabwright/. Nothing here is about one device: it is how to think about any
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
    text: `Do not pin positions (placements x_mm / y_mm / layer / face) unless the person asked for that spot: Fabwright's layout is usually smaller. Pinned parts show up in costs with what they add.`,
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
    text: `Never put API keys, passwords or tokens in firmware or in fabwright.json: ${tool("set_network")} takes secrets by NAME and the values live in the project's .env. Firmware that talks to a service calls it at its real host through the relay (FabwrightRelay.h, fabwrightRelayUrl): the relay is generated from fabwright.json and holds the keys, so there is no backend of your own to invent.`,
    short: "Never put API keys in firmware: secrets by name (set_network), values in .env.",
    mustSay: [/[Nn]ever put API keys/],
    mustNotSay: [/(?:paste|put|hard-?code) (?:the|your) (?:API )?key (?:in|into) (?:the )?(?:firmware|sketch)/i],
  },
  {
    id: "test-behaviour-over-time",
    text: `Test behaviour that happens over time, at random or offline as scenarios, not by hand: each test seeds the board's random numbers from its id (esp_random / random() repeat; ${tool("write_scenario")} "seed" tries another sequence, ${tool("run")} {"seed"} live), so "at a random moment" is repeatable. Check order and timing with "preceded_by" ({"expect_capture": "cam", "preceded_by": {"said": "picture in 10", "min_ms": 9000, "max_ms": 11000}}); "said" also matches the text firmware sends to a speech API; check uploads by what they carry ({"request": {"host", "method", "path", "content_type", "body_json"}}); go offline and back with {"network_fault": {"kind": "wifi_drop"}} / "clear", and reboot with {"reset_board": true} (flash files survive) to prove "it posts later". Mock any API from its OpenAPI file (${tool("add_mock_api")} {"kind": "openapi", "spec": "network/api.yaml"}): requests that do not fit the spec get 400 with why. A service you run on this computer is reachable only when its host opts in (${tool("set_network")} allow {"host", "local": true, "to": "http://127.0.0.1:<port>"}).`,
    short: "Test random / timed / offline behaviour with scenarios: seeded per test, preceded_by for timing, wifi_drop + reset_board for offline queues, OpenAPI mocks.",
    mustSay: [/preceded_by/],
  },
  {
    id: "camera-privacy",
    text: `A device with a camera shows when it is about to take, and is taking, a picture: an LED or the screen while it captures (check_design camera-indicator warns otherwise), ideally a spoken or on-screen countdown first with a way to cancel it, and photos kept on the device until their owner chooses to share them (review before publishing, no location data). Say this to the person when you design one; a camera must never be concealed.`,
    short: "Cameras: a visible capture indicator, a countdown with cancel, owner review before anything is published.",
    mustSay: [/capture indicator|camera-indicator/],
    mustNotSay: [/(?:make|build|design) a hidden camera/i],
  },
  {
    id: "battery-target",
    text: `For a battery device, ask (or assume and say) how long it should run, then ${tool("estimate_power")}: battery life from each load's datasheet current and duty cycle (camera always on vs per picture, Wi-Fi connected vs bursts, the speaker, sleep). Save the target and the real pattern with ${tool("set_power")} {"target_hours", "duty"}; check_design then warns (battery-life) under the target with the cell that would make it. It is an estimate: say so.`,
    short: "Battery devices: estimate_power with the real duty cycles, set_power target_hours, and say it is an estimate.",
    mustSay: [/estimate_power/],
  },
  {
    id: "held-object",
    text: `When the case holds something that is not electronics (a tin of pouches or mints, a lip balm, a lighter, a card deck), declare it on the case, never as a fake part: ${tool("design_case")} / ${tool("check_fit")} {"held": [{"id", "name", "shape": "cylinder" | "box" | "custom", "size_mm", "clearance_mm", "insert": "slide" | "pocket" | "snap", "from", "removable", "source", "sensor": {"part"}}]}. Find its real size from more than one source (the maker's page, measurements people posted) and say where it came from in "source"; tell the person to measure their own with calipers (the report's held[].measure and the build kit's "What it holds" say how) and that clearance_mm is the knob if it is tight or loose. The case keeps every part and wire out of its room, cuts its opening and checks the walls round it (held-object) and that a lid sensor sits close enough (held-sensor). Depths through the front / back count from the case's OUTER face: the report's held[].depth_mm and proud_mm say how deep it sits and how far it stands out. When the case rides ON the object (a puck on a can's lid, a dock, a cap) only part of it goes in: a socket, "engage_mm" (how deep, from the outer face) with "fit": "slip" | "press" | "snap", and the case outline can follow the object with "follow": {"held": "<id>", "margin_mm"} (a round puck the can's size). A magnet glued on the object, outside the case, is "magnet": {"beyond_mm", "angle_deg"}: held-sensor then gives the gap mounted and lifted off (sensor.lift_mm) and the magnet_mm values to drive the switch in a test.`,
    short: "A thing the case holds (a tin, a card deck): enclosure held with its real size and source, never a fake part; a case that rides on it: engage_mm (a socket), fit, follow; tell the person to measure theirs with calipers.",
    mustSay: [/calipers/],
    mustNotSay: [/create_part .* (?:tin|can|deck)/i],
  },
  {
    id: "low-power-always-on",
    text: `A device that shows something all day on a small battery: an e-paper screen (epaper-154-ssd1681: the image stays with no power; refresh about 2 s full, 0.5 s partial, ghosts unless the previous image is kept) or a Sharp memory LCD (sharp-memory-lcd-128: a microamp for a still image, VCOM toggled each second), never a TFT / OLED that must stay lit. The board deep-sleeps between events (esp_deep_sleep_start with a timer and a GPIO wake-up from a reed / Hall switch or a button): the simulation runs no firmware while it sleeps, so a test step can let hours pass in seconds, and RTC_DATA_ATTR variables, the clock and esp_sleep_get_wakeup_cause() survive like on the chip. Day counters: an RTC part (a scenario's "clock" and its clock steps set it too, so a test crosses midnight) or NTP; for a battery device pick a small one without a power LED: ds3231-mini-rtc (same RTClib code, 14 x 14 mm, 0.11 mA) or rv3028-rtc (19 x 19 x 4 mm, 45 nA), not the ZS-042 ds3231-rtc, whose LED draws about 2 mA (desolder it and its charging diode, prop powerLed false, if you keep it). Thin cells: 401730 / 402030 are 4 mm, 502030 / 503035 5 mm. Then ${tool("estimate_power")} with power.wakes_per_day and awake_s (or after a run: the measured wake pattern) for battery life in days; say it is an estimate.`,
    short: "Always-on battery devices: e-paper or memory LCD, deep sleep with timer + pin wake (tests jump hours), a small RTC without a power LED (ds3231-mini-rtc, rv3028-rtc) for days, estimate_power with wakes_per_day.",
    mustSay: [/deep.sleep/],
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
    text: () => `Think how it goes together before the case exists, using ${tool("propose_layout")}'s placements and layers: what mounts where, the insertion order, the wire room, access to USB / buttons / switch, battery safety (the checklist below). If a part cannot go in, change the layout or the part now.`,
  },
  {
    title: "Design the case",
    text: () => `${tool("design_case")} with the chosen layout (any shape: a preset or "custom" with an outline you draw), show the renders and the measured size and checks (pocket verdict, screen window, button travel, USB access). ${tool("update_case")} to change it.`,
  },
  {
    title: "How it goes together",
    needs: ["get_assembly_plan"],
    text: () => `${tool("get_assembly_plan")} on the designed case: which shell each part goes into and what holds it (the case adds seat posts, hold-downs, backstops and cell corners), the insertion order, when each wire is soldered, the battery last, a test before closing, a picture per step. Fix what its assembly-* checks flag (${tool("update_case")}, another layout or a part) before printing, and tell the person the order in a few steps.`,
    fallback: () => `Check the case against the checklist below with ${tool("get_case")}'s placements: what holds each part, the order it goes in, wire room, access, battery safety; change the layout or a part if one cannot go in.`,
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
    `There is no single build-kit tool in this Fabwright yet. Make sure there is a case (${tool("get_case")}; if none, ${tool("check_fit")} → ${tool("propose_layout")} → ${tool("design_case")}), set ${tool("set_assembly")} "soldered" for a battery device, then ${tool("export_manufacturing")}. Its answer lists the files: ${tool("read_file")} the pack's BOM.md, enclosure/PRINT.md (or case/PRINT.md), assembly/ASSEMBLY.md and firmware/FLASHING.md (paths relative to the project, e.g. "manufacturing/<pack>/BOM.md"), and answer in four short parts, with totals:`,
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
