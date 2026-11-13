/**
 * Round 12, track kit: the build kit for any project (get_build_kit, GET /api/kit, the web "Build
 * it" panel, and build-kit/ in the factory pack). Read-only: it never rebuilds the case or the
 * firmware; what is stale or missing is said, with the fix.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { firmwareText } from "../firmware-text.ts";
import { join } from "node:path";
import type { CaseReport } from "@jumper/enclosure";
import { assemblyStyle, colorName, wireCuts, type WireCut } from "../assembly.ts";
import { fidelityReport } from "../fidelity.ts";
import { pinPositions } from "../manufacturing.ts";
import type { ProjectSession } from "../session.ts";
import { sdCardFiles } from "../voice.ts";
import { printPlan } from "./print-plan.ts";
import { shoppingList, type Region } from "./shopping.ts";
import { cellPlugs, derivedSteps, flashPlan, kitWords, peopleWords, planSteps, refLabel, refWords, toolsFor, troubleshooting } from "./steps.ts";
import type { BuildKit } from "./types.ts";
import { powerBudget } from "../power-budget.ts";
import { connectPlan } from "./connect.ts";

export type { BuildKit, ConnectPlan } from "./types.ts";
export { kitCsv, kitHtml, kitMarkdown, printListMd, shoppingMd } from "./render.ts";
export { shoppingCsv } from "./shopping.ts";
export { stlStats } from "./stl.ts";
export { detectSlicer, parseGcodeEstimate, MESH_METHOD } from "./print-plan.ts";
export { planSteps } from "./steps.ts";

export interface KitOptions {
  region?: Region;
  /** Put this store first where a part has it ("AliExpress"). */
  prefer?: string;
  /** "auto" (slice when PrusaSlicer is installed), "cached" (only earlier slices), "off". */
  slicer?: "auto" | "cached" | "off";
}

interface LayoutCache {
  hash: string;
  positions: Record<string, [number, number, number]>;
  bosses: number;
}

