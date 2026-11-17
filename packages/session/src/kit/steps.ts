/**
 * Round 12, track kit: how to put it together, flash it and fix it. The steps come from the case
 * engine's assembly plan when the case has one (the plan get_assembly_plan returns, read through `planSteps`),
 * otherwise they are derived here from the case report (which part sits where, in which layer,
 * facing which wall), the wire cuts and the tests. Flashing, tools, skill, time and troubleshooting
 * are rules over the part data, the same for every project.
 */
import { buildNets, firmwareLanguage, type Project } from "@faber/project-format";
import type { PartRegistry, PartSpec } from "@faber/sim-core";
import type { AssemblyStep, CaseReport } from "@faber/enclosure";
import { colorName, type WireCut } from "../assembly.ts";
import type { FlashPlan, KitStep, KitTool, KitWire, TroubleRow } from "./types.ts";

// ------------------------------------------------------------------ the assembly plan

/**
 * The case engine's assembly plan (packages/enclosure `assemblyPlan`, read through the session's
 * `assemblyPlanFor`, the same plan get_assembly_plan returns) as kit steps: the plan's plain words
 * first, wire colours in words, images under case/ (a plan made again after a rewire has none).
 */
/** How to know a plan step worked, by what the step does (the plan's test steps say it themselves). */
const PLAN_CHECK: Record<AssemblyStep["action"], string> = {
  place: "It sits flat in its place and does not move when you tilt the shell.",
  "press-fit": "It is pressed fully down on its pins and does not move when you tilt the shell.",
  tape: "It sits flat in its place and does not move when you tilt the shell.",
  glue: "The glue has set and the part does not move.",
  screw: "Every screw is snug (not forced) and the part does not move.",
  solder: "Tug each wire gently: no joint moves, the joints are shiny, no bare copper touches another pad.",
  "route-wire": "No wire crosses the seam or the lip, and nothing is pulled tight when the case folds shut.",
  flash: "The computer sees the board and the firmware starts.",
  close: "The seam is even all round, nothing rattles and no wire shows at the seam.",
  test: "It does what the step says.",
};

