// Rebuilds the ESP board fixtures through Jumper's own build pipeline (services/runner), with each
// board's simulator FQBN and build properties from its part.json. Golden builds: run on purpose only.
//   node_modules/.bin/tsx packages/sim-backends/fixtures/esp-boards/build.ts
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildFirmware, flashImageOf } from "../../../../services/runner/src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const parts = fileURLToPath(new URL("../../../parts/src/parts/", import.meta.url));
const boards = ["seeed-xiao-esp32s3", "seeed-xiao-esp32c3", "esp32-c3-supermini", "esp32-devkitc", "esp32-s3-devkitc-1"];
for (const id of boards) {
  const spec = JSON.parse(readFileSync(`${parts}${id}/part.json`, "utf8"));
  const fqbn = spec.mcu.toolchain?.simFqbn ?? spec.mcu.fqbn;
  const r = await buildFirmware({ sketchDir: `${here}${id}/sketch`, fqbn, buildProperties: spec.mcu.toolchain?.simBuildProperties ?? [], log: console.log });
  if (!r.ok) throw new Error(`${id}: ${r.diagnostics.map((d) => d.message).join("; ")}\n${r.logTail}`);
  const img = flashImageOf(r)!;
  writeFileSync(`${here}${id}.bin.gz`, gzipSync(Buffer.from(img.subarray(0, img.length - (r.binPad ?? 0))), { level: 9 }));
  console.log(`${id}: ${fqbn} -> ${img.length - (r.binPad ?? 0)} bytes (+${r.binPad} x 0x${(r.binPadByte ?? 0).toString(16)}) in ${r.durationMs} ms${r.cached ? " (cached)" : ""}`);
}