/** Pin positions from the case layout (the factory pack's wire lengths), cached per case hash in .jumper/kit-layout.json. */
async function casePositions(s: ProjectSession, report: CaseReport): Promise<LayoutCache | undefined> {
  const file = join(s.dir, ".jumper", "kit-layout.json");
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as LayoutCache;
      if (c.hash === report.hash) return c;
    } catch {
      // rebuilt below
    }
  }
  if (!s.project.enclosure) return undefined;
  const reg = s.registry;
  const { layoutCase } = await import("@jumper/enclosure");
  const L = layoutCase({ parts: s.project.parts.flatMap((p) => (reg.get(p.type) ? [{ id: p.id, type: p.type, spec: reg.get(p.type)!.spec }] : [])), enclosure: s.project.enclosure });
  const c: LayoutCache = { hash: report.hash, positions: pinPositions(L.placed, (t) => reg.get(t)?.spec), bosses: L.bosses.length };
  try {
    mkdirSync(join(s.dir, ".jumper"), { recursive: true });
    writeFileSync(file, JSON.stringify(c));
  } catch {
    // a read-only project still gets its kit
  }
  return c;
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function buildKit(s: ProjectSession, o: KitOptions = {}): Promise<BuildKit> {
  const project = s.project;
  const reg = s.registry;
  const region = o.region ?? "global";
  const caseDir = join(s.dir, "case");
  const missing: BuildKit["missing"] = [];
  let report: CaseReport | undefined;
  let stale: string | undefined;
  if (project.enclosure) {
    report = readJson<CaseReport>(join(caseDir, "report.json"));
    if (!report) missing.push({ item: "case files", why: "the case was designed but its files were never written (or were deleted)", fix: "get_case (it rebuilds them), then get_build_kit again", say: "open the Case view (it rebuilds the files), then open Build it again" });
    else {
      const { caseIsStale } = await import("../tools/case.ts");
      if (await caseIsStale(s)) {
        stale = "The case files are older than the project (a part or the case settings changed since): the print list and the places inside are for the old case. Open the Case view to rebuild them.";
        missing.push({ item: "up-to-date case files", why: "a part or the case settings changed since the case files were written", fix: "get_case (it rebuilds them), then get_build_kit again", say: "open the Case view (it rebuilds the files), then open Build it again" });
      }
    }
  } else missing.push({ item: "case", why: "the project has no case yet, so there is nothing to print and the parts are not placed", fix: 'design_case {"shape": "pebble"} (or any shape), then get_build_kit again', say: "open the Case view, pick a shape and press Design case" });
  const soldered = assemblyStyle(project, reg) === "soldered";
  // the case engine's assembly plan (get_assembly_plan's), only for a case that is current: a stale one is never used
  let plan: Awaited<ReturnType<typeof import("../tools/case.ts").assemblyPlanFor>> | undefined;
  if (report?.assembly && !stale && soldered) {
    try {
      plan = await (await import("../tools/case.ts")).assemblyPlanFor(s);
    } catch (e) {
      missing.push({ item: "assembly plan", why: `the case's assembly plan could not be read (${(e as Error).message.split("\n")[0]}), so the steps below are worked out from the case report instead`, fix: "get_assembly_plan (its error says what to change), then get_build_kit again", say: "open the Case view's Build tab to see why, then open Build it again" });
    }
  }
  const layout = report && !stale ? await casePositions(s, report) : undefined;
  // the plan's own cut list when there is one (its lengths include the open-like-a-book slack), else the wiring's
  const cuts: WireCut[] = plan ? plan.wires.map((w) => ({ wire: w.id, from: w.from, to: w.to, color: w.color.startsWith("#") ? colorName(w.color) : w.color, length_mm: w.length_mm, gauge_awg: w.gauge })) : wireCuts(project, reg, layout?.positions);
  const screwsOn = project.enclosure?.params?.closure === "screws";
  const screws = screwsOn ? { count: layout?.bosses || 4, size: "M2 x 6 mm pan head (length: enclosure PRINT.md)", inserts: "M2 x 3 mm brass heat-set insert" } : undefined;

  const has = (rel: string) => existsSync(join(caseDir, rel));
  const print = await printPlan({ caseDir, report, ...(stale ? { stale } : {}), slicer: o.slicer ?? "auto", cacheFile: join(s.dir, ".jumper", "kit-slicer.json") });
  const { specWithProps } = await import("@jumper/enclosure");
  const sizeOf = (type: string, props: Record<string, unknown> | undefined) => {
    const spec = reg.get(type)?.spec;
    if (!spec) return undefined;
    const w = specWithProps(spec, props);
    return w !== spec && w.mechanical?.source ? w.mechanical.source.split(";")[0]!.replace(/, typical\)/, ")") : undefined;
  };
  const fwText = firmwareText(s);
  const shopping = shoppingList({ project, registry: reg, soldered, cuts, region, sizeOf, ...(fwText !== undefined ? { firmwareText: fwText } : {}), ...(o.prefer ? { prefer: o.prefer } : {}), ...(screws ? { screws } : {}), ...(plan ? { consumables: plan.consumables.map((c) => ({ ...c, why: kitWords(c.why, {}).replace(/in the wire list below/g, "in the Assemble steps") })) } : {}), ...(print.items.length && print.process === "fdm" ? { filament: { grams: print.total_grams, material: "PLA", color: print.items[0]!.color } } : {}) });

  const built = s.firmwareState();
  const flash = flashPlan(project, reg, built);
  if (flash.why_missing && flash.method !== "none") missing.push({ item: "firmware file", why: flash.why_missing.split(":")[0]!.toLowerCase(), fix: "build (or run), then get_build_kit again", say: "press Run (or Build), then open Build it again" });
  const sd = sdCardFiles(project, reg);
  if (Object.keys(sd).length) {
    flash.steps.push("The sound clips: the download has sd-card/ with the words of each clip and make-clips.sh, which turns them into MP3 files (it needs espeak-ng or piper and ffmpeg, installed by you; or record the clips yourself). Copy them to a FAT32 microSD card in the order sd-card/CLIPS.md lists and put the card in its slot.");
  }

  const label = refLabel(project, reg);
  const steps = plan ? planSteps(plan.steps, { label, caseRel: "case", ref: refWords(project, reg), cells: new Set(project.parts.filter((p) => reg.get(p.type)?.spec.mechanical?.soft).map((p) => p.id)), jst: cellPlugs(project, reg), tests: project.scenarios.map((sc) => sc.name ?? sc.id) }) : derivedSteps({ project, registry: reg, report, cuts, estimatedCuts: !layout, soldered, screws: !!screws, flash, has });
  const cell = project.parts.some((p) => reg.get(p.type)?.spec.mechanical?.soft);
  const tools = toolsFor(project, reg, { soldered, hasCase: !!report, screws: !!screws, inserts: !!screws, printMinutes: print.total_minutes, steps, cell, ...(plan ? { planTools: plan.tools } : {}) });
  const drc = ((await s.checkDesign()) as { issues?: string[] }).issues ?? [];
  const fid = fidelityReport(project, reg);
  const { TOOLS } = await import("../catalog.ts");
  const toolNames = new Set([...TOOLS.map((t) => t.name), "remove"]);
  const trouble = troubleshooting(project, reg, { report, drc, fidelity: fid.testOnRealDevice, flash, soldered, tools: toolNames }).map((t) => ({ ...t, problem: kitWords(t.problem, { ref: refWords(project, reg) }), why: kitWords(t.why, { ref: refWords(project, reg) }), fix: kitWords(t.fix, { ref: refWords(project, reg) }) }));
  // the design check's errors and warnings about the circuit (not the case's assembly notes): things to fix or accept
  // before buying, so they lead the kit instead of hiding at the end of the troubleshooting table
  const check_first = drc
    .map((line) => /^(error|warning)\s+\[([^\]]+)\]\s+(.*)$/s.exec(line))
    .filter((m): m is RegExpExecArray => !!m && !/^(assembly|case)-/.test(m[2]!))
    .map((m) => ({ severity: m[1] as "error" | "warning", code: m[2]!, problem: m[2]!.replace(/-/g, " "), why: kitWords(m[3]!.replace(/\s*Fix:.*$/s, ""), { ref: refWords(project, reg) }), fix: kitWords(/Fix:\s*(.*)$/s.exec(m[3]!)?.[1] ?? "see the design check in Jumper", { ref: refWords(project, reg) }) }));
  for (const st of steps) {
    st.do = st.do.map((d) => peopleWords(d, toolNames));
    st.cautions = st.cautions.map((c) => peopleWords(c, toolNames));
    if (st.check) st.check = peopleWords(st.check, toolNames);
  }

  const connect = connectPlan(project, reg, s.dir);
  // Round 14: battery life from duty cycles (datasheet typicals), when the device has a LiPo cell
  const power = project.parts.some((p) => p.type === "lipo-battery") ? powerBudget(project, reg, firmwareText(s) ?? "") : undefined;
  const board = flash.board;
  const n = shopping.lines.filter((l) => l.section === "electronics" && l.refs).reduce((a, l) => a + l.qty, 0);
  const summary = `${project.name}: ${n} parts${board && board !== "no board" ? ` around a ${board}` : ""}, ${soldered ? "hand-soldered" : "on a breadboard"}${report ? `, in a printed ${report.shape} case ${report.size_mm.w} x ${report.size_mm.h} x ${report.size_mm.d} mm` : ""}. About ${shopping.to_buy_usd.toFixed(0)} USD of parts${print.items.length ? `, ${Math.round(print.total_grams)} g of filament (${(print.total_minutes / 60).toFixed(1)} h of printing)` : ""}, ${tools.time.build_h} h to build. ${tools.skill_why}`;
  return {
    project: project.name,
    style: soldered ? "soldered" : "breadboard",
    summary,
    ...(report ? { size_mm: report.size_mm } : {}),
    shopping,
    print,
    tools,
    steps,
    steps_source: plan ? "assembly-plan" : "derived",
    flash,
    ...(connect ? { connect } : {}),
    ...(power ? { power } : {}),
    ...(report?.held?.length ? { holds: report.held.map((x) => ({ id: x.id, name: x.name, object_mm: x.object_mm, room_mm: x.room_mm, clearance_mm: x.clearance_mm, ...(x.opening_mm ? { opening: `${x.opening_mm.w} x ${x.opening_mm.h} mm${x.opening_mm.shape === "round" ? " round" : ""} on the ${x.from}` } : {}), how: !x.removable ? "put in during assembly; it stays" : x.insert === "slide" ? `slides in from the ${x.from}` : x.insert === "snap" ? `snaps into the ${x.from}` : `drops into a pocket on the ${x.from}`, wall_mm: x.wall_mm, source: x.source, measure: x.measure })) } : {}),
    troubleshooting: trouble,
    missing,
    check_first,
    region,
  };
}
