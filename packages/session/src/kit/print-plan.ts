/**
 * Round 12, track kit: the print list. Every printable body of the case (from the case report) with
 * its material, colour, orientation, supports, layer height, infill, and an estimate of the grams
 * and the time, plus what to send a print service. The estimate comes from the mesh with a
 * documented formula (MESH_METHOD); when PrusaSlicer is installed on this computer (never bundled:
 * it is AGPL) it can slice the STL instead and Faber reads its own numbers from the G-code.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { CaseFile, CaseReport } from "@faber/enclosure";
import { stlStats } from "./stl.ts";
import type { PrintItem, PrintPlan } from "./types.ts";

/** FDM numbers behind the estimate (also in MESH_METHOD, which the kit shows). */
export const FDM = { skin_mm: 1.0, flow_mm3_s: 4, layer_s: 3, waste: 1.05, infill: 0.2 };
export const MESH_METHOD =
  "Estimated from each STL's mesh: the walls and the top / bottom skins print solid (about 1 mm under every surface: area x 1 mm, never more than the volume), the rest at the infill; grams = printed volume x the material's density x 1.05 (brim and purge); time = printed volume / 4 mm³ per second (a typical printer at 0.2 mm layers) + 3 s per layer for travel and layer changes. A fast printer (Bambu, Prusa MK4 / Core One) takes about half that; your slicer gives the exact numbers.";
export const RESIN_METHOD = "Estimated from each STL's mesh: resin volume = the solid volume x 1.1 (supports), 1.1 g per ml; time = layers x 8 s at 0.05 mm (bodies on one plate print together, so the plate takes as long as its tallest body).";

const DENSITY: Record<string, number> = { PLA: 1.24, PETG: 1.27, "clear PETG": 1.27, "tough resin": 1.1 };

/** Common filament colours, to name a case colour. */
const COLOURS: [string, number, number, number][] = [
  ["white", 255, 255, 255], ["ivory", 242, 237, 228], ["beige", 222, 205, 170], ["light grey", 200, 203, 207], ["silver", 192, 196, 200], ["grey", 128, 128, 128], ["dark grey", 64, 66, 70], ["black", 30, 32, 36],
  ["red", 210, 40, 40], ["orange", 245, 130, 30], ["yellow", 245, 215, 50], ["lime", 160, 220, 60], ["green", 40, 160, 80], ["mint", 150, 230, 200], ["teal", 20, 140, 140], ["sky blue", 120, 190, 240], ["blue", 40, 90, 200], ["navy", 25, 40, 90],
  ["purple", 130, 70, 190], ["lilac", 200, 170, 230], ["pink", 245, 160, 190], ["magenta", 210, 40, 140], ["brown", 120, 75, 40], ["gold", 212, 175, 55],
];

