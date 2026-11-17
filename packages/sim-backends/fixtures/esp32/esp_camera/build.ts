// Rebuilds the camera fixture (round 13) through Fabwright's own build pipeline, for the XIAO ESP32-S3
// Sense (its simulator FQBN, PSRAM=opi) and the ESP32 (ESP32-CAM pins). The merged flash image, gzipped.
//   node_modules/.bin/tsx packages/sim-backends/fixtures/esp32/esp_camera/build.ts
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildFirmware, flashImageOf, trimFlash } from "../../../../../services/runner/src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const targets = [
  { name: "esp32s3", fqbn: "esp32:esp32:XIAO_ESP32S3:CDCOnBoot=cdc,FlashMode=dio,PSRAM=opi" },
  { name: "esp32", fqbn: "esp32:esp32:esp32:FlashMode=dio,PSRAM=enabled" },
];
for (const t of targets) {
  const work = mkdtempSync(join(tmpdir(), "fabwright-camfix-"));
  try {
    cpSync(join(here, "esp_camera.ino"), join(work, "esp_camera", "esp_camera.ino"));
    const r = await buildFirmware({ sketchDir: join(work, "esp_camera"), fqbn: t.fqbn, log: console.log });
    if (!r.ok) throw new Error(`${t.name}: ${r.diagnostics.map((d) => d.message).join("; ")}\n${r.logTail}`);
    const img = trimFlash(Buffer.from(flashImageOf(r)!));
    writeFileSync(join(here, "..", `esp_camera.${t.name}.bin.gz`), gzipSync(img.data, { level: 9 }));
    console.log(`esp_camera.${t.name}.bin.gz: ${t.fqbn}, flash ${r.size?.flash} bytes, ${img.data.length} bytes image (+${img.pad} padding)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
