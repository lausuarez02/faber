// Visual test report for a project folder: runs every scenario with runScenarioVisual and returns
// (or writes) a fabwright-visual-report/1 JSON that the web app's Tests panel shows as filmstrips.
//
//   node --import tsx packages/session/src/visual-report.ts <project dir> [out.json] [--scenario id]
//
// The web app reads apps/web/public/reports/<example>.json (written by this for the examples) or a
// report handed to it by the fabwright server (GET /api/visual-report, the session's latest run_tests).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProject, type Project } from "@fabwright/project-format";
import { registry as defaultRegistry } from "@fabwright/parts";
import type { PartRegistry } from "@fabwright/sim-core";
import { SimHost } from "./sim.ts";
import { loadSnapshot } from "./snapshots.ts";
import { runScenarioVisual, type VisualReport, type VisualScenario } from "./visual-capture.ts";

export interface VisualReportOptions {
  /** Only this scenario id. */
  scenario?: string;
  registry?: PartRegistry;
  /** Evenly spaced snapshots between checks (default on; false skips the second pass). */
  keyframes?: boolean;
}

export function loadProjectDir(dir: string): { project: Project; hex: string | undefined } {
  const file = join(dir, "fabwright.json");
  if (!existsSync(file)) throw new Error(`No fabwright.json in ${dir}. Pass a project folder (one with fabwright.json), e.g. examples/tamagotchi.`);
  const project = parseProject(readFileSync(file, "utf8"));
  const art = project.firmware?.artifact;
  const hexPath = art ? join(dir, art) : undefined;
  const hex = hexPath && existsSync(hexPath) ? readFileSync(hexPath, "utf8") : undefined;
  if (project.firmware && !hex) throw new Error(`Firmware not built: ${hexPath} is missing. Build it first (fabwright build -p ${dir}), then make the report again.`);
  return { project, hex };
}

export async function buildVisualReport(dir: string, opts: VisualReportOptions = {}): Promise<VisualReport> {
  const { project, hex } = loadProjectDir(dir);
  const registry = opts.registry ?? defaultRegistry;
  const pick = opts.scenario ? project.scenarios.filter((s) => s.id === opts.scenario) : project.scenarios;
  if (opts.scenario && !pick.length) throw new Error(`No scenario '${opts.scenario}' in ${dir}. Scenarios: ${project.scenarios.map((s) => s.id).join(", ") || "none"}.`);
  await SimHost.preparePhysics(project);
  // Screens make keyframes ~1.5 kB each; robots and arms are a few numbers, so they get more.
  const hasScreen = project.parts.some((p) => /oled|lcd|tft|display/.test(p.type));
  const scenarios: VisualScenario[] = [];
  for (const s of pick) {
    const host = new SimHost(project, registry, hex);
    try {
      const { visual } = runScenarioVisual(host, s, project, registry, undefined, { snapshot: (name) => loadSnapshot(dir, name) }, opts.keyframes === false ? {} : { keyframes: { max: hasScreen ? 24 : 80, makeHost: () => new SimHost(project, registry, hex) } });
      scenarios.push(visual);
    } catch (err) {
      scenarios.push({ id: s.id, ...(s.name ? { name: s.name } : {}), passed: false, t_ms: host.timeMs, reason: err instanceof Error ? err.message : String(err), inputs: [], frames: [], replayable: false });
    } finally {
      host.dispose();
    }
  }
  const passed = scenarios.filter((s) => s.passed).length;
  return { format: "fabwright-visual-report/1", project: project.name, passed, failed: scenarios.length - passed, scenarios };
}

// CLI
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const args = process.argv.slice(2);
  const si = args.indexOf("--scenario");
  const scenario = si >= 0 ? args.splice(si, 2)[1] : undefined;
  const [dir, out] = args;
  if (!dir) {
    console.error("usage: node --import tsx packages/session/src/visual-report.ts <project dir> [out.json] [--scenario id]");
    process.exit(2);
  }
  const t0 = performance.now();
  const report = await buildVisualReport(resolve(dir), scenario ? { scenario } : {});
  const json = JSON.stringify(report);
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, json);
  } else process.stdout.write(json + "\n");
  const frames = report.scenarios.reduce((n, s) => n + s.frames.length, 0);
  console.error(`${report.project}: ${report.passed}/${report.scenarios.length} passed, ${frames} frames, ${(json.length / 1024).toFixed(0)} kB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
