// firmware.language "esp-idf": idf.py build in jumper/esp-idf, then esptool merge_bin into the
// padded flash image the QEMU backend boots. Compiler errors map back to firmware/<path>:<line>.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BuildRequest, BuildResult } from "../build.ts";
import { cacheDir } from "../config.ts";
import { parseCompilerOutput, type CompileDiagnostic } from "../diagnostics.ts";
import { RunnerError } from "../docker.ts";
import { ESP_IDF_IMAGE, ensureToolchainImage, runToolchain } from "./toolchain.ts";

const ESP_TARGETS = ["esp32", "esp32s3", "esp32c3"] as const;
/** Flash size the QEMU machines boot (the image is padded to it). */
const FLASH_MB: Record<(typeof ESP_TARGETS)[number], number> = { esp32: 4, esp32s3: 8, esp32c3: 4 };

function hashTree(dir: string, h: ReturnType<typeof createHash>, root = dir): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === "build" || name.startsWith(".") || name === "sdkconfig" || name === "managed_components") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) hashTree(abs, h, root);
    else h.update(relative(root, abs)).update("\0").update(readFileSync(abs)).update("\0");
  }
}

export async function buildEspIdf(req: BuildRequest, t0: number): Promise<BuildResult> {
  const log = req.log ?? (() => {});
  const target = (req.target ?? req.chip ?? "") as (typeof ESP_TARGETS)[number];
  if (!ESP_TARGETS.includes(target)) {
    throw new RunnerError("esp-idf-target", `Build failed: ESP-IDF builds for an ESP32-family chip, but this board is '${req.target ?? req.chip ?? "unknown"}'. Fix: put an ESP32 / ESP32-S3 / ESP32-C3 board in the project (firmware.board), or set firmware.build.target to "esp32", "esp32s3" or "esp32c3".`);
  }
  const dir = req.sketchDir;
  if (!existsSync(join(dir, "CMakeLists.txt"))) {
    throw new RunnerError("esp-idf-no-project", `Build failed: ${req.displayPrefix ?? ""}CMakeLists.txt is missing. Why: an ESP-IDF project is a folder with a top-level CMakeLists.txt and a main/ component. Fix: start from the esp-idf template (new_project {"template": "esp32-idf"}) or write firmware/CMakeLists.txt and firmware/main/CMakeLists.txt.`);
  }
  const h = createHash("sha256");
  h.update(`esp-idf\nimage=${ESP_IDF_IMAGE.image}\ntarget=${target}\n`);
  hashTree(dir, h);
  const hash = h.digest("hex").slice(0, 24);
  const resultDir = join(cacheDir(), "builds", hash);
  if (req.cache !== false && existsSync(join(resultDir, "result.json")) && existsSync(join(resultDir, "flash.bin"))) {
    const cached = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8")) as BuildResult;
    return { ...cached, binary: new Uint8Array(readFileSync(join(resultDir, "flash.bin"))), cached: true, durationMs: Date.now() - t0 };
  }
  await ensureToolchainImage(ESP_IDF_IMAGE, log);
  log(`idf.py build (${target})…`);
  const work = join(cacheDir(), "work", hash);
  const r = await runToolchain(ESP_IDF_IMAGE, work, dir, [target, String(FLASH_MB[target])], { timeoutMs: 30 * 60_000 });
  // eslint-disable-next-line no-control-regex
  const output = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const prefix = req.displayPrefix ?? "";
  const pathMap = (p: string) => {
    const m = /^\/tmp\/project\/(.+)$/.exec(p);
    return m ? prefix + m[1] : undefined;
  };
  const diagnostics: CompileDiagnostic[] = parseCompilerOutput(output, pathMap);
  for (const m of output.matchAll(/CMake Error at \/tmp\/project\/([^:]+):(\d+)[^\n]*\n([\s\S]*?)(?:\n\n|$)/g)) {
    diagnostics.push({ severity: "error", file: prefix + m[1], line: Number(m[2]), message: m[3]!.trim().replace(/\s+/g, " ").slice(0, 400), hint: "CMake could not configure the project: check the component's CMakeLists.txt (idf_component_register SRCS / INCLUDE_DIRS / REQUIRES)." });
  }
  const flashPath = join(r.out, "merged.bin");
  const ok = r.code === 0 && existsSync(flashPath);
  if (!ok && !diagnostics.some((d) => d.severity === "error")) {
    diagnostics.push({ severity: "error", message: `idf.py exited with code ${r.code}: ${output.trim().split("\n").slice(-6).join(" | ")}`, hint: "Read the message above; a missing component goes in REQUIRES of main/CMakeLists.txt." });
  }
  const binary = ok ? new Uint8Array(readFileSync(flashPath)) : undefined;
  const sizeLine = /Total image size:\s*([\d,]+) bytes/.exec(output)?.[1]?.replace(/,/g, "");
  const result: BuildResult = {
    ok,
    language: "esp-idf",
    format: "esp-flash",
    cached: false,
    durationMs: Date.now() - t0,
    hash,
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    libraries: [],
    ...(ok ? { summary: `ESP-IDF v5.5.5, ${target}, ${FLASH_MB[target]} MB flash image${sizeLine ? `, app ${sizeLine} B` : ""}` } : {}),
    logTail: output.trim().split("\n").slice(-15).join("\n"),
  };
  if (ok && binary) {
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, "flash.bin"), binary);
    writeFileSync(join(resultDir, "result.json"), JSON.stringify(result));
  }
  return { ...result, ...(binary ? { binary } : {}) };
}
