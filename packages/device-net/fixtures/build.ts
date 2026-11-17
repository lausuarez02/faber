// Rebuilds net-probe.esp32s3.merged.bin.gz (and audio-stream's, round 13) through Faber's own build pipeline (services/runner):
// the arduino-esp32 r3 image in Docker or, without it, the native toolchain (round 11, `faber setup
// esp32`). The simulation build links the Wi-Fi / TLS shim (the output says "Wi-Fi shim on").
//   node_modules/.bin/tsx packages/device-net/fixtures/build.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildFirmware, flashImageOf } from "../../../services/runner/src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
// net-probe by default; `build.ts audio-stream` (round 13) or both by name.
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["net-probe"]) {
  const r = await buildFirmware({ sketchDir: `${here}${name}`, fqbn: "esp32:esp32:esp32s3:FlashMode=dio", log: console.log });
  if (!r.ok) throw new Error(`${name}: ${r.diagnostics.map((d) => `${d.file ?? ""}:${d.line ?? ""} ${d.message}`).join("; ")}\n${r.logTail}`);
  if (!/Wi-Fi shim on/.test(r.logTail)) console.warn(`warning: the ${name} build log does not say the Wi-Fi shim was linked`);
  writeFileSync(`${here}${name}.esp32s3.merged.bin.gz`, gzipSync(flashImageOf(r)!, { level: 9 }));
  console.log(`${name}.esp32s3.merged.bin.gz: flash ${r.size?.flash} bytes, RAM ${r.size?.ram} bytes, ${r.durationMs} ms`);
}
