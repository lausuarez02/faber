import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CASE_SHAPES, EnclosureSchema, type Enclosure, type Project } from "@jumper/project-format";
import type { CaseReport } from "@jumper/enclosure";
import { hexToUf2 } from "@jumper/sim-backends";
import { fail } from "../errors.ts";
import { wiringMarkdown } from "../exporter.ts";
import { fidelityReport } from "../fidelity.ts";
import { bomCsv, bomLines, bomMd, caseWireCuts, clearDir, copyTree, kicadNetlist, listFiles, netlistCsv, pinPositions, wireCutsCsv, writeText, zipFolder } from "../manufacturing.ts";
import { projectSlug } from "../projects-registry.ts";
import { loadPlaywright } from "../screenshot.ts";
import type { ProjectSession } from "../session.ts";
import { listVersions } from "../versions.ts";
import type { ToolModule } from "./types.ts";

/**
 * Round 6, track "case" (owner). Decision 0004, R3 to R6.
 * design_case / update_case / get_case / export_manufacturing. The enclosure config lives in
 * jumper.json (an undoable edit); the generated files in <project>/case/ are outputs, never in the
 * undo history, regenerated whenever the hash of the config + the parts' mechanical data changes.
 */

const CANNOT = "What the case cannot check: snap strength and fit on your printer (print the two shells first and test), real tolerances of clone modules (about ±1 mm), drop / water / heat, the route of each wire.";

const params = {
  type: "object",
  description: "Case parameters (all optional): wall_mm (≥ 1.2, default 1.6), corner_radius_mm (rounded-box / keychain, default 4), color ('#F2EDE4'), lanyard_hole (default true for keychain), belt_clip, closure ('snap' | 'screws' = M2 into heat-set inserts), tolerance_mm (default 0.2 FDM), process ('fdm' | 'resin' | 'injection'), gap_mm (wiring room around parts, default 1.5).",
  properties: {
    wall_mm: { type: "number", minimum: 1.2, maximum: 5 },
    corner_radius_mm: { type: "number", minimum: 0, maximum: 30 },
    color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    lanyard_hole: { type: "boolean" },
    belt_clip: { type: "boolean" },
    closure: { type: "string", enum: ["snap", "screws"] },
    tolerance_mm: { type: "number", minimum: 0, maximum: 1 },
    process: { type: "string", enum: ["fdm", "resin", "injection"] },
    gap_mm: { type: "number", minimum: 0, maximum: 10 },
  },
};
const placements = {
  type: "object",
  description: 'Per part id, where it goes: {"pet": {"face": "right", "y_mm": 4}, "bat": {"face": "inside"}}. face: front | back | left | right | top | bottom (as seen holding it, screen towards you) or inside (no opening); x_mm / y_mm from the centre of that face (+x right, +y up looking straight at it); rotation 0 / 90 / 180 / 270. Parts left out are auto-packed (screen front, USB bottom, buttons on the sides, buzzer grille at the back).',
  additionalProperties: true,
};
const why = { type: "string", description: "Short reason shown in the step list." };

