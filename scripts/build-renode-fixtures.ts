// Rebuild the Renode board fixtures (packages/sim-backends/fixtures/renode/*.hex) through Jumper's own
// build pipeline (services/runner: the same images, Serial redirection and XIAO sim.hex a project
// build gets). Needs Docker. Golden files: rebuild only on purpose, then run the integration tests.
//
//   node --import tsx scripts/build-renode-fixtures.ts [sketch ...]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFirmware } from "../services/runner/src/index.ts";
import { RENODE_BOARDS } from "../packages/sim-backends/src/renode/boards.ts";

const DIR = fileURLToPath(new URL("../packages/sim-backends/fixtures/renode/", import.meta.url));
const JOBS: { sketch: string; boards: string[]; libraries?: string[] }[] = [
  { sketch: "pinprobe", boards: Object.keys(RENODE_BOARDS) },
  { sketch: "busprobe", boards: Object.keys(RENODE_BOARDS) },
  { sketch: "oled_blackpill", boards: ["stm32-blackpill-f411"], libraries: ["Adafruit SSD1306"] },
];

const only = process.argv.slice(2);
let failed = 0;
for (const job of JOBS) {
  if (only.length && !only.includes(job.sketch)) continue;
  for (const board of job.boards) {
    const fqbn = (RENODE_BOARDS as Record<string, { fqbn: string }>)[board]!.fqbn;
    const t0 = Date.now();
    const r = await buildFirmware({ sketchDir: join(DIR, job.sketch), fqbn, libraries: job.libraries ?? [], cache: false, log: (l) => console.log(`  ${l}`) });
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.ok || !r.hex) {
      failed++;
      console.error(`FAIL ${job.sketch} for ${board} (${fqbn}) in ${s} s:\n${r.diagnostics.map((d) => `  ${d.file ?? ""}:${d.line ?? ""} ${d.message}`).join("\n")}\n${r.logTail}`);
      continue;
    }
    writeFileSync(join(DIR, `${job.sketch}-${board}.hex`), r.hex);
    console.log(`ok   ${job.sketch}-${board}.hex  ${s} s  ${r.size ? `${r.size.flash} B flash` : ""}`);
  }
}
process.exit(failed ? 1 : 0);
