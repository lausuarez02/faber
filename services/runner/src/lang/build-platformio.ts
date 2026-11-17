// firmware.language "platformio": `pio run` in fabwright/platformio with the project's platformio.ini.
// The image carries the atmelavr platform; a platformio.ini that names another platform is refused
// up front with the reason (docs/firmware-languages.md), instead of downloading gigabytes mid-build.
// lib_deps are downloaded on first use (network on), into a cache shared by builds.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BuildRequest, BuildResult } from "../build.ts";
import { cacheDir } from "../config.ts";
import { parseCompilerOutput, type CompileDiagnostic } from "../diagnostics.ts";
import { RunnerError } from "../docker.ts";
import { ensureToolchainImage, PLATFORMIO_IMAGE, runToolchain } from "./toolchain.ts";

/** PlatformIO platforms in the image, with the chip each builds for. */
export const PIO_PLATFORMS: Record<string, { chips: string[]; output: "firmware.hex" }> = {
  atmelavr: { chips: ["atmega328p"], output: "firmware.hex" },
};

export interface PioEnv {
  name: string;
  platform?: string;
  board?: string;
  framework?: string;
}

/** The [env:…] sections of a platformio.ini (enough of INI for what Fabwright checks). */
export function parsePlatformioIni(text: string): PioEnv[] {
  const envs: PioEnv[] = [];
  const common: Record<string, string> = {};
  let cur: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const name = sec[1]!.trim();
      if (name.startsWith("env:")) {
        cur = { name: name.slice(4) };
        envs.push(cur as unknown as PioEnv);
      } else cur = name === "env" ? common : undefined;
      continue;
    }
    const kv = /^([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]!] = kv[2]!.trim();
  }
  return envs.map((e) => ({ ...(common as object), ...e }) as PioEnv);
}

function hashTree(dir: string, h: ReturnType<typeof createHash>, root = dir): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".pio" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) hashTree(abs, h, root);
    else h.update(relative(root, abs)).update("\0").update(readFileSync(abs)).update("\0");
  }
}

export async function buildPlatformIO(req: BuildRequest, t0: number): Promise<BuildResult> {
  const log = req.log ?? (() => {});
  const prefix = req.displayPrefix ?? "";
  const ini = join(req.sketchDir, "platformio.ini");
  if (!existsSync(ini)) {
    throw new RunnerError("platformio-no-ini", `Build failed: ${prefix}platformio.ini is missing. Why: PlatformIO builds the project its platformio.ini describes. Fix: write firmware/platformio.ini with an [env:uno] section (platform = atmelavr, board = uno, framework = arduino) and the code in firmware/src/main.cpp.`);
  }
  const envs = parsePlatformioIni(readFileSync(ini, "utf8"));
  if (!envs.length) throw new RunnerError("platformio-no-env", `Build failed: ${prefix}platformio.ini has no [env:<name>] section. Fix: add one, e.g. [env:uno] with platform = atmelavr, board = uno, framework = arduino.`);
  const env = req.env ? envs.find((e) => e.name === req.env) : envs[0]!;
  if (!env) throw new RunnerError("platformio-env", `Build failed: firmware.build.env is '${req.env}', but ${prefix}platformio.ini has ${envs.map((e) => `[env:${e.name}]`).join(", ")}. Fix: set firmware.build.env to one of those.`);
  const platform = (env.platform ?? "").split("@")[0]!.trim();
  const known = PIO_PLATFORMS[platform];
  if (!known) {
    throw new RunnerError("platformio-platform", `Build failed: [env:${env.name}] uses platform '${env.platform ?? "(none)"}', and Fabwright's PlatformIO image only has atmelavr. Why: each platform is a large download (espressif32 alone is about 1.5 GB), so they are added one at a time (docs/firmware-languages.md lists which are planned). Fix: use platform = atmelavr for an Uno / Nano, or the Arduino or ESP-IDF language for other boards.`);
  }
  if (req.chip && !known.chips.includes(req.chip)) {
    throw new RunnerError("platformio-board", `Build failed: [env:${env.name}] builds for ${known.chips.join(", ")}, but the board in the project is ${req.chip}. Fix: change the board part, or the env's platform / board.`);
  }
  const h = createHash("sha256");
  h.update(`platformio\nimage=${PLATFORMIO_IMAGE.image}\nenv=${env.name}\n`);
  hashTree(req.sketchDir, h);
  const hash = h.digest("hex").slice(0, 24);
  const resultDir = join(cacheDir(), "builds", hash);
  if (req.cache !== false && existsSync(join(resultDir, "result.json"))) {
    const cached = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8")) as BuildResult;
    return { ...cached, cached: true, durationMs: Date.now() - t0 };
  }
  await ensureToolchainImage(PLATFORMIO_IMAGE, log);
  log(`pio run -e ${env.name}…`);
  const work = join(cacheDir(), "work", hash);
  const r = await runToolchain(PLATFORMIO_IMAGE, work, req.sketchDir, [env.name], {
    network: true,
    cache: join(cacheDir(), "platformio"),
    env: { PLATFORMIO_CACHE_DIR: "/cache/dl", PLATFORMIO_LIBDEPS_DIR: "/cache/libdeps" },
    timeoutMs: 15 * 60_000,
  });
  // eslint-disable-next-line no-control-regex
  const output = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const pathMap = (p: string) => {
    const m = /^(?:\/tmp\/project\/)?((?:src|include|lib|test)\/.+)$/.exec(p);
    return m ? prefix + m[1] : undefined;
  };
  const diagnostics: CompileDiagnostic[] = parseCompilerOutput(output, pathMap);
  for (const m of output.matchAll(/^(?:Error|UnknownPackageError|UnknownBoard|MissingPackageManifestError)[:]?\s*(.+)$/gm)) {
    diagnostics.push({ severity: "error", file: prefix + "platformio.ini", message: m[0]!.trim(), hint: "PlatformIO could not resolve the env: check platform, board and lib_deps names in platformio.ini." });
  }
  const hexPath = join(r.out, known.output);
  const ok = r.code === 0 && existsSync(hexPath);
  if (!ok && !diagnostics.some((d) => d.severity === "error")) {
    diagnostics.push({ severity: "error", message: `pio run exited with code ${r.code}: ${output.trim().split("\n").slice(-6).join(" | ")}`, hint: "Read the message above." });
  }
  const flash = /Flash:.*used (\d+) bytes from (\d+) bytes/.exec(output);
  const ram = /RAM:.*used (\d+) bytes from (\d+) bytes/.exec(output);
  const result: BuildResult = {
    ok,
    language: "platformio",
    format: "ihex",
    ...(ok ? { hex: readFileSync(hexPath, "utf8") } : {}),
    cached: false,
    durationMs: Date.now() - t0,
    hash,
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    ...(flash && ram ? { size: { flash: Number(flash[1]), flashMax: Number(flash[2]), ram: Number(ram[1]), ramMax: Number(ram[2]) } } : {}),
    libraries: [],
    logTail: output.trim().split("\n").slice(-15).join("\n"),
  };
  if (ok) {
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, "result.json"), JSON.stringify(result));
  }
  return result;
}