export function colourName(hex: string | undefined): string {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return "any colour";
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  let best = COLOURS[0]!;
  let bd = Infinity;
  for (const c of COLOURS) {
    const d = (c[1] - r) ** 2 + (c[2] - g) ** 2 + (c[3] - b) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best[0];
}

/** "front" → "Front shell", "cap-pet" → "Button cap for pet". */
export function bodyLabel(body: string): string {
  if (body === "front") return "Front shell";
  if (body === "back") return "Back shell";
  if (body.startsWith("cap-")) return `Button cap for ${body.slice(4)}`;
  if (body.startsWith("light-pipe-")) return `Light pipe for ${body.slice(11)}`;
  if (body === "belt-clip") return "Belt clip";
  return body.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function materialFor(process: string, body: string): string {
  if (process === "resin") return "tough resin";
  if (body.startsWith("light-pipe-")) return "clear PETG";
  if (body === "belt-clip") return "PETG";
  return "PLA";
}

function orientationWords(p: CaseFile["print"]): string {
  if (!p) return "as the file lies (flat side down)";
  if (p.note) return p.note;
  return p.face_down === "front" ? "front face on the bed, open side up" : p.face_down === "back" ? "back face on the bed, open side up" : p.face_down === "flat" ? "on its flat side" : "as the file lies";
}

export interface Slicer {
  name: string;
  path: string;
  /** Faber can drive its command line (PrusaSlicer); others are only detected. */
  cli: boolean;
}

/** PrusaSlicer / OrcaSlicer installed on this computer (FABER_SLICER points at one; FABER_SLICER=none turns it off). */
export function detectSlicer(env: NodeJS.ProcessEnv = process.env): Slicer | undefined {
  const forced = env.FABER_SLICER;
  if (forced === "none" || forced === "0") return undefined;
  if (forced) return existsSync(forced) ? { name: /orca/i.test(forced) ? "OrcaSlicer" : "PrusaSlicer", path: forced, cli: !/orca/i.test(forced) } : undefined;
  const cands: Slicer[] = [
    { name: "PrusaSlicer", path: "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer", cli: true },
    { name: "PrusaSlicer", path: "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe", cli: true },
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((d) => [{ name: "PrusaSlicer", path: join(d, "prusa-slicer"), cli: true }, { name: "PrusaSlicer", path: join(d, "PrusaSlicer"), cli: true }]),
    { name: "OrcaSlicer", path: "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer", cli: false },
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => ({ name: "OrcaSlicer", path: join(d, "orca-slicer"), cli: false })),
  ];
  return cands.find((c) => existsSync(c.path));
}

/** Parse PrusaSlicer's G-code footer: "; estimated printing time (normal mode) = 1h 2m 3s", "; filament used [g] = 12.3". */
export function parseGcodeEstimate(gcode: string): { minutes: number; grams: number } | undefined {
  const t = /;\s*estimated printing time(?: \(normal mode\))?\s*=\s*([^\n]+)/i.exec(gcode)?.[1];
  const g = /;\s*(?:total )?filament used \[g\]\s*=\s*([0-9.]+)/i.exec(gcode)?.[1];
  if (!t || !g) return undefined;
  let s = 0;
  for (const m of t.matchAll(/(\d+)\s*([dhms])/g)) s += Number(m[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[m[2]!]!;
  return { minutes: Math.round(s / 60), grams: Math.round(Number(g) * 10) / 10 };
}

function sliceOnce(slicer: Slicer, stl: string, o: { layer: number; infill: number; walls: number; material: string }, timeoutMs: number): Promise<{ minutes: number; grams: number } | { error: string }> {
  const dir = mkdtempSync(join(tmpdir(), "faber-slice-"));
  const out = join(dir, "out.gcode");
  const args = ["--export-gcode", "--layer-height", String(o.layer), "--first-layer-height", "0.2", "--fill-density", `${Math.round(o.infill * 100)}%`, "--perimeters", String(o.walls), "--top-solid-layers", "5", "--bottom-solid-layers", "5", "--filament-type", o.material.includes("PETG") ? "PETG" : "PLA", "--filament-density", String(DENSITY[o.material] ?? 1.24), "--output", out, stl];
  return new Promise((res) => {
    execFile(slicer.path, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, _so, se) => {
      try {
        if (err && !existsSync(out)) return res({ error: `${slicer.name} did not slice ${stl.split(/[\\/]/).pop()}: ${(se || err.message).split("\n").filter(Boolean).slice(-1)[0] ?? err.message}` });
        const r = parseGcodeEstimate(readFileSync(out, "utf8"));
        res(r ?? { error: `${slicer.name}'s G-code has no time / filament estimate` });
      } catch (e) {
        res({ error: (e as Error).message });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

export interface PrintPlanInput {
  caseDir: string;
  report: CaseReport | undefined;
  /** Why the case files are not current (stale), shown with the list. */
  stale?: string;
  /** "auto" slices when a slicer with a command line is found (results cached), "cached" uses only earlier slices, "off" never. */
  slicer: "auto" | "cached" | "off";
  /** Where slicer results are cached (.faber/kit-slicer.json). */
  cacheFile?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function printPlan(inp: PrintPlanInput): Promise<PrintPlan> {
  const r = inp.report;
  const proc = (r?.enclosure.params?.process ?? "fdm") as PrintPlan["process"];
  const found = inp.slicer === "off" ? undefined : detectSlicer(inp.env);
  const slicerInfo: PrintPlan["slicer"] = found ? { found: true, name: found.name, path: found.path, used: false } : { found: false, used: false };
  if (found && !found.cli) slicerInfo.why = `${found.name} is installed, but Faber drives only PrusaSlicer's command line: the numbers are estimated from the meshes (open case.3mf in ${found.name} for its own)`;
  if (!r) {
    return { process: "none", items: [], total_grams: 0, total_minutes: 0, method: MESH_METHOD, slicer: slicerInfo, service: { files: [], material: "", say: [] }, settings: [], ...(inp.stale ? { stale: inp.stale } : {}) };
  }
  let cache: Record<string, { minutes: number; grams: number }> = {};
  if (inp.cacheFile && existsSync(inp.cacheFile)) {
    try {
      cache = JSON.parse(readFileSync(inp.cacheFile, "utf8"));
    } catch {
      cache = {};
    }
  }
  let cacheChanged = false;
  const colorHex = typeof r.enclosure.params?.color === "string" ? r.enclosure.params.color : undefined;
  const items: PrintItem[] = [];
  const stls = r.files.filter((f) => f.kind === "stl");
  for (const f of stls) {
    const material = materialFor(proc, f.body);
    const noteLayer = /([0-9.]+)\s*mm layers/.exec(f.print?.note ?? "")?.[1];
    const layer = proc === "resin" ? 0.05 : noteLayer ? Number(noteLayer) : f.body === "front" || f.body === "back" || f.body === "belt-clip" ? 0.2 : 0.12;
    const infill = proc === "resin" ? 1 : f.body.startsWith("cap-") || f.body.startsWith("light-pipe-") ? 1 : FDM.infill;
    const walls = proc === "resin" ? 0 : 4;
    const density = DENSITY[material] ?? 1.24;
    const abs = join(inp.caseDir, f.path);
    const base = { file: f.path, body: f.body, label: bodyLabel(f.body), material, color: f.body.startsWith("light-pipe-") ? "clear" : colourName(colorHex), ...(colorHex && !f.body.startsWith("light-pipe-") ? { color_hex: colorHex } : {}), orientation: orientationWords(f.print), supports: f.print?.supports ?? false, layer_mm: layer, infill_pct: Math.round(infill * 100), walls };
    if (!existsSync(abs)) {
      // no mesh: the case report's solid mass of the shells, shared by the two shells
      const share = r.mass_g && (f.body === "front" || f.body === "back") ? r.mass_g / 2 : 0;
      items.push({ ...base, grams: Math.round(share * 10) / 10, minutes: 0, source: share ? "report" : "none", note: `the file is missing (${f.path}): open the Case view to rebuild the case files` });
      continue;
    }
    const bytes = readFileSync(abs);
    const st = stlStats(bytes);
    const V = st.volume_mm3;
    const H = st.max[2] - st.min[2];
    let grams: number;
    let minutes: number;
    if (proc === "resin") {
      grams = (V * 1.1 * 1.1) / 1000;
      minutes = (Math.ceil(H / layer) * 8) / 60;
    } else {
      const solid = Math.min(V, st.area_mm2 * FDM.skin_mm);
      const printed = solid + infill * (V - solid);
      grams = (printed / 1000) * density * FDM.waste;
      minutes = (printed / FDM.flow_mm3_s + Math.ceil(H / layer) * FDM.layer_s) / 60;
    }
    let source = "mesh";
    if (found?.cli && proc !== "resin" && inp.slicer !== "off") {
      const key = `${found.name}|${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}|${layer}|${infill}|${walls}|${material}`;
      let sliced = cache[key];
      if (!sliced && inp.slicer === "auto") {
        const res = await sliceOnce(found, abs, { layer, infill, walls, material }, inp.timeoutMs ?? 120_000);
        if ("error" in res) slicerInfo.why = res.error;
        else {
          sliced = res;
          cache[key] = res;
          cacheChanged = true;
        }
      }
      if (sliced) {
        grams = sliced.grams;
        minutes = sliced.minutes;
        source = `slicer:${found.name}`;
        slicerInfo.used = true;
      } else if (inp.slicer === "cached" && !slicerInfo.why) slicerInfo.why = `${found.name} is installed: ask for the build kit from your agent (or download it) to slice with it; until then the numbers are estimated from the meshes`;
    }
    items.push({ ...base, grams: Math.round(grams * 10) / 10, minutes: Math.max(1, Math.round(minutes)), volume_cm3: Math.round(V / 100) / 10, height_mm: Math.round(H * 10) / 10, size_mm: [0, 1, 2].map((k) => Math.round((st.max[k]! - st.min[k]!) * 10) / 10) as [number, number, number], source });
  }
  if (cacheChanged && inp.cacheFile) {
    mkdirSync(dirname(inp.cacheFile), { recursive: true });
    writeFileSync(inp.cacheFile, JSON.stringify(cache, null, 2));
  }
  const plate = r.files.find((f) => f.kind === "3mf")?.path;
  const total_minutes = proc === "resin" ? Math.max(0, ...items.map((i) => i.minutes)) : items.reduce((a, i) => a + i.minutes, 0);
  const total_grams = Math.round(items.reduce((a, i) => a + i.grams, 0) * 10) / 10;
  const mainMat = proc === "resin" ? "tough resin (SLA)" : items.some((i) => i.material !== "PLA") ? `PLA (or PETG) for the shells${items.filter((i) => i.material !== "PLA").map((i) => `, ${i.material} for the ${i.label.toLowerCase()}`).join("")}` : "PLA (or PETG for a tougher case)";
  const colour = colourName(colorHex);
  const service = {
    files: items.map((i) => `case/${i.file}`),
    material: mainMat,
    say: [
      `Upload the STL files one by one (one body per file): ${items.map((i) => i.file.split("/").pop()).join(", ")}. Quantity 1 each. Do not upload the STEP files for a 3D print; they are for CAD and factories.`,
      proc === "resin" ? "Ask for SLA resin (a standard or tough grade); the files already have 0.1 mm clearances." : `Ask for FDM ${mainMat} in ${colour}${colorHex ? ` (${colorHex})` : ""}, 0.2 mm layers, 20 % infill, 4 walls; or SLA resin for a smoother finish (the 0.2 mm clearances still fit).`,
      "JLC3DP (jlc3dp.com) prints and ships from China in about a week; Craftcloud (craftcloud3d.com) compares local print shops' prices for the same files.",
      "Tell them the face on the bed for each body (the table above) if they ask; the files are already in that orientation.",
    ],
  };
  const settings =
    proc === "resin"
      ? ["Layer 0.05 mm, tough resin; supports only on the inside faces.", "Wash in IPA and post-cure 30 to 60 min."]
      : ["Nozzle 0.4 mm, 0.2 mm layers (0.12 mm for small caps and light pipes).", "4 walls (the case walls print solid), 20 % gyroid infill, 5 top and bottom layers.", "No supports unless the table says so: every file already lies in its print orientation. Brim 3 mm on rounded shells.", "Print the front and back shells first and test the fit before the small parts."];
  return {
    process: proc,
    items,
    ...(plate ? { plate } : {}),
    total_grams,
    total_minutes,
    method: slicerInfo.used ? `Sliced with ${found!.name} on this computer (its own G-code estimate).${items.some((i) => i.source === "mesh") ? ` Bodies it did not slice: ${MESH_METHOD}` : ""}` : proc === "resin" ? RESIN_METHOD : MESH_METHOD,
    slicer: slicerInfo,
    service,
    settings,
    ...(inp.stale ? { stale: inp.stale } : {}),
  };
}
