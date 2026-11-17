// Rebuilds the ESP32-family peripheral fixtures (esp_io, esp_bus, esp_neopixel, esp_audio) for ESP32, S3 and C3
// through Faber's own build pipeline (services/runner): Docker or, without it, Faber's native
// toolchain (round 11). Same output as build.sh: the merged 4 MB flash image, gzipped.
//   node_modules/.bin/tsx packages/sim-backends/fixtures/esp32/build.ts [sketch ...]
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildFirmware, flashImageOf } from "../../../../services/runner/src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const sketches = process.argv.slice(2).length ? process.argv.slice(2) : ["esp_io", "esp_bus", "esp_neopixel", "esp_audio"];
for (const s of sketches) {
  for (const chip of ["esp32", "esp32s3", "esp32c3"]) {
    const work = mkdtempSync(join(tmpdir(), "faber-espfix-"));
    try {
      cpSync(join(here, s), join(work, s), { recursive: true });
      cpSync(join(here, "esp_pins.h"), join(work, s, "esp_pins.h"));
      const r = await buildFirmware({ sketchDir: join(work, s), fqbn: `esp32:esp32:${chip}:FlashMode=dio`, libraries: s === "esp_neopixel" ? ["Adafruit NeoPixel"] : [], log: console.log });
      if (!r.ok) throw new Error(`${s} (${chip}): ${r.diagnostics.map((d) => `${d.file ?? ""}:${d.line ?? ""} ${d.message}`).join("; ")}\n${r.logTail}`);
      writeFileSync(join(here, `${s}.${chip}.bin.gz`), gzipSync(flashImageOf(r)!, { level: 9 }));
      console.log(`${s}.${chip}.bin.gz: flash ${r.size?.flash} bytes, RAM ${r.size?.ram} bytes, ${r.durationMs} ms${r.cached ? " (cached)" : ""}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