export const caseTools: ToolModule = {
  name: "case",
  tools: [
    {
      name: "design_case",
      title: "Design a printable case",
      description: `Pack the project's parts into a two-part printable case and write everything needed to make it into <project>/case/: STL per body (front, back, button plungers, light pipes), case.3mf (coloured, for slicers), STEP (assembly with the parts as named solids, front, back: what factories ask for), renders (front / back / exploded / inside), an A3 drawing (SVG, PDF when Chromium is installed) with sizes, hole positions, tolerances, material and print settings, and PRINT.md. Shapes: "rounded-box", "pill", "pebble" (organic oval), "puck" (round), "keychain" (tab with a lanyard hole). Example: {"shape": "pebble"} or {"shape": "puck", "params": {"closure": "screws", "color": "#2B3038"}, "placements": {"pet": {"face": "left"}}}. Returns the CaseReport: size_mm (e.g. 63.1 x 55.2 x 32), inner_mm, pocket ("fits" ≤ 110 x 70 x 30 mm, "tight", "no"), ok, checks (fits, screen-window, buttons-reachable, connector-access, min-wall, printable, watertight, no-intersection, size-match), files, plus the front and exploded renders inline. save: false writes to case/variants/<shape>/ and leaves jumper.json alone (compare shapes). Takes 3 to 20 s (real CAD). ${CANNOT}`,
      inputSchema: {
        type: "object",
        properties: {
          shape: { type: "string", enum: [...CASE_SHAPES] },
          params,
          front: { type: "string", description: "Part id whose screen faces out of the front (default: the first display)." },
          placements,
          exclude: { type: "array", items: { type: "string" }, description: "Part ids that are not inside the case." },
          save: { type: "boolean", description: "Default true: store the case in jumper.json (undoable) and write case/. false: write case/variants/<shape>/ only." },
          images: { type: "boolean", description: "Default true: return the front and exploded renders inline." },
          why,
        },
        required: ["shape"],
      },
      edits: true,
    },
    {
      name: "update_case",
      title: "Change the case",
      description: `Change the existing case: any of shape, params, front, placements, exclude. params and placements are merged into what is there; a placement set to null is removed (back to auto-pack). Example: {"params": {"wall_mm": 2, "closure": "screws"}} or {"placements": {"pet": {"face": "top"}}} or {"shape": "puck"}. Regenerates every file in case/ and returns the CaseReport like design_case. Fails when there is no case yet (use design_case). ${CANNOT}`,
      inputSchema: {
        type: "object",
        properties: { shape: { type: "string", enum: [...CASE_SHAPES] }, params, front: { type: "string" }, placements, exclude: { type: "array", items: { type: "string" } }, images: { type: "boolean" }, why },
      },
      edits: true,
    },
    {
      name: "get_case",
      title: "Case report",
      description: "The current case's CaseReport (sizes, pocket verdict, checks, files). If a part, the wiring of the case config or an undo changed things since the files were written, it regenerates them first (stale: true in the answer). Does not change jumper.json. Fails when there is no case yet.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
    {
      name: "export_manufacturing",
      title: "Factory pack",
      description: 'Write the factory pack to <project>/manufacturing/<name>-v<version>/ and zip it: README.md for the supplier (what it is, how to build, flash and test), README.zh-CN.md (short summary), NOTES.md (honest limits: no PCB layout yet, hand-wired / perfboard; what was only simulated; what to verify on a real unit), BOM.csv (line, refs, qty, name, mpn, manufacturer, lcsc, jlc, package, generic, unit_usd, ext_usd, buy_url, source, notes) + BOM.md, electronics/ (WIRING.md, netlist.csv, jumper.net KiCad netlist, WIRE-CUTS.csv), firmware/ (firmware.hex, firmware.uf2 for RP2040, FLASHING.md, source/), enclosure/ (the case files), assembly/ASSEMBLY.md (numbered steps with the renders), test/ (TEST-PLAN.md from the scenarios, TEST-ON-HARDWARE.md), manifest.json (sha256 per file). Example: {} or {"zh_cn": false}. Returns {dir, zip, files, missing: [{item, why, fix}], notes, next}. Build the firmware and design_case first for a complete pack (missing[] says what is absent).',
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: 'Folder inside the project (default "manufacturing").' },
          zip: { type: "boolean", description: "Default true: also write <name>-v<version>.zip next to the folder." },
          zh_cn: { type: "boolean", description: "Default true: add README.zh-CN.md." },
          why,
        },
      },
    },
  ],
  ops: {
    async design_case(args, x) {
      const s = x.session;
      const enc = validateEnclosure(s, {
        shape: args.shape,
        ...(args.params ? { params: args.params } : {}),
        ...(args.front ? { front: args.front } : {}),
        ...(args.placements ? { placements: stripNulls(args.placements as Record<string, unknown>) } : {}),
        ...(args.exclude ? { exclude: args.exclude } : {}),
      });
      const save = args.save !== false;
      if (!save) {
        const out = await generateInto(s, { ...s.project, enclosure: enc }, join(s.dir, "case", "variants", enc.shape));
        x.summary(`case variant ${enc.shape}: ${fmtSize(out.report)} (${out.report.pocket})`);
        return answer(s, out, args.images !== false, `case/variants/${enc.shape}`, "Compare with get_case; make it the case with design_case {\"shape\": \"" + enc.shape + "\"} (save defaults to true).");
      }
      const step = x.commit(`design_case ${enc.shape}`, { ...s.project, enclosure: enc });
      const out = await generateInto(s, s.project, join(s.dir, "case"));
      x.summary(`case: ${enc.shape} ${fmtSize(out.report)}, ${out.report.ok ? "all checks ok" : `${out.report.checks.filter((c) => !c.ok && c.severity === "error").length} problem(s)`}`);
      return { step: step.id, ...answer(s, out, args.images !== false, "case", nextAfter(out.report)) };
    },
    async update_case(args, x) {
      const s = x.session;
      const cur = s.project.enclosure;
      if (!cur) fail("no-case", "No case yet", "update_case changes an existing case and this project has none (jumper.json has no enclosure)", 'design_case {"shape": "pebble"}');
      const merged: Record<string, unknown> = { ...cur };
      if (args.shape) merged.shape = args.shape;
      if (args.params) merged.params = { ...(cur.params ?? {}), ...(args.params as object) };
      if (args.front !== undefined) merged.front = args.front;
      if (args.exclude !== undefined) merged.exclude = args.exclude;
      if (args.placements) {
        const pl: Record<string, unknown> = { ...(cur.placements ?? {}) };
        for (const [k, v] of Object.entries(args.placements as Record<string, unknown>)) {
          if (v === null) delete pl[k];
          else pl[k] = { ...((pl[k] as object) ?? {}), ...(v as object) };
        }
        merged.placements = pl;
      }
      const enc = validateEnclosure(s, merged);
      const step = x.commit(`update_case`, { ...s.project, enclosure: enc });
      const out = await generateInto(s, s.project, join(s.dir, "case"));
      x.summary(`case: ${enc.shape} ${fmtSize(out.report)}, ${out.report.ok ? "all checks ok" : "has problems"}`);
      return { step: step.id, ...answer(s, out, args.images !== false, "case", nextAfter(out.report)) };
    },
    async get_case(_args, x) {
      const s = x.session;
      if (!s.project.enclosure) fail("no-case", "No case yet", "this project has no enclosure in jumper.json", 'design_case {"shape": "pebble"}');
      const st = await caseState(s);
      x.summary(`case: ${st.report.shape} ${fmtSize(st.report)}${st.regenerated ? " (regenerated)" : ""}`);
      return { ...compact(st.report), dir: join(s.dir, "case"), stale: st.regenerated, files: st.report.files.map((f) => f.path) };
    },
    async export_manufacturing(args, x) {
      const res = await exportManufacturing(x.session, { ...(typeof args.dir === "string" ? { dir: args.dir } : {}), zip: args.zip !== false, zh_cn: args.zh_cn !== false });
      x.summary(`factory pack: ${relative(x.session.dir, res.dir)} (${res.files.length} files${res.missing.length ? `, ${res.missing.length} missing` : ""})`);
      return res;
    },
  },
};

function stripNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
}

function validateEnclosure(s: ProjectSession, raw: Record<string, unknown>): Enclosure {
  if (!raw.shape || !CASE_SHAPES.includes(raw.shape as never)) fail("bad-arg", `Unknown case shape ${JSON.stringify(raw.shape)}`, `shapes are ${CASE_SHAPES.join(", ")}`, `pass one of them, e.g. {"shape": "pebble"}`);
  const r = EnclosureSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    const path = i.path.join(".");
    fail("bad-arg", `The case setting ${path || "(root)"} is not valid`, i.message, path.endsWith("wall_mm") ? "wall_mm must be at least 1.2 (FDM) and at most 5" : `check ${path} against design_case's input schema (get it with jumper tools --json)`);
  }
  const enc = r.data;
  const ids = new Set(s.project.parts.map((p) => p.id));
  const bad = [...(enc.front ? [enc.front] : []), ...Object.keys(enc.placements ?? {}), ...(enc.exclude ?? [])].filter((id) => !ids.has(id));
  if (bad.length) fail("unknown-part", `The case names ${bad.map((b) => `"${b}"`).join(", ")}, which ${bad.length > 1 ? "are" : "is"} not in the project`, `the parts are ${[...ids].join(", ")}`, "use those ids (get_project lists them)");
  return enc;
}

interface Out {
  report: CaseReport;
  dir: string;
  missing: { item: string; why: string; fix: string }[];
}

let pdfOk: boolean | undefined;
async function pdfFromSvg(svg: string): Promise<{ pdf?: Uint8Array; why?: string }> {
  if (process.env.JUMPER_CASE_PDF === "0" || pdfOk === false) return { why: pdfOk === false ? "Playwright's Chromium did not start earlier in this session" : "PDF output is turned off (JUMPER_CASE_PDF=0)" };
  const pw = loadPlaywright();
  if (!pw) return { why: "Playwright is not installed" };
  try {
    const browser = await pw.chromium.launch();
    try {
      const page = (await browser.newPage()) as unknown as { setContent(h: string): Promise<void>; pdf(o: object): Promise<Buffer> };
      await page.setContent(`<!doctype html><html><head><style>@page{size:420mm 297mm;margin:0}html,body{margin:0}</style></head><body>${svg}</body></html>`);
      const pdf = await page.pdf({ width: "420mm", height: "297mm", printBackground: true, pageRanges: "1" });
      pdfOk = true;
      return { pdf: new Uint8Array(pdf) };
    } finally {
      await browser.close();
    }
  } catch (e) {
    pdfOk = false;
    return { why: `Playwright's Chromium could not print (${(e as Error).message.split("\n")[0]})` };
  }
}

