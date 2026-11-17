// Rebuilds the ESP board fixtures through Fabwright's own build pipeline (services/runner), with each
// board's simulator FQBN and build properties from its part.json. Golden builds: run on purpose only.
//   node_modules/.bin/tsx packages/sim-backends/fixtures/esp-boards/build.ts [board ...]   (default: all)
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildFirmware, flashImageOf, trimFlash } from "../../../../services/runner/src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const parts = fileURLToPath(new URL("../../../parts/src/parts/", import.meta.url));
const all = ["seeed-xiao-esp32s3", "seeed-xiao-esp32s3-sense", "seeed-xiao-esp32c3", "esp32-c3-supermini", "esp32-devkitc", "esp32-s3-devkitc-1"];
const boards = process.argv.slice(2).length ? process.argv.slice(2) : all;
for (const id of boards) {
  const spec = JSON.parse(readFileSync(`${parts}${id}/part.json`, "utf8"));
  const fqbn = spec.mcu.toolchain?.simFqbn ?? spec.mcu.fqbn;
  const r = await buildFirmware({ sketchDir: `${here}${id}/sketch`, fqbn, buildProperties: spec.mcu.toolchain?.simBuildProperties ?? [], log: console.log });
  if (!r.ok) throw new Error(`${id}: ${r.diagnostics.map((d) => d.message).join("; ")}\n${r.logTail}`);
  const t = trimFlash(Buffer.from(flashImageOf(r)!));
  writeFileSync(`${here}${id}.bin.gz`, gzipSync(t.data, { level: 9 }));
  console.log(`${id}: ${fqbn} -> ${t.data.length} bytes (+${t.pad} x 0x${t.padByte.toString(16)}) in ${r.durationMs} ms${r.cached ? " (cached)" : ""}`);
}
