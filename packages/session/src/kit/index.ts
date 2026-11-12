/**
 * Round 12, track kit: the build kit for any project (get_build_kit, GET /api/kit, the web "Build
 * it" panel, and build-kit/ in the factory pack). Read-only: it never rebuilds the case or the
 * firmware; what is stale or missing is said, with the fix.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { CaseReport } from "@jumper/enclosure";
import { assemblyStyle, wireCuts, type WireCut } from "../assembly.ts";
import { fidelityReport } from "../fidelity.ts";
import { pinPositions } from "../manufacturing.ts";
import type { ProjectSession } from "../session.ts";
import { sdCardFiles } from "../voice.ts";
import { printPlan } from "./print-plan.ts";
import { shoppingList, type Region } from "./shopping.ts";
import { adaptAssemblyPlan, derivedSteps, flashPlan, peopleWords, planFrom, refLabel, toolsFor, troubleshooting } from "./steps.ts";
import type { BuildKit } from "./types.ts";

export type { BuildKit } from "./types.ts";
export { kitCsv, kitHtml, kitMarkdown, printListMd, shoppingMd } from "./render.ts";
export { shoppingCsv } from "./shopping.ts";
export { stlStats } from "./stl.ts";
export { detectSlicer, parseGcodeEstimate, MESH_METHOD } from "./print-plan.ts";
export { adaptAssemblyPlan, planFrom, type AssemblyPlanLike } from "./steps.ts";

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
  const layout = report && !stale ? await casePositions(s, report) : undefined;
  const cuts: WireCut[] = wireCuts(project, reg, layout?.positions);
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
  const shopping = shoppingList({ project, registry: reg, soldered, cuts, region, sizeOf, ...(o.prefer ? { prefer: o.prefer } : {}), ...(screws ? { screws } : {}), ...(print.items.length && print.process === "fdm" ? { filament: { grams: print.total_grams, material: "PLA", color: print.items[0]!.color } } : {}) });

  const built = s.firmwareState();
  const flash = flashPlan(project, reg, built);
  if (flash.why_missing && flash.method !== "none") missing.push({ item: "firmware file", why: flash.why_missing.split(":")[0]!.toLowerCase(), fix: "build (or run), then get_build_kit again", say: "press Run (or Build), then open Build it again" });
  const sd = sdCardFiles(project, reg);
  if (Object.keys(sd).length) {
    flash.steps.push("The sound clips: the download has sd-card/ with the words of each clip and make-clips.sh, which turns them into MP3 files (it needs espeak-ng or piper and ffmpeg, installed by you; or record the clips yourself). Copy them to a FAT32 microSD card in the order sd-card/CLIPS.md lists and put the card in its slot.");
  }

  const label = refLabel(project, reg);
  const plan = report && !stale ? planFrom(report, readJson(join(caseDir, "assembly.json")), (rel) => (relative(caseDir, join(caseDir, rel)).startsWith("..") ? undefined : readJson(join(caseDir, rel)))) : undefined;
  const steps = plan ? adaptAssemblyPlan(plan, { cuts, label, caseRel: "case" }) : derivedSteps({ project, registry: reg, report, cuts, estimatedCuts: !layout, soldered, screws: !!screws, flash, has });
  const cell = project.parts.some((p) => reg.get(p.type)?.spec.mechanical?.soft);
  const tools = toolsFor(project, reg, { soldered, hasCase: !!report, screws: !!screws, inserts: !!screws, printMinutes: print.total_minutes, steps, cell });
  const drc = ((await s.checkDesign()) as { issues?: string[] }).issues ?? [];
  const fid = fidelityReport(project, reg);
  const { TOOLS } = await import("../catalog.ts");
  const toolNames = new Set([...TOOLS.map((t) => t.name), "remove"]);
  const trouble = troubleshooting(project, reg, { report, drc, fidelity: fid.testOnRealDevice, flash, soldered, tools: toolNames });
  for (const st of steps) {
    st.do = st.do.map((d) => peopleWords(d, toolNames));
    st.cautions = st.cautions.map((c) => peopleWords(c, toolNames));
    if (st.check) st.check = peopleWords(st.check, toolNames);
  }

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
    troubleshooting: trouble,
    missing,
    region,
  };
}