async function generateInto(s: ProjectSession, project: Project, caseDir: string): Promise<Out> {
  const { generateCase, writeCaseFiles, writeMeshCache } = await import("@jumper/enclosure");
  const g = await generateCase(project, (t) => s.registry.get(t)?.spec, { title: project.name, pdf: pdfFromSvg });
  writeCaseFiles(caseDir, g.files);
  if (caseDir === join(s.dir, "case")) writeMeshCache(join(s.dir, ".jumper", "case-mesh.json"), g.mesh);
  return { report: g.report, dir: caseDir, missing: g.missing };
}

/** The saved case, regenerated first when its files are stale (hash of config + parts' mechanical data). */
export async function caseState(s: ProjectSession): Promise<{ report: CaseReport; regenerated: boolean; missing: Out["missing"] }> {
  const { caseHash, readManifest, readReport } = await import("@jumper/enclosure");
  const caseDir = join(s.dir, "case");
  const hash = caseHash(s.project, (t) => s.registry.get(t)?.spec);
  const m = readManifest(caseDir);
  const report = readReport(caseDir);
  if (m && report && m.hash === hash) return { report, regenerated: false, missing: [] };
  const out = await generateInto(s, s.project, caseDir);
  return { report: out.report, regenerated: true, missing: out.missing };
}

export async function caseIsStale(s: ProjectSession): Promise<boolean> {
  if (!s.project.enclosure) return false;
  const { caseHash, readManifest } = await import("@jumper/enclosure");
  return readManifest(join(s.dir, "case"))?.hash !== caseHash(s.project, (t) => s.registry.get(t)?.spec);
}

function fmtSize(r: CaseReport): string {
  return `${r.size_mm.w} x ${r.size_mm.h} x ${r.size_mm.d} mm`;
}

function compact(r: CaseReport) {
  return { shape: r.shape, size_mm: r.size_mm, inner_mm: r.inner_mm, wall_mm: r.wall_mm, mass_g: r.mass_g, pocket: r.pocket, ok: r.ok, checks: r.checks, placed: r.placed, enclosure: r.enclosure, hash: r.hash, notes: r.notes };
}

function answer(s: ProjectSession, out: Out, images: boolean, rel: string, next: string) {
  const imgs = ["renders/front.png", "renders/exploded.png"].map((p) => join(out.dir, p)).filter((p) => existsSync(p));
  return { ...compact(out.report), dir: out.dir, files: out.report.files.map((f) => `${rel}/${f.path}`), ...(out.missing.length ? { missing: out.missing } : {}), ...(images ? { image_files: imgs } : {}), next };
}

function nextAfter(r: CaseReport): string {
  const bad = r.checks.filter((c) => !c.ok && c.severity === "error");
  if (bad.length) return `Fix: ${bad[0]!.message.split("Fix: ")[1] ?? "see checks"}`;
  return "Show the person the renders (case/renders/), then export_manufacturing for the factory pack. Try other shapes with design_case {save: false}.";
}

// ===================================================================== factory pack