/** A test step's check: its sentence saying what should happen (else its last sentence), not the whole step again. */
function testCheck(say: string): string {
  const sentences = say.split(/(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
  return sentences.find((x) => /\bshould\b/i.test(x)) ?? sentences.at(-1) ?? say;
}

/** What the plan steps need to know about the project to speak in the kit's words. */
export interface PlanWords {
  label: (ref: string) => string;
  caseRel: string;
  /** "xiao.usb" → "xiao's USB-C port", "sw.1" → "sw pin 1"; text left alone when the id is not a part. */
  ref?: (part: string, rest: string) => string | undefined;
  /** Parts that are soft cells (LiPo pouches). */
  cells?: ReadonlySet<string>;
  /** Cells whose lead ends in a JST plug, with the family ("JST-PH"): the kit buys the mating socket. */
  jst?: ReadonlyMap<string, string>;
  /** The project's test scenarios by name (they passed in the simulator). */
  tests?: string[];
}

/**
 * The plan's words are written for the factory pack (its paths, its part refs, its parameter names); the kit is read by
 * a person with the kit open, so the paths become the kit's own sections and the refs become words.
 */
const PACK_PATHS: [RegExp, string][] = [
  [/\((?:enclosure\/)?PRINT\.md\)/g, "(see the print list)"],
  [/\((?:length )?in (?:enclosure\/)?PRINT\.md\)/g, "(see the print list)"],
  [/(?:enclosure\/)?PRINT\.md/g, "the print list"],
  [/\(firmware\/FLASHING\.md\)/g, "(see the Flash steps)"],
  [/firmware\/FLASHING\.md/g, "the Flash steps"],
  [/\b(?:in|from) (?:electronics\/)?WIRE-CUTS\.csv/g, "in the wire list below"],
  [/(?:electronics\/)?WIRE-CUTS\.csv/g, "the wire list"],
  [/\(sd-card\/CLIPS\.md\)/g, "(see the Flash steps for the sound clips)"],
  [/test\/TEST-PLAN\.md and test\/TEST-ON-HARDWARE\.md/g, "the tests below and the \"Check on the real device\" list (under If something does not work)"],
  [/test\/TEST-PLAN\.md/g, "the tests below"],
  [/test\/TEST-ON-HARDWARE\.md/g, "the \"Check on the real device\" list (under If something does not work)"],
  [/\btolerance_mm\s+([0-9]+(?:\.[0-9]+)?)/g, "a looser fit (the case's tolerance at $1 mm)"],
];

export function kitWords(text: string, w: Pick<PlanWords, "ref">): string {
  let t = text;
  for (const [re, to] of PACK_PATHS) t = t.replace(re, to);
  if (w.ref) t = t.replace(/\b([a-z][a-z0-9_-]*)\.([A-Za-z0-9_+-]+(?:\.\d+)?)\b/g, (m, part: string, rest: string) => w.ref!(part, rest) ?? m);
  return t;
}

export function planSteps(steps: AssemblyStep[], ctx: PlanWords): KitStep[] {
  const words = (t: string) => kitWords(t, ctx);
  // a pin where 3 or more wires meet: a small pad takes two at most, so the step that solders the first of them says how
  const ends = new Map<string, string[]>();
  for (const st of steps) for (const w of st.wires) for (const end of [w.from, w.to]) ends.set(end, [...new Set([...(ends.get(end) ?? []), w.id])]);
  const crowded = [...ends.entries()].filter(([, ids]) => ids.length >= 3);
  const told = new Set<string>();
  return steps.map((st, i) => {
    const wires: KitWire[] = st.wires.map((w) => ({ wire: w.id, from: w.from, to: w.to, from_label: ctx.label(w.from), to_label: ctx.label(w.to), color: w.color.startsWith("#") ? colorName(w.color) : w.color, length_mm: w.length_mm, gauge_awg: w.gauge }));
    const image = st.image ? `${ctx.caseRel}/${st.image}` : undefined;
    const extra = [...(st.fasteners.length ? [`Fasteners: ${st.fasteners.map((f) => `${f.qty} x ${words(f.size)} ${f.kind}`).join(", ")}.`] : []), ...(st.tools.length ? [`Tools: ${st.tools.join(", ")}.`] : [])];
    const cautions = st.cautions.map(words);
    const doLines = [words(st.say)];
    // the tests this step points at, by name (the kit has no test folder)
    if (/TEST-PLAN\.md/.test(st.say) && ctx.tests?.length) doLines.push(`The tests (they passed in Faber's simulator): ${ctx.tests.join("; ")}.`);
    // a soldering step (not the bench cut-list step) that joins a crowded pin
    // (not the bench steps that cut the wires or put the small parts in line: the pads are soldered later)
    if (st.wires.length && st.shell !== "bench") {
      for (const [end, ids] of crowded) {
        if (told.has(end) || !st.wires.some((w) => w.from === end || w.to === end)) continue;
        told.add(end);
        const here = ids.filter((id) => st.wires.some((w) => w.id === id));
        const later = ids.filter((id) => !here.includes(id));
        cautions.push(`${ids.length} wires end at ${ctx.label(end)}: ${here.join(", ")} now${later.length ? `, ${later.join(", ")} in a later step` : ""}. A small pad holds two at most: twist the others together with one short extra wire, solder and heat-shrink that splice, and solder the single wire to the pad${later.length ? `; leave the splice open (or one pad free) for ${later.join(", ")}` : ""}.`);
      }
    }
    // the cell: the kit bought a socket for its plug, so the "leads" are the socket's; the check is the polarity
    const cell = st.parts.find((p) => ctx.cells?.has(p));
    let check = st.action === "test" ? testCheck(words(st.say)) : PLAN_CHECK[st.action];
    if (cell && st.wires.length) {
      const fam = ctx.jst?.get(cell);
      if (fam) doLines.push(`${cell}'s lead ends in a ${fam} plug: solder the ${fam} socket's leads (on the shopping list) in place of ${st.wires.map((w) => w.id).join(" and ")}, red to the + pad, black to the − pad. Then plug the cell into the socket.`);
      const pads = [...new Set(st.wires.map((w) => (ctx.cells!.has(w.from.split(".")[0]!) ? w.to : w.from)))].map((r) => ctx.label(r)).join(" and ");
      check = fam
        ? `Before plugging the cell in: the socket's red lead is on the + pad and the cell's plug goes in red to red. Plugged in: the multimeter reads 3.0 to 4.2 V across ${pads}, and nothing gets warm.`
        : `Connected: the multimeter reads 3.0 to 4.2 V across ${pads}, + on the red lead, and nothing gets warm.`;
    }
    return { n: i + 1, title: st.title, do: [...doLines, ...extra].filter(Boolean), ...(image ? { image, image_alt: st.title } : {}), parts: st.parts, wires, cautions, check };
  });
}

// ------------------------------------------------------------------ derived steps

export interface StepInput {
  project: Project;
  registry: PartRegistry;
  report: CaseReport | undefined;
  cuts: WireCut[];
  estimatedCuts: boolean;
  soldered: boolean;
  screws: boolean;
  flash: FlashPlan;
  /** Case files that exist (relative to case/), for pictures. */
  has: (rel: string) => boolean;
}

/** "xiao.3V3" → "xiao (XIAO RP2040) pin 3V3". */
export function refLabel(project: Project, registry: PartRegistry): (ref: string) => string {
  return (ref) => {
    const [part, pin] = [ref.slice(0, ref.indexOf(".")), ref.slice(ref.indexOf(".") + 1)];
    const inst = project.parts.find((p) => p.id === part);
    const spec = inst ? registry.get(inst.type)?.spec : undefined;
    const ps = spec?.pins.find((x) => x.id === pin);
    const name = shortName(spec, inst?.standIn);
    const pinWords = ps && ps.label && ps.label !== pin ? `${pin} (${ps.label})` : pin;
    const jst = spec ? /JST[- ]?(PH|SH|XH|ZH|GH)/i.exec(`${spec.sourcing?.package ?? ""} ${spec.sourcing?.generic ?? ""}`) : null;
    return `${part}${name ? ` (${name})` : ""} pin ${pinWords}${jst ? `, on the JST-${jst[1]!.toUpperCase()} socket's lead (${/^(?:\+|POS|BAT\+|VBAT|V\+)/i.test(pin) || /\+/.test(ps?.label ?? "") ? "red" : "black"})` : ""}`;
  };
}

function shortName(spec: PartSpec | undefined, standIn?: string): string {
  if (standIn) return standIn;
  if (!spec) return "";
  return spec.name.replace(/\s*\(.*\)\s*$/, "");
}

/** Part refs in the plan's words as words: "xiao.usb" → "xiao's USB-C port", "sw.1" → "sw pin 1"; undefined when it is not a part of this project. */
export function refWords(project: Project, registry: PartRegistry): (part: string, rest: string) => string | undefined {
  return (part, rest) => {
    const inst = project.parts.find((p) => p.id === part);
    if (!inst) return undefined;
    const spec = registry.get(inst.type)?.spec;
    const f = spec?.mechanical?.features?.find((x) => x.id === rest);
    if (f) {
      const conn = (f as { connector?: string }).connector;
      const what = f.kind === "connector" ? `${conn ? conn.replace(/^usb-c$/i, "USB-C").replace(/^usb-micro$/i, "micro-USB").replace(/^usb-a$/i, "USB-A") : rest.toUpperCase()} port` : f.kind === "button" ? `${rest.toUpperCase()} button` : f.kind === "switch" ? "switch lever" : f.kind;
      return `${part}'s ${what}`;
    }
    if (spec?.pins.some((x) => x.id === rest)) return `${part} pin ${rest}`;
    return undefined;
  };
}

/** Cells whose lead ends in a JST plug (the kit buys the mating socket), by id: "JST-PH". */
export function cellPlugs(project: Project, registry: PartRegistry): Map<string, string> {
  const out = new Map<string, string>();
  const nets = buildNets(project);
  for (const p of project.parts) {
    const spec = registry.get(p.type)?.spec;
    if (!spec?.mechanical?.soft) continue;
    const m = /JST[- ]?(PH|SH|XH|ZH|GH)/i.exec(`${spec.sourcing?.package ?? ""} ${spec.sourcing?.generic ?? ""}`);
    if (!m) continue;
    const fam = `JST-${m[1]!.toUpperCase()}`;
    // (the same rule as the shopping list: no socket when a part it connects to has the mating connector)
    const near = new Set(nets.filter((n) => n.pins.some((r) => r.part === p.id)).flatMap((n) => n.pins.map((r) => r.part)).filter((x) => x !== p.id));
    const hasMate = [...near].some((n) => (registry.get(project.parts.find((q) => q.id === n)?.type ?? "")?.spec.mechanical?.features ?? []).some((f) => f.kind === "connector" && ((f as { connector?: string }).connector ?? "").toLowerCase().startsWith(fam.toLowerCase())));
    if (!hasMate) out.set(p.id, fam);
  }
  return out;
}

const FACING: Record<string, string> = { front: "facing the front (towards you)", back: "facing the back", left: "against the left wall", right: "against the right wall", top: "against the top wall", bottom: "against the bottom wall" };
/** "against the right wall (its opening is there)" when the part has something the case exposes. */
function facingWords(facing: string, spec: PartSpec | undefined): string {
  const base = FACING[facing] ?? facing;
  const exposed = (spec?.mechanical?.features ?? []).some((f) => f.expose !== false && ["button", "switch", "knob", "connector", "sensor-window", "grille", "screen", "led", "camera"].includes(f.kind));
  return facing !== "front" && facing !== "back" && exposed ? `${base} (its opening is there)` : base;
}

export function derivedSteps(inp: StepInput): KitStep[] {
  const { project, registry, report, cuts } = inp;
  const label = refLabel(project, registry);
  const specOf = (id: string) => registry.get(project.parts.find((p) => p.id === id)?.type ?? "")?.spec;
  const name = (id: string) => `${id} (${shortName(specOf(id), project.parts.find((p) => p.id === id)?.standIn) || id})`;
  const kw = (c: WireCut): KitWire => ({ wire: c.wire, from: c.from, to: c.to, from_label: label(c.from), to_label: label(c.to), color: c.color, length_mm: c.length_mm, gauge_awg: c.gauge_awg });
  const img = (n: string) => (inp.has(`renders/${n}.png`) ? { image: `case/renders/${n}.png`, image_alt: `The case, ${n === "inside" ? "the parts inside" : n}` } : {});
  const steps: Omit<KitStep, "n">[] = [];
  const board = project.parts.find((p) => p.id === project.firmware?.board) ?? project.parts.find((p) => specOf(p.id)?.category === "board");
  const cell = project.parts.find((p) => specOf(p.id)?.mechanical?.soft || /lipo|li-ion|battery/i.test(specOf(p.id)?.id ?? ""));
  const scenarioChecks = (ids: string[]) =>
    project.scenarios
      .filter((sc) => ids.some((id) => JSON.stringify(sc.steps).includes(`"${id}`) || JSON.stringify(sc.steps).includes(`${id}.`)))
      .map((sc) => sc.name ?? sc.id);

  if (report) {
    steps.push({
      title: "Print the case and test the fit",
      do: ["Print every file in the print list (each already lies the right way up on the bed).", "Press the front and back shells together before anything else: they should close evenly and open again.", "If the seam is too tight, sand the lip lightly; if it is loose, print the back shell again with 0.1 mm less clearance in your slicer (horizontal expansion -0.1)."],
      ...img("front"),
      parts: [],
      wires: [],
      cautions: [],
      check: "The two empty shells close all round and open again with a fingernail in the seam.",
      minutes: 10,
    });
    if (inp.screws) steps.push({ title: "Press the heat-set inserts", do: ["Put each M2 insert on its post in the front shell, flat side up.", "Press it in with the soldering iron at about 220 °C (an insert tip, or an old tip), straight down, until it is flush; hold it straight while it cools for a few seconds."], ...img("inside"), parts: [], wires: [], cautions: ["The iron and the insert are hot enough to burn; do not touch the brass for a minute."], check: "A screw goes in by hand and the insert does not turn.", minutes: 10 });
  }
  if (board && inp.flash.method !== "none") {
    steps.push({ title: `Flash ${name(board.id)} before wiring it`, do: ["Plug the bare board into your computer with the data cable and follow the Flash steps.", "Open a serial monitor at 115200 baud (Arduino IDE: Tools > Serial Monitor) to see it start."], parts: [board.id], wires: [], cautions: inp.flash.built !== "fresh" ? [inp.flash.why_missing ?? "The firmware file is not ready yet: see the Flash steps."] : [], check: "The board starts: its serial output appears (or its LED blinks) with nothing else connected.", minutes: 10 });
  }

  // which step a wire belongs to: the power path first, then each module, front layer first
  const done = new Set<string>();
  if (inp.soldered && cuts.length) {
    steps.push({
      title: "Cut and strip the wires",
      do: [`Cut ${cuts.length} wires to the lengths below (each length already has 5 mm to strip at each end and a little slack).`, "Strip 5 mm at both ends and tin them (melt a little solder into the strands).", "Label each with a strip of tape (its number) if the colours repeat.", ...(inp.estimatedCuts ? ["These lengths are estimates (no case layout): hold each wire in place before cutting it."] : [])],
      parts: [],
      wires: cuts.map(kw),
      cautions: [],
      check: `${cuts.length} wires, tinned at both ends.`,
      minutes: Math.round(cuts.length * 1.5),
    });
  }
  const powerParts = project.parts.filter((p) => specOf(p.id)?.category === "power" || (p.type === "slide-switch" || /diode/.test(p.type)) && cuts.some((c) => c.gauge_awg <= 24 && (c.from.startsWith(`${p.id}.`) || c.to.startsWith(`${p.id}.`)))).map((p) => p.id);
  const powerCuts = cuts.filter((c) => c.gauge_awg <= 24);
  if (powerCuts.length) {
    for (const c of powerCuts) done.add(c.wire);
    steps.push({
      title: "Wire power and ground",
      do: [
        `${inp.soldered ? "Solder" : "Connect"} the power and ground wires first (the thicker ones${inp.soldered ? ", 24 AWG" : ""}): the battery path and the supply of every module. The signal wires come in the next steps, one module at a time.`,
        ...(cell ? [`Leave ${name(cell.id)} unplugged until the end: solder its socket's wires, not the cell itself.`] : []),
        inp.soldered ? "Slide heat-shrink over each wire before soldering, then shrink it over the joint." : "Red to + and black to - on every power wire, so a mistake is easy to spot.",
      ],
      ...img("inside"),
      parts: powerParts,
      wires: powerCuts.map(kw),
      cautions: [
        ...(cell ? ["Never let the battery's + and - touch (it can get hot fast). Check the red wire of the cell's plug goes to + on the socket: some cells come wired the other way round."] : []),
        ...(project.parts.some((p) => /schottky|diode/.test(p.type)) ? ["A diode only works one way round: the end with the stripe is the cathode; it goes where the wire list says Cathode."] : []),
      ],
      check: cell
        ? "Multimeter on continuity (beep): no beep between + and - at the battery socket, nor between the board's supply pins and GND. Then USB into the board: it starts as before (the battery comes later)."
        : "Multimeter on continuity (beep): no beep between the supply and ground. Then plug USB in: the board starts.",
      minutes: Math.round(powerCuts.length * 3 + 5),
    });
  }
  // modules, front layer first (the case's layers), then the rest
  const layerOf = new Map<string, number>();
  report?.layout?.layers.forEach((l) => l.parts.forEach((id) => layerOf.set(id, l.index)));
  report?.placed.forEach((p) => (layerOf.has(p.id) ? undefined : layerOf.set(p.id, p.layer)));
  const modules = project.parts
    .filter((p) => p.id !== board?.id && specOf(p.id)?.category !== "passive" && !powerParts.includes(p.id))
    .sort((a, b) => (layerOf.get(a.id) ?? 99) - (layerOf.get(b.id) ?? 99) || a.id.localeCompare(b.id));
  const passives = new Set(project.parts.filter((p) => specOf(p.id)?.category === "passive").map((p) => p.id));
  const nets = buildNets(project);
  const powerNet = (n: (typeof nets)[number]) => n.pins.some((r) => { const t = specOf(r.part)?.pins.find((x) => x.id === r.pin)?.type; return t === "power" || t === "ground"; });
  const touches = (c: WireCut, id: string) => c.from.startsWith(`${id}.`) || c.to.startsWith(`${id}.`);
  for (const m of modules) {
    // its own wires, plus the wires of resistors / diodes that sit between it and the board
    const via = [...passives].filter((pid) => nets.some((n) => !powerNet(n) && n.pins.some((r) => r.part === pid) && n.pins.some((r) => r.part === m.id)));
    const mine = cuts.filter((c) => !done.has(c.wire) && (touches(c, m.id) || via.some((v) => touches(c, v))));
    if (!mine.length) continue;
    for (const c of mine) done.add(c.wire);
    const spec = specOf(m.id);
    const sc = scenarioChecks([m.id]);
    const cat = spec?.category ?? "";
    const generic = cat === "display" ? "Power it from USB: the screen lights up and shows the first picture." : cat === "input" || cat === "sensor" ? `Power it from USB and open the serial monitor: ${m.id} changes the readings when you use it.` : cat === "output" || cat === "motor" ? `Power it from USB: ${m.id} does what the first test says.` : `Power it from USB: everything that worked before still works.`;
    steps.push({
      title: `Wire ${name(m.id)}${via.length ? ` and ${via.join(", ")}` : ""}`,
      do: [
        `${inp.soldered ? "Solder" : "Connect"} these wires (the list says which pin goes where).`,
        ...(via.length ? [`${via.map((v) => name(v)).join(", ")} sit${via.length > 1 ? "" : "s"} in the wire: solder ${via.length > 1 ? "them" : "it"} inline and cover the bare leads with heat-shrink.`] : []),
        ...(layerOf.has(m.id) && report ? [`It goes ${placeWords(report, m.id, spec)} in the case: leave the wires long enough to fold it there.`] : []),
      ],
      ...img("inside"),
      parts: [m.id, ...via],
      wires: mine.map(kw),
      cautions: [
        ...(spec?.category === "display" ? ["Do not press on the glass, and do not bend the thin ribbon cable at its edge sharply."] : []),
        ...(spec?.mcu || (spec?.pins ?? []).some((p) => p.voltage && p.voltage.max <= 3.6) ? [] : []),
      ],
      check: sc.length ? `Power it from USB and check the test "${sc[0]}"${sc.length > 1 ? ` (and ${sc.length - 1} more in the final check)` : ""} behaves as described.` : generic,
      minutes: Math.round(mine.length * 3 + 3),
    });
  }
  // resistors / diodes that are not inline with one module (a divider to the board, a pull-up)
  const loose = [...passives].filter((pid) => cuts.some((c) => !done.has(c.wire) && touches(c, pid)));
  if (loose.length) {
    const mine = cuts.filter((c) => !done.has(c.wire) && loose.some((pid) => touches(c, pid)));
    for (const c of mine) done.add(c.wire);
    steps.push({ title: `Wire ${loose.map((pid) => name(pid)).join(", ")}`, do: [`${inp.soldered ? "Solder" : "Connect"} these wires; ${inp.soldered ? "cut the leads short, solder them straight onto the wires and cover each joint with heat-shrink" : "push the leads into the breadboard rows the list names"}.`, ...loose.map((pid) => { const v = project.parts.find((p) => p.id === pid); const val = v?.props?.resistance; return typeof val === "number" ? `${pid} is ${val >= 1000 ? `${val / 1000}k` : val} ohm: check the colour bands (or measure it) before soldering.` : ""; }).filter(Boolean)], ...img("inside"), parts: loose, wires: mine.map(kw), cautions: [], check: "Power it from USB: everything that worked before still works.", minutes: Math.round(mine.length * 3 + 2) });
  }
  const rest = cuts.filter((c) => !done.has(c.wire));
  if (rest.length) {
    steps.push({ title: "Wire the rest", do: [`${inp.soldered ? "Solder" : "Connect"} the remaining wires.`], parts: [], wires: rest.map(kw), cautions: [], check: "Power it from USB: everything still works.", minutes: rest.length * 3 });
  }
  if (!cuts.length && project.wires.length) {
    steps.push({ title: "Wire it", do: ["Make every connection in the wiring list (WIRING.md in the download)."], parts: [], wires: [], cautions: [], check: "Power it from USB: it starts.", minutes: project.wires.length * 2 });
  }

  if (report) {
    const layers = report.layout?.layers?.length ? report.layout.layers : [...new Set(report.placed.map((p) => p.layer))].sort((a, b) => a - b).map((i) => ({ index: i, z_mm: [0, 0] as [number, number], parts: report.placed.filter((p) => p.layer === i).map((p) => p.id) }));
    const sideParts = report.placed.filter((p) => p.facing !== "front" && p.facing !== "back");
    const cellStep = !!cell && report.placed.some((p) => p.id === cell.id);
    steps.push({
      title: "Put the parts in the case",
      do: [
        "Lay the front shell face down (looking at its inside, the left and right are swapped compared with the front).",
        ...(sideParts.length ? [`First the parts that stand against a side wall (a port, button or lever lines up with its hole there): ${sideParts.map((p) => `${name(p.id)} ${facingWords(p.facing, specOf(p.id))}`).join("; ")}.`] : []),
        ...layers.flatMap((l, i) => {
          const where = layers.length > 1 ? `Layer ${i + 1} (${i === 0 ? "against the front" : i === layers.length - 1 ? "towards the back" : "in the middle"})` : "Inside";
          const front = (id: string) => ((specOf(id)?.mechanical?.features ?? []).some((f) => f.kind === "screen") ? 0 : 1);
          return l.parts
            .filter((id) => !sideParts.some((s) => s.id === id) && !(cellStep && id === cell?.id))
            .sort((a, b) => front(a) - front(b))
            .map((id) => `${where}: ${name(id)}, ${placeWords(report, id, specOf(id))}${front(id) === 0 ? " (first: it lines up with the window)" : ""}.`);
        }),
        ...(report.files.some((f) => /cap-|light-pipe-/.test(f.body)) ? ["Drop the printed button caps / light pipes into their holes from the inside before the parts that sit behind them."] : []),
        "Hold modules that have no screw post with a square of 1 mm foam tape; fold the wires flat along the walls, away from the seam.",
      ],
      ...img("inside"),
      parts: report.placed.map((p) => p.id),
      wires: [],
      cautions: ["Keep wires out of the seam: a pinched wire stops the case closing and can short.", ...(report.placed.some((p) => specOf(p.id)?.category === "display") ? ["The screen goes face down against the window: check it sits straight before taping anything behind it."] : [])],
      check: "Hold the back shell over it: it sits flat on the rim without pressing on anything.",
      minutes: 10 + report.placed.length * 2,
    });
    if (cell && report.placed.some((p) => p.id === cell.id)) {
      steps.push({ title: `Plug in ${name(cell.id)}`, do: ["Put the cell in its cradle in the back shell (it is the soft, flat pouch).", "Plug its connector into the socket last, after all soldering is done."], ...img("back"), parts: [cell.id], wires: [], cautions: ["Never press, bend or pierce the cell, and never solder near it. If it ever puffs up, stop using it."], check: "Switch on: it starts from the battery with USB unplugged.", minutes: 3 });
    }
    steps.push({ title: "Close the case", do: [inp.screws ? "Put the back on and drive the M2 screws in from the back, finger tight (the inserts strip if forced)." : "Press the back onto the front all round until the lip clicks; to open it again, push a fingernail into the seam at the bottom."], ...img("exploded"), parts: [], wires: [], cautions: [], check: `The seam is even all round${project.parts.some((p) => (specOf(p.id)?.mechanical?.features ?? []).some((f) => f.kind === "button" && f.expose !== false)) ? " and the buttons still click" : ""}${project.parts.some((p) => (specOf(p.id)?.mechanical?.features ?? []).some((f) => f.kind === "switch")) ? "; the switch slides" : ""}.`, minutes: 3 });
  }
  const names = project.scenarios.map((sc) => sc.name ?? sc.id);
  steps.push({
    title: "Final check",
    do: [names.length ? `Run through every test (they passed in Faber's simulator): ${names.join("; ")}.` : "Try every function by hand.", "Then the list under \"Check on the real device\" in the troubleshooting section: those were not simulated exactly."],
    parts: [],
    wires: [],
    cautions: [],
    check: "It behaves like it did in Faber.",
    minutes: 10 + names.length * 2,
  });
  return steps.map((st, i) => ({ n: i + 1, ...st }));
}

function placeWords(report: CaseReport, id: string, spec?: PartSpec): string {
  const p = report.placed.find((x) => x.id === id);
  if (!p) return "";
  const cx = (p.min[0] + p.max[0]) / 2;
  const cy = (p.min[1] + p.max[1]) / 2;
  const W = report.size_mm.w / 2;
  const H = report.size_mm.h / 2;
  const v = cy > H * 0.25 ? "near the top" : cy < -H * 0.25 ? "near the bottom" : "in the middle";
  const h = cx > W * 0.25 ? "right" : cx < -W * 0.25 ? "left" : "";
  const where = h ? `${v === "in the middle" ? "on the" : `${v},`} ${h}${v === "in the middle" ? " side" : ""}` : v;
  let port = "";
  const feats = (spec?.mechanical?.features ?? []).filter((f) => f.expose !== false && (f.kind === "connector" || f.kind === "switch" || f.kind === "button") && /^[+-][xy]$/.test(f.face));
  if ((p.facing === "front" || p.facing === "back") && feats.length) {
    // the nearest side wall: where the case cut its opening
    const d = { right: W - p.max[0], left: p.min[0] + W, top: H - p.max[1], bottom: p.min[1] + H };
    const side = (Object.entries(d) as [string, number][]).sort((a, b) => a[1] - b[1])[0]![0];
    const f = feats[0]!;
    const conn = f.connector === "usb-c" ? "USB-C " : f.connector === "micro-usb" ? "micro-USB " : f.connector ? `${f.connector.toUpperCase()} ` : "";
    const what = f.kind === "connector" ? `its ${conn}port` : f.kind === "switch" ? "its lever" : "its button";
    port = `, with ${what} at the opening in the ${side} wall`;
  }
  return `${where} (seen from the front), ${FACING[p.facing] ?? p.facing}${port}`;
}

// ------------------------------------------------------------------ flashing

export function flashPlan(project: Project, registry: PartRegistry, built: FlashPlan["built"]): FlashPlan {
  const fw = project.firmware;
  const board = fw ? project.parts.find((p) => p.id === fw.board) : project.parts.find((p) => registry.get(p.type)?.spec.category === "board");
  const spec = board ? registry.get(board.type)?.spec : undefined;
  const cableKind = (spec?.mechanical?.features ?? []).find((f) => f.kind === "connector" && /usb/i.test(f.connector ?? ""))?.connector;
  const cable = cableKind ? `${cableKind === "usb-c" ? "USB-C" : cableKind === "micro-usb" ? "Micro-USB" : cableKind.toUpperCase()} data cable` : "USB data cable";
  const base = { board: spec?.name ?? board?.type ?? "no board", board_type: board?.type ?? "", cable };
  if (!fw || !spec?.mcu) return { ...base, language: "none", method: "none", built: "none", steps: ["This project has no firmware to flash."], commands: [], needs: [], why_missing: fw ? "the board has no microcontroller" : "the project has no firmware" };
  const mcu = spec.mcu;
  const language = firmwareLanguage(fw);
  const fqbn = fw.build?.fqbn ?? mcu.fqbn ?? "";
  const artifact = fw.artifact;
  const why_missing = built === "fresh" ? undefined : built === "stale" ? "The sketch changed since the last build: press Run (or Build) in Faber, then download the kit again" : "The firmware was never built: press Run (or Build) in Faber, then download the kit again";
  const port = "<port>";
  const portHelp = "<port> is the board's serial port: macOS /dev/cu.usbmodem… (or /dev/cu.usbserial…), Linux /dev/ttyACM0 or /dev/ttyUSB0, Windows COM3 (Arduino IDE: Tools > Port shows it).";
  const out: FlashPlan = { ...base, language, method: "arduino-cli", file: artifact, built, steps: [], commands: [], needs: [], ...(why_missing ? { why_missing } : {}) };
  if (language === "micropython") {
    out.method = "mpremote";
    out.file = "firmware/main.py";
    out.kit_file = "firmware/main.py";
    out.needs = ["MicroPython on the board (micropython.org/download: the UF2 or .bin for this board)", "mpremote (pip install mpremote)"];
    out.steps = ["Install MicroPython on the board once (micropython.org/download has the file and the steps for this board).", "Copy main.py onto it with mpremote, then reset it: it runs main.py at every start."];
    out.commands = [{ label: "Copy the program", cmd: `mpremote connect auto cp firmware/main.py :main.py` }, { label: "Restart it", cmd: "mpremote connect auto reset" }];
    return out;
  }
  if (mcu.backend === "rp2040js") {
    out.method = "uf2-drag";
    out.kit_file = "firmware/firmware.uf2";
    out.steps = ["Hold the BOOT button on the board (on a Pico: BOOTSEL).", "Plug the USB cable into your computer while holding it, then let go: a drive called RPI-RP2 appears.", "Copy firmware.uf2 onto that drive. The drive disappears and the board starts the program."];
    out.commands = [{ label: "Or from the command line (picotool)", cmd: "picotool load -x firmware/firmware.uf2" }, { label: "Or build and upload from source", cmd: `arduino-cli compile --fqbn ${fqbn} firmware && arduino-cli upload --fqbn ${fqbn} -p ${port} firmware` }];
    out.needs = ["Nothing for drag and drop; picotool or arduino-cli (with the rp2040 board package) for the command line."];
    return out;
  }
  if (mcu.backend === "qemu-esp") {
    out.method = "esptool";
    out.kit_file = "firmware/firmware.bin";
    const cmd = (mcu.toolchain?.flash ?? "esptool --port {port} write_flash 0x0 {bin}").replace("{bin}", "firmware/firmware.bin").replace("{port}", port);
    out.steps = ["Plug the board in with the data cable.", "Run the command below (firmware.bin is the whole flash image: bootloader, partitions and program, built for the real board).", "If it does not connect: hold BOOT, press and release RESET (or plug in while holding BOOT), let go of BOOT, and run it again.", portHelp];
    out.commands = [{ label: "Flash (esptool)", cmd }, { label: "Or build and upload from source", cmd: `arduino-cli compile --fqbn ${fqbn} firmware && arduino-cli upload --fqbn ${fqbn} -p ${port} firmware` }];
    out.needs = ["esptool (pip install esptool; GPL-2.0, a separate program)", "On Windows / older macOS a USB-serial driver may be needed for boards with a CP2102 / CH340 chip."];
    return out;
  }
  if (mcu.backend === "avr8js") {
    out.method = "avrdude";
    out.kit_file = "firmware/firmware.hex";
    out.steps = ["Plug the board in with the data cable.", "Run the upload command below, or open the source in the Arduino IDE and press Upload.", portHelp, ...(/nano/.test(fqbn) ? ["Cheap Nano clones often have the old bootloader: if the upload times out, use the fqbn with cpu=atmega328old (Arduino IDE: Tools > Processor > ATmega328P (Old Bootloader))."] : [])];
    out.commands = [{ label: "Upload the built file (arduino-cli)", cmd: `arduino-cli upload --fqbn ${fqbn} -p ${port} --input-file firmware/firmware.hex` }, { label: "Or with avrdude", cmd: `avrdude -p m328p -c arduino -P ${port} -b ${/nano/.test(fqbn) && !/atmega328old/.test(fqbn) ? 115200 : 115200} -U flash:w:firmware/firmware.hex:i` }];
    out.needs = ["arduino-cli or the Arduino IDE (with the Arduino AVR board package)."];
    return out;
  }
  // Renode boards and anything else: the Arduino toolchain's own upload
  out.method = "arduino-cli";
  out.kit_file = "firmware/firmware.hex";
  const nrfUf2 = /nrf52/i.test(mcu.chip) && /Seeeduino|xiao/i.test(fqbn);
  const stm = /^stm32/i.test(mcu.chip);
  out.steps = [
    ...(nrfUf2 ? ["Double-tap the RESET button: a drive appears (XIAO-SENSE or similar).", "Upload with the command below (it uses that bootloader)."] : []),
    ...(stm ? ["STM32 boards upload through an ST-Link (SWD pins) or, on a Black Pill, over USB in DFU mode: hold BOOT0, tap NRST, let go of BOOT0.", "Nucleo boards show a drive (NODE_…): copy firmware.hex onto it."] : []),
    ...(!nrfUf2 && !stm ? ["Plug the board in with the data cable and run the upload below (the Arduino IDE's Upload button does the same)."] : []),
    portHelp,
  ];
  out.commands = [{ label: "Build and upload from source", cmd: `arduino-cli compile --fqbn ${fqbn} firmware && arduino-cli upload --fqbn ${fqbn} -p ${port} firmware` }, ...(stm ? [{ label: "Or with an ST-Link (STM32CubeProgrammer)", cmd: "STM32_Programmer_CLI -c port=SWD -w firmware/firmware.hex -v -rst" }] : [])];
  out.needs = [`arduino-cli or the Arduino IDE with the board package for ${fqbn.split(":").slice(0, 2).join(":")}`, ...(stm ? ["An ST-Link V2 programmer (a few dollars) unless the board is a Nucleo or a Black Pill in DFU mode."] : [])];
  return out;
}

// ------------------------------------------------------------------ tools, skill and time

export function toolsFor(project: Project, registry: PartRegistry, o: { soldered: boolean; hasCase: boolean; screws: boolean; inserts: boolean; printMinutes: number; steps: KitStep[]; cell: boolean; planTools?: string[] }): { items: KitTool[]; skill: "beginner" | "intermediate" | "experienced"; skill_why: string; time: { print_h: number; build_h: number; total_h: number; note: string } } {
  const items: KitTool[] = [{ name: "A computer with a USB port", why: "to flash the board", need: "required" }];
  const specs = project.parts.map((p) => registry.get(p.type)?.spec).filter((s): s is PartSpec => !!s);
  const castellated = specs.some((s) => /castellated/i.test(`${s.sourcing?.generic ?? ""} ${s.sourcing?.package ?? ""} ${s.footprint ?? ""}`));
  if (o.soldered) {
    items.push(
      { name: "Soldering iron with temperature control", why: `every connection is soldered; 330 to 360 °C${castellated ? ", with a fine conical or 1 mm chisel tip for the small pads on the edge of the board" : ""}`, need: "required" },
      { name: "Flush cutters", why: "to cut wires and trim leads flush", need: "required" },
      { name: "Wire stripper (for 22 to 30 AWG)", why: "to strip the thin wires without cutting strands", need: "required" },
      { name: "Multimeter", why: "continuity (beep) checks for shorts before the battery goes in, and the battery voltage", need: "recommended" },
      { name: "Tweezers", why: "to hold small wires and parts while soldering", need: "recommended" },
      { name: "Flux pen", why: "makes solder flow on small pads", need: "recommended" },
      { name: "Heat gun or a lighter", why: "to shrink the heat-shrink tube", need: "recommended" },
      { name: "Helping hands or a small vice", why: "holds the board while you solder", need: "optional" },
      { name: "Solder wick or a solder sucker", why: "to undo a joint", need: "optional" },
    );
  } else {
    items.push({ name: "Multimeter", why: "to find a loose wire", need: "optional" });
    if (project.wires.length) items.push({ name: "Soldering iron", why: "only to solder header pins onto modules that ship without them", need: "optional" });
  }
  if (o.hasCase) {
    items.push({ name: "A 3D printer, or a print service", why: "for the case (the print list has the files and settings)", need: "required" });
    items.push({ name: "Craft knife or deburring tool, and 240 grit sandpaper", why: "to clean the brim and the seam", need: "recommended" });
    items.push({ name: "Hot glue gun", why: "to hold a wire or the speaker in place if it moves", need: "optional" });
  }
  if (o.inserts) items.push({ name: "Heat-set insert tip for the iron (or an old tip)", why: "to press the brass inserts into the front shell", need: "recommended" });
  if (o.screws) items.push({ name: "Small Phillips screwdriver (PH0 / PH1)", why: "for the M2 screws", need: "required" });
  items.push({ name: "Safety glasses and an open window or a fan", why: "solder spits and its fumes", need: o.soldered ? "recommended" : "optional" });
  // the assembly plan's tools that the rules above did not name (consumables such as solder, tape or a cable are on the shopping list)
  for (const t of o.planTools ?? []) {
    const name = t.replace(/\s*\(.*?\)/g, "").replace(/\s+for the .*$/, "").trim();
    if (/solder\b(?!ing)|flux|tape|foam|cable|kapton|wire\b(?! strip)/i.test(name)) continue;
    const last = name.split(" ").at(-1)!.toLowerCase().replace(/s$/, "");
    if (items.some((i) => i.name.toLowerCase().includes(last))) continue;
    items.push({ name: name[0]!.toUpperCase() + name.slice(1), why: "the assembly steps use it", need: "recommended" });
  }

  const wires = o.steps.reduce((a, s) => a + s.wires.length, 0);
  const many = project.wires.length > 40;
  const odd = project.parts.some((p) => p.standIn || registry.get(p.type)?.fidelity.origin === "agent-made");
  const skill: "beginner" | "intermediate" | "experienced" = !o.soldered ? (odd ? "intermediate" : "beginner") : many || odd ? "experienced" : castellated || o.cell || project.wires.length > 8 ? "intermediate" : "beginner";
  const why = [
    o.soldered ? `${project.wires.length} soldered connections` : `${project.wires.length} plug-in connections on a breadboard, no soldering`,
    ...(castellated ? ["small pads on the edge of the board"] : []),
    ...(o.cell ? ["a LiPo cell (handle with care)"] : []),
    ...(odd ? ["a part Faber only approximated: check its datasheet"] : []),
  ].join(", ");
  const buildMin = o.steps.filter((s) => !/print the case/i.test(s.title)).reduce((a, s) => a + (s.minutes ?? 5), 0) + (wires ? 0 : 0);
  const print_h = Math.round((o.printMinutes / 60) * 10) / 10;
  const build_h = Math.round((buildMin / 60) * 10) / 10;
  return {
    items,
    skill,
    skill_why: `${skill === "beginner" ? "Beginner" : skill === "intermediate" ? "Intermediate" : "Experienced"}: ${why}.`,
    time: { print_h, build_h, total_h: Math.round((print_h + build_h) * 10) / 10, note: `Printing runs on its own (${print_h} h); the hands-on build is about ${build_h} h for a first-timer (about 3 minutes per soldered wire plus fitting and testing), less with practice.` },
  };
}

// ------------------------------------------------------------------ troubleshooting

const TOOL_WORDS: Record<string, string> = {
  export_manufacturing: "the factory pack",
  design_case: "the Case view",
  update_case: "the Case view",
  get_case: "the Case view",
  check_fit: "the Case view",
  get_build_kit: "this kit",
  check_design: "Faber's design check",
  set_part_property: "the part's settings in Faber",
  inject_fault: "a fault test in Faber",
  run_tests: "the tests in Faber",
  place_part: "adding the part in Faber",
  remove: "removing it in Faber",
};

/** Agent-facing words (tool names, their JSON arguments) turned into a person's words. */
export function peopleWords(text: string, tools: ReadonlySet<string> = new Set(Object.keys(TOOL_WORDS))): string {
  let t = text.replace(/\b([a-z]+(?:_[a-z0-9]+)+)\b(\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})?/g, (m, name: string) => (TOOL_WORDS[name] ?? (tools.has(name) ? "Faber" : m)));
  t = t.replace(/\(\s*(the factory pack|the Case view|Faber)\s*\)/g, "(in $1)");
  return t;
}

export function troubleshooting(project: Project, registry: PartRegistry, o: { report: CaseReport | undefined; drc: string[]; fidelity: string[]; flash: FlashPlan; soldered: boolean; tools?: ReadonlySet<string> }): TroubleRow[] {
  const rows: TroubleRow[] = [];
  const specs = project.parts.map((p) => ({ id: p.id, spec: registry.get(p.type)?.spec }));
  const has = (f: (s: PartSpec) => boolean) => specs.filter((x) => x.spec && f(x.spec)).map((x) => x.id);
  if (o.flash.method !== "none") {
    rows.push({ problem: "The computer does not see the board", why: "a charge-only USB cable, a missing driver, or the board is not in its upload mode", fix: `Try another cable (one that carries data), another port; ${o.flash.method === "uf2-drag" ? "hold BOOT while plugging in to get the RPI-RP2 drive" : o.flash.method === "esptool" ? "hold BOOT and tap RESET, then flash again" : "check the port in the Arduino IDE's Tools > Port"}.`, source: "general" });
  }
  rows.push({ problem: "Nothing happens when it is switched on", why: o.soldered ? "a power wire is loose or swapped, the switch is off, or the battery is flat" : "a power wire is loose", fix: "Measure the voltage at the board's supply pin with the multimeter (about 3.3 V or 5 V); follow the power wires from the battery or USB; charge the battery for an hour.", source: "general" });
  const displays = has((s) => s.category === "display");
  if (displays.length) rows.push({ problem: `The screen (${displays.join(", ")}) stays dark or shows noise`, why: "a loose data or clock wire, swapped pins, or a module that differs from the simulated one (another controller or I2C address)", fix: "Check each screen wire against the wire list with the multimeter (beep); run the board with the serial monitor open: the sketch prints what it found.", source: "part" });
  const cards = has((s) => /micro\s?-?SD|TF card/i.test(`${s.description} ${s.sourcing?.generic ?? ""}`));
  if (cards.length) rows.push({ problem: `No sound or the wrong clip plays (${cards.join(", ")})`, why: "the card is not FAT32, the files are not named 0001.mp3, 0002.mp3 … in the order the sketch expects, or the speaker wires are loose", fix: "Format the card FAT32, copy the clips in order (the Flash steps say how to make them), and check the speaker's two wires.", source: "part" });
  const cells = has((s) => !!s.mechanical?.soft || /lipo/i.test(s.id));
  if (cells.length) rows.push({ problem: "It runs on USB but not on the battery", why: "the cell is flat, its plug is wired the other way round, the switch is off, or a diode in the power path is reversed", fix: "Charge it (the charger's light goes off when full); measure the cell (3.0 to 4.2 V) and its polarity at the socket; check the diode's stripe.", source: "part" });
  const inputs = has((s) => s.category === "input");
  if (inputs.length) rows.push({ problem: `A button or switch does nothing (${inputs.join(", ")})`, why: "the printed cap does not reach the switch, or the wire went to the wrong pin", fix: "Open the case and press the switch directly; if that works, the cap is short: sand its flange or reprint it.", source: "part" });
  if (o.report) rows.push({ problem: "The case does not close", why: "a wire in the seam, a part sitting proud, or printer tolerances (the snap lip is tight on some printers)", fix: "Fold the wires along the walls; check the part positions in the Assemble tab; sand the lip lightly.", source: "case" });
  for (const line of o.drc) {
    const m = /^(error|warning)\s+\[([^\]]+)\]\s+(.*)$/s.exec(line);
    if (!m) continue;
    const [, , code, msg] = m;
    const fix = /Fix:\s*(.*)$/s.exec(msg!)?.[1];
    const why = msg!.replace(/\s*Fix:.*$/s, "");
    rows.push({ problem: `Design check: ${code!.replace(/-/g, " ")}`, why, fix: fix ?? "see the design check in Faber", source: "check_design" });
  }
  for (const c of o.report?.checks ?? []) {
    if (c.ok && c.severity !== "warning") continue;
    const fix = /Fix:\s*(.*)$/s.exec(c.message)?.[1];
    rows.push({ problem: `Case check: ${c.id}`, why: c.message.replace(/\s*Fix:.*$/s, ""), fix: fix ?? "check it on the first print", source: "case" });
  }
  for (const t of o.fidelity) {
    const m = /^([\w-]+) \(([^)]+)\): (.*)$/.exec(t);
    rows.push({ problem: m ? `Check on the real device (${m[1]}): ${m[3]}` : `Check on the real device: ${t}`, why: "Faber's simulation models this only approximately or not at all", fix: "Test it on the real device in the final check; if it differs, the sketch may need a small change.", source: "fidelity" });
  }
  return rows.map((r) => ({ ...r, problem: peopleWords(r.problem, o.tools), why: peopleWords(r.why, o.tools), fix: peopleWords(r.fix, o.tools) }));
}