export async function exportManufacturing(s: ProjectSession, args: { dir?: string; zip: boolean; zh_cn: boolean }) {
  const project = s.project;
  const reg = s.registry;
  const outRoot = resolve(s.dir, args.dir ?? "manufacturing");
  if (relative(s.dir, outRoot).startsWith("..")) fail("bad-arg", "The pack folder must be inside the project", `${outRoot} is outside ${s.dir}`, 'pass a folder name like "manufacturing"');
  const version = listVersions(s.dir).length || 1;
  const slug = projectSlug(project.name);
  const name = `${slug}-v${version}`;
  const root = join(outRoot, name);
  clearDir(root);
  const missing: { item: string; why: string; fix: string }[] = [];
  const notes: string[] = [];
  const board = project.parts.find((p) => p.id === project.firmware?.board) ?? project.parts.find((p) => reg.get(p.type)?.spec.mcu);
  const boardSpec = board ? reg.get(board.type)?.spec : undefined;
  const rp2040 = boardSpec?.mcu?.backend === "rp2040js";
  const pocketBoard = !!board && /xiao|zero/.test(board.type);
  const soldered = (project.assembly ?? (project.enclosure || pocketBoard ? "soldered" : "breadboard")) === "soldered";

  // ---- case
  let report: CaseReport | undefined;
  let screws: { count: number; size: string; inserts: string } | undefined;
  let positions: Record<string, [number, number, number]> | undefined;
  if (project.enclosure) {
    const st = await caseState(s);
    report = st.report;
    for (const m of st.missing) missing.push({ ...m, item: `enclosure/${m.item}` });
    copyTree(join(s.dir, "case"), join(root, "enclosure"), (rel) => rel.startsWith("variants") || rel.startsWith("."));
    if (existsSync(join(root, "enclosure", "drawing")) && !existsSync(join(root, "enclosure", "drawing", "drawing.pdf")) && !st.missing.length) missing.push({ item: "enclosure/drawing/drawing.pdf", why: "no PDF was printed when the case was generated (Playwright's Chromium was not available, or JUMPER_CASE_PDF=0)", fix: "pnpm --filter @jumper/web exec playwright install chromium, then design_case again (drawing.svg has the same drawing)" });
    const { layoutCase } = await import("@jumper/enclosure");
    const L = layoutCase({ parts: project.parts.flatMap((p) => (reg.get(p.type) ? [{ id: p.id, type: p.type, spec: reg.get(p.type)!.spec }] : [])), enclosure: project.enclosure });
    positions = pinPositions(L.placed, (t) => reg.get(t)?.spec);
    if (project.enclosure.params?.closure === "screws" && L.bosses.length) screws = { count: L.bosses.length, size: "M2 pan head (length in enclosure/PRINT.md)", inserts: "M2 x 3 mm brass heat-set inserts" };
  } else missing.push({ item: "enclosure/", why: "the project has no case yet", fix: 'design_case {"shape": "pebble"} (or puck, rounded-box, pill, keychain), then export_manufacturing again' });

  // ---- electronics
  const cuts = caseWireCuts(project, reg, positions);
  const lines = bomLines(project, reg, { soldered, cuts, ...(screws ? { screws } : {}) });
  writeText(root, "BOM.csv", bomCsv(lines));
  writeText(root, "BOM.md", bomMd(lines, project.name));
  writeText(root, "electronics/WIRING.md", wiringMarkdown(project, reg));
  writeText(root, "electronics/netlist.csv", netlistCsv(project));
  writeText(root, "electronics/jumper.net", kicadNetlist(project, reg));
  writeText(root, "electronics/WIRE-CUTS.csv", (positions ? "" : "") + wireCutsCsv(cuts));
  if (!positions) notes.push("Wire lengths are estimates from the part sizes (no case layout yet); design_case gives lengths from the real positions.");

  // ---- firmware
  const fw = project.firmware;
  let fwHash = "";
  if (fw) {
    const fwDir = join(s.dir, fw.dir ?? "firmware");
    copyTree(fwDir, join(root, "firmware", "source"), (rel) => /\.(hex|elf|bin|uf2|map)$/.test(rel) || rel.startsWith("build") || rel.startsWith("."));
    const art = fw.artifact ? join(s.dir, fw.artifact) : undefined;
    const st = (s as unknown as { firmwareState(): string }).firmwareState();
    if (art && existsSync(art) && st === "fresh") {
      const hex = readFileSync(art, "utf8");
      writeText(root, "firmware/firmware.hex", hex);
      fwHash = (await import("node:crypto")).createHash("sha256").update(hex).digest("hex").slice(0, 16);
      if (rp2040) writeText(root, "firmware/firmware.uf2", hexToUf2(hex));
    } else missing.push({ item: "firmware/firmware.hex", why: !art || !existsSync(art) ? "the firmware was never built" : "the sketch changed since the last build", fix: "build (or run) first, then export_manufacturing again" });
    writeText(root, "firmware/FLASHING.md", flashingMd(project.name, boardSpec?.name ?? board?.type ?? "the board", rp2040, fw.libraries ?? []));
  } else missing.push({ item: "firmware/", why: "the project has no firmware", fix: "write_file the sketch and build" });

  // ---- assembly, tests, readme, notes
  writeText(root, "assembly/ASSEMBLY.md", assemblyMd(project, reg, report, soldered, !!screws));
  writeText(root, "test/TEST-PLAN.md", testPlanMd(project));
  const fid = fidelityReport(project, reg);
  writeText(root, "test/TEST-ON-HARDWARE.md", `# Test these on the real device: ${project.name}\n\n${fid.summary}\n\n${fid.testOnRealDevice.map((t) => `- [ ] ${t}`).join("\n")}\n\n## Simulator limits\n\n${fid.global.map((g) => `- ${g}`).join("\n")}\n`);
  writeText(root, "README.md", readmeMd(project, boardSpec?.name ?? "", report, soldered, lines, missing));
  if (args.zh_cn) writeText(root, "README.zh-CN.md", readmeZh(project, boardSpec?.name ?? "", report));
  writeText(root, "NOTES.md", notesMd(project, reg, report, soldered, fid.summary));
  const files = listFiles(root);
  writeText(root, "manifest.json", JSON.stringify({ project: project.name, version, firmware_hash: fwHash, case_hash: report?.hash ?? "", files }, null, 2) + "\n");
  let zipPath: string | undefined;
  if (args.zip) {
    zipPath = join(outRoot, `${name}.zip`);
    writeFileSync(zipPath, zipFolder(root, name));
  }
  const all = [...files.map((f) => f.path), "manifest.json"];
  return {
    dir: root,
    ...(zipPath ? { zip: zipPath, zip_bytes: statSync(zipPath).size } : {}),
    files: all,
    missing,
    notes: [...notes, "No PCB layout yet: the pack describes a hand-wired (perfboard / point-to-point) build; jumper.net is a netlist a PCB designer can start from.", "LCSC / JLC numbers are only filled where checked; the supplier quotes the rest from the MPN or the description."],
    next: missing.length ? `Complete it: ${missing.map((m) => m.fix).join("; ")}` : `Send ${zipPath ?? root} to the supplier, or open README.md to build it yourself.`,
  };
}

function flashingMd(name: string, board: string, rp2040: boolean, libs: string[]): string {
  const lines = [`# Flashing ${name}`, "", `Board: **${board}**.`, ""];
  if (rp2040)
    lines.push("## Easiest: drag and drop (no software)", "", "1. Hold the **BOOT** (BOOTSEL) button on the board.", "2. Plug the USB-C cable into a computer while holding it; release. A drive called **RPI-RP2** appears.", "3. Copy `firmware.uf2` onto that drive. It disconnects and the device starts.", "", "## Command line", "", "```sh\npicotool load -x firmware.uf2\n```", "");
  else lines.push("## Command line (avrdude)", "", "```sh\navrdude -p m328p -c arduino -P <port> -b 115200 -U flash:w:firmware.hex:i\n```", "", "Or open `source/` in the Arduino IDE and press Upload.", "");
  lines.push("## Build from source", "", "The sketch is in `source/`. Arduino IDE or arduino-cli with the board package for this board" + (libs.length ? ` and these libraries: ${libs.join(", ")}` : "") + ".", "", "Some libraries are LGPL (for example Adafruit NeoPixel): a firmware binary you distribute that links one carries LGPL obligations (offer the object files or the source).", "");
  return lines.join("\n");
}

function assemblyMd(project: Project, reg: ProjectSession["registry"], report: CaseReport | undefined, soldered: boolean, screws: boolean): string {
  const steps: string[] = [];
  const img = (n: string) => (report ? `\n\n   ![${n}](../enclosure/renders/${n}.png)` : "");
  if (report) steps.push(`Print the case: \`enclosure/PRINT.md\` (front and back shells${report.files.some((f) => f.path.includes("cap-")) ? ", button plungers" : ""}${report.files.some((f) => f.path.includes("light-pipe")) ? ", light pipes" : ""}). Test-fit the two shells before anything else.`);
  if (screws) steps.push("Press the M2 heat-set inserts into the front shell's bosses with a soldering iron at about 220 °C; let them cool.");
  steps.push("Flash the firmware on the bare board first (`firmware/FLASHING.md`) and check it boots (serial output or the screen).");
  if (soldered) steps.push("Cut and strip the wires listed in `electronics/WIRE-CUTS.csv` (lengths include 10 mm to strip and some slack). Tin every end.");
  steps.push(`${soldered ? "Solder" : "Wire"} every connection in \`electronics/WIRING.md\` (the same nets are in \`netlist.csv\`). Power wires (24 AWG) first, then signals; heat-shrink every splice.`);
  steps.push("Bench test before closing: power it from USB and run through `test/TEST-PLAN.md`.");
  if (report) {
    const placed = [...report.placed].sort((a, b) => a.layer - b.layer);
    const named = (id: string) => {
      const p = project.parts.find((x) => x.id === id);
      return `${id} (${reg.get(p?.type ?? "")?.spec.name ?? p?.type})`;
    };
    steps.push(`Fit the parts, front to back, into the front shell (looking at its inside):${placed.map((p) => `\n   - ${named(p.id)}: layer ${p.layer}, its top faces the ${p.facing}${p.facing !== "front" && p.facing !== "back" ? " wall (its opening is there)" : ""}.`).join("")}${img("inside")}`);
    steps.push("Put the button plungers / light pipes into their holes from the inside before the parts behind them. Hold modules with no standoff with 1 mm foam tape; keep wires away from the seam so the lip closes.");
    if (report.placed.some((p) => project.parts.find((x) => x.id === p.id)?.type === "lipo-battery")) steps.push("Place the LiPo cell in its cradle on the back shell last. Never press, bend or pierce it; plug its connector in only after all soldering is done.");
    steps.push(`Close the case: ${screws ? "M2 screws from the back into the inserts, finger tight" : "press the front onto the back all round until the lip clicks"}.${img("exploded")}`);
  }
  steps.push("Final test: `test/TEST-PLAN.md` again, then the checks in `test/TEST-ON-HARDWARE.md`.");
  return `# Assembly: ${project.name}\n\n${soldered ? "Hand-wired build (point-to-point or perfboard): no breadboard, no dupont wires." : "Breadboard build."}\n\n${steps.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n`;
}

function stepText(st: Record<string, unknown>): string {
  const w = st.within_ms ? ` within ${(Number(st.within_ms) / 1000).toFixed(1)} s` : "";
  if (st.run_ms !== undefined) return `wait ${(Number(st.run_ms) / 1000).toFixed(1)} s`;
  if (st.press) return `press ${st.press}${st.hold_ms ? ` for ${st.hold_ms} ms` : ""}`;
  if (st.set) return `make ${st.set} = ${st.value} (${String(st.set).split(".")[1]}: tilt / shake / set the sensor like that)`;
  if (st.expect_serial) return `${st.absent ? "check the serial monitor does NOT show" : "the serial monitor shows"} "${st.expect_serial}"${w}`;
  if (st.expect_serial_value) return `the serial value ${st.expect_serial_value} is ${st.op} ${st.value}${w}`;
  if (st.expect_display) return `the screen ${st.expect_display} lights up${st.region ? " in the area under test" : ""}${w}`;
  if (st.expect_part) return `${st.expect_part} ${st.op} ${st.value}${w} (watch / listen for it)`;
  if (st.expect_pin) return `pin ${st.expect_pin} reads ${st.value ?? st.state}${w}`;
  return JSON.stringify(st);
}

function testPlanMd(project: Project): string {
  const out = [`# Test plan: ${project.name}`, "", "Each test passed in Jumper's simulator. Repeat it on the real unit; tick when it behaves the same.", ""];
  if (!project.scenarios.length) out.push("No scenarios were written. Power it up and check every function by hand.");
  for (const sc of project.scenarios) {
    out.push(`## ${sc.name ?? sc.id}`, "");
    (sc.steps as Record<string, unknown>[]).forEach((st, i) => out.push(`${i + 1}. [ ] ${stepText(st)}`));
    out.push("");
  }
  return out.join("\n") + "\n";
}

function readmeMd(project: Project, board: string, report: CaseReport | undefined, soldered: boolean, lines: { qty: number; name: string }[], missing: { item: string }[]): string {
  return `# ${project.name}: build pack

${project.description ?? `A small ${soldered ? "hand-wired" : "breadboard"} electronic device${board ? ` built on a ${board}` : ""}.`}

## What is inside

${lines.filter((l) => l.name).map((l) => `- ${l.qty} x ${l.name}`).join("\n")}
${report ? `\nCase: **${report.shape}**, ${report.size_mm.w} x ${report.size_mm.h} x ${report.size_mm.d} mm, ${report.wall_mm} mm wall, 3D printed (${report.enclosure.params?.process ?? "fdm"}).\n` : ""}
## How to make one

1. Buy the parts in \`BOM.csv\` (MPN where known, otherwise the description in "generic").
2. Print the case: \`enclosure/PRINT.md\` (STL / 3MF for printers, STEP for factories, drawing with all sizes).
3. Flash the firmware: \`firmware/FLASHING.md\`.
4. Build it: \`assembly/ASSEMBLY.md\` (wiring in \`electronics/\`).
5. Test it: \`test/TEST-PLAN.md\`.

## Files

| Folder | What |
| --- | --- |
| BOM.csv, BOM.md | parts, quantities, MPNs, prices |
| electronics/ | WIRING.md, netlist.csv, jumper.net (KiCad netlist), WIRE-CUTS.csv |
| firmware/ | firmware.hex${board.includes("RP2040") || board.includes("Pico") ? ", firmware.uf2" : ""}, FLASHING.md, source/ |
| enclosure/ | stl/, case.3mf, step/, drawing/, renders/, PRINT.md |
| assembly/ | ASSEMBLY.md |
| test/ | TEST-PLAN.md, TEST-ON-HARDWARE.md |

Read \`NOTES.md\` before quoting: it lists what was only simulated and what to verify on the first unit.${missing.length ? `\n\n**Not in this pack yet:** ${missing.map((m) => m.item).join(", ")}.` : ""}
`;
}

function readmeZh(project: Project, board: string, report: CaseReport | undefined): string {
  return `# ${project.name}：生产资料包（摘要）

这是一个小型电子设备${board ? `（主控板：${board}）` : ""}，手工焊接（无 PCB），外壳为 3D 打印${report ? `（${report.shape}，${report.size_mm.w} x ${report.size_mm.h} x ${report.size_mm.d} mm，壁厚 ${report.wall_mm} mm）` : ""}。

## 内容

- BOM.csv：物料清单（数量、型号 MPN、通用描述、参考单价）
- electronics/：接线表 WIRING.md、网表 netlist.csv 与 jumper.net（KiCad）、导线下料表 WIRE-CUTS.csv
- firmware/：固件（.hex / .uf2）、源代码、烧录步骤 FLASHING.md
- enclosure/：外壳 STL 与 3MF（3D 打印）、STEP（报价与开模）、尺寸图（SVG / PDF）、打印说明 PRINT.md
- assembly/ASSEMBLY.md：装配步骤（含渲染图）
- test/：测试计划

## 注意

- 目前没有 PCB 设计：按接线表手工接线（洞洞板 / 飞线）。jumper.net 可作为 PCB 设计的起点。
- 功能只在仿真中验证过：请先做一台样机，按 test/TEST-PLAN.md 逐项检查。
- 外壳尺寸基于模块的典型尺寸，不同厂家的模块可能相差约 1 mm，请用实物核对屏幕窗口和 USB 开孔。
- LCSC 编号只填写已核实的；其余请按型号或描述报价。

完整说明见英文 README.md。
`;
}

function notesMd(project: Project, reg: ProjectSession["registry"], report: CaseReport | undefined, soldered: boolean, fidSummary: string): string {
  const flagged = project.parts.filter((p) => p.standIn || reg.get(p.type)?.fidelity.origin === "agent-made");
  return `# Honest notes: ${project.name}

## Not designed yet

- **No PCB layout.** This is a ${soldered ? "hand-wired build (point-to-point or perfboard)" : "breadboard build"}. \`electronics/jumper.net\` is a netlist a PCB designer can import into KiCad to start one; no footprints or placement were chosen.
- No certification work (CE / FCC / UKCA), no ESD or EMC design.

## Only simulated

- ${fidSummary}
- The tests in \`test/TEST-PLAN.md\` passed in Jumper's simulator, which runs the real compiled firmware against models of the parts; real parts can differ (timing, noise, clone chips).
${flagged.map((p) => `- **${p.id}**: ${p.standIn ? `simulated with a stand-in for the real ${p.standIn}` : "agent-made part (behavioral, unverified)"}: check its wiring against the real datasheet.`).join("\n")}

## Case

${report ? report.notes.map((n) => `- ${n}`).join("\n") : "- No case was designed."}
${report ? `- Checks at design time: ${report.checks.map((c) => `${c.id} ${c.ok ? "ok" : c.severity}`).join(", ")}.` : ""}

## Verify on the first real unit

- [ ] The screen window lines up with the real display and the bezel is hidden.
- [ ] USB plugs reach their sockets fully through the case openings.
- [ ] Buttons click through their plungers with the case closed.
- [ ] The case closes without pinching wires; nothing presses on the battery.
- [ ] Battery life and charging match the plan (charge current set for the cell).
- [ ] Every line of \`test/TEST-PLAN.md\` and \`test/TEST-ON-HARDWARE.md\`.
`;
}

/** Meshes for the web Case view (R6 GET /api/case/mesh): from the cache, rebuilt when it is missing or stale. */
export async function caseMesh(s: ProjectSession): Promise<{ mesh: import("@jumper/enclosure").CaseMesh; regenerated: boolean; report: CaseReport }> {
  const st = await caseState(s);
  const { readMeshCache, generateCase, writeMeshCache } = await import("@jumper/enclosure");
  const file = join(s.dir, ".jumper", "case-mesh.json");
  const cached = readMeshCache(file, st.report.hash);
  if (cached) return { mesh: cached, regenerated: st.regenerated, report: st.report };
  const g = await generateCase(s.project, (t) => s.registry.get(t)?.spec, { renders: false });
  writeMeshCache(file, g.mesh);
  return { mesh: g.mesh, regenerated: st.regenerated, report: st.report };
}
