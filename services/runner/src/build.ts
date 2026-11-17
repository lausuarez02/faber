import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { cacheDir, imageFor, outputFormatFor, PINNED_LIBRARIES, platformFor, RUNNER_IMAGE, SUPPORTED_FQBNS } from "./config.ts";
import { parseCompilerOutput, type CompileDiagnostic } from "./diagnostics.ts";
import { ensureDocker, ensureImage, exec, RunnerError } from "./docker.ts";
import type { FirmwareLanguage } from "@faber/project-format";
import type { ImageFormat } from "./lang/registry.ts";
import { buildMicroPython } from "./lang/build-micropython.ts";
import { buildEspIdf } from "./lang/build-espidf.ts";
import { buildPlatformIO } from "./lang/build-platformio.ts";
import { arduinoRuntimeFor } from "./runtime.ts";
import { CAMERA_SHIM_INCLUDE, cameraShimHash, SLEEP_SHIM_CALL, sleepShimHash, compileNative, installLibraryNative, nativeFamilyOf, nativeToolchainId } from "./native/arduino.ts";
import type { Runtime } from "@faber/sim-backends/node";

export interface BuildRequest {
  /** Absolute folder holding the sketch sources: every .ino/.h/.hpp/.c/.cpp/.S in it (and its src/ folder). */
  sketchDir: string;
  /** Main .ino file inside sketchDir. Default: the only .ino, or the one named like the folder. */
  main?: string;
  /** e.g. "arduino:avr:uno", "rp2040:rp2040:rpipico" (picks the Docker image). Arduino only. */
  fqbn?: string;
  /** Round 10: the firmware language (default "arduino"); picks the toolchain. */
  language?: FirmwareLanguage;
  /** The board's chip (part.json mcu.chip), e.g. "rp2040", "esp32c3": picks the toolchain and image format. */
  chip?: string;
  /** The board part type, e.g. "raspberry-pi-pico" (MicroPython picks that board's build). */
  board?: string;
  /** MicroPython: firmware build "ID@version" (firmware.build.firmware). */
  micropythonFirmware?: string;
  /** ESP-IDF: target (firmware.build.target, default the chip). PlatformIO: env (firmware.build.env). */
  target?: string;
  env?: string;
  /** "Name" or "Name@version". Names without a version resolve to Faber's pinned versions. */
  libraries?: readonly string[];
  /** Prefix for file paths in diagnostics, e.g. "firmware/" so errors read "firmware/pet.ino:12". */
  displayPrefix?: string;
  /** Extra `--build-property` values (e.g. "build.cdc_on_boot=0" for a simulator build). */
  buildProperties?: readonly string[];
  /**
   * "simulator" (default) or "device". ESP32 images with the simulation shim (faber/arduino-esp32 r3:
   * Wi-Fi on the emulated Ethernet card, TLS trusting the sandbox CA) leave it out of a "device" build
   * (FABER_SIM=0), so the factory pack's firmware is plain arduino-cli output.
   */
  purpose?: "simulator" | "device";
  /**
   * Round 13: files added to the sketch for this build only (path in the sketch → text), e.g. the
   * simulation's faber_device.h (the sandbox relay) or FaberRelay.h when the sketch includes it.
   */
  extraSources?: Readonly<Record<string, string>>;
  /** Reuse a cached result for identical inputs (default true). */
  cache?: boolean;
  /** Progress lines (image builds, library installs). */
  log?: (line: string) => void;
}

export interface BuildResult {
  ok: boolean;
  /** Intel HEX text (when ok and the board's emulator loads hex: AVR, RP2040). */
  hex?: string;
  /** Round 10: what the emulator loads. "ihex" = `hex`; "esp-flash" / "elf" = `binary`. Default "ihex". */
  format?: ImageFormat;
  /** The image bytes for "esp-flash" (merged flash padded to its size) and "elf". */
  binary?: Uint8Array;
  /** Round 10: the language that built it (default arduino). */
  language?: FirmwareLanguage;
  /** One line about what was built, when the size line does not fit (MicroPython). */
  summary?: string;
  cached: boolean;
  durationMs: number;
  /** Content hash of the inputs (sources + fqbn + libraries + image). */
  hash: string;
  diagnostics: CompileDiagnostic[];
  errors: number;
  warnings: number;
  size?: { flash: number; flashMax: number; ram: number; ramMax: number };
  /** Resolved "Name@version" list actually used (including auto-added dependencies). */
  libraries: string[];
  /** Last lines of the raw compiler output, for anything the parser missed. */
  logTail: string;
}

const SOURCE_EXT = /\.(ino|pde|h|hpp|hh|c|cc|cpp|cxx|S|s)$/;
/** The person's own device settings (relay token, Wi-Fi password): never in a build Faber makes. */
export const DEVICE_SECRETS_HEADER = "faber_device.h";
/** The same file under its name from before the rename from Jumper: just as secret. */
export const LEGACY_DEVICE_SECRETS_HEADER = "jumper_device.h";
const inflight = new Map<string, Promise<BuildResult>>();

/**
 * Arduino inserts prototypes for every function at the top of the .ino, above the user's own types,
 * so `Mood getMood()` fails with "'Mood' does not name a type" even though the sketch declares Mood.
 * When the type is declared in the sketch, say that instead of "add a library".
 */
export function refineWithSources(diags: CompileDiagnostic[], sources: Map<string, string>): CompileDiagnostic[] {
  const all = [...sources.values()].join("\n");
  return diags.map((d) => {
    const m = d.message.match(/'([A-Za-z_]\w*)' (?:does not name a type|was not declared in this scope|has not been declared)/);
    if (!m) return d;
    const name = m[1]!;
    const declared = new RegExp(`\\b(?:enum(?:\\s+class)?|struct|class|union)\\s+${name}\\b|typedef\\b[^;]*\\b${name}\\s*;|using\\s+${name}\\s*=`).test(all);
    if (!declared) return d;
    return {
      ...d,
      hint: `'${name}' is declared in your sketch, but Arduino puts automatic function prototypes at the top of the .ino, above that declaration. Fix: move the ${name} declaration into a header (write_file firmware/<sketch folder>/types.h and #include "types.h" at the top of the .ino), or write the prototypes of the functions that use ${name} yourself right after its declaration.`,
    };
  });
}

/** Cuts the run of identical bytes a merged flash image is padded with (restored exactly by flashImageOf). */
export function trimFlash(buf: Buffer): { data: Buffer; pad: number; padByte: number } {
  const padByte = buf.length ? buf[buf.length - 1]! : 0xff;
  let end = buf.length;
  while (end > 0 && buf[end - 1] === padByte) end--;
  return { data: buf.subarray(0, end), pad: buf.length - end, padByte };
}

/** The full flash image of a build result (ESP32 family), or undefined for an Intel HEX build. */
export function flashImageOf(r: Pick<BuildResult, "format" | "binary">): Uint8Array | undefined {
  return r.format === "esp-flash" ? r.binary : undefined;
}

/** Resolve names to pinned versions and add pinned dependencies. Throws a clear error for malformed entries. */
export function resolveLibraries(libs: readonly string[] = []): string[] {
  const out = new Map<string, string>();
  const add = (spec: string, auto: boolean) => {
    const trimmed = spec.trim();
    if (!trimmed) return;
    const at = trimmed.lastIndexOf("@");
    const name = at > 0 ? trimmed.slice(0, at).trim() : trimmed;
    let version = at > 0 ? trimmed.slice(at + 1).trim() : "";
    if (at > 0 && !/^\d+(\.\d+){0,3}([-+][\w.]+)?$/.test(version)) {
      throw new RunnerError("bad-library", `Library '${spec}' has an invalid version '${version}'. Fix: write it as "Name@1.2.3" (as shown in the Arduino Library Manager) or just "Name" for Faber's pinned version.`);
    }
    const pinned = PINNED_LIBRARIES[name];
    if (!version) version = pinned?.version ?? "";
    if (out.has(name) && auto) return;
    out.set(name, version ? `${name}@${version}` : name);
    for (const dep of pinned?.deps ?? []) if (!out.has(dep)) add(dep, true);
  };
  for (const l of libs) add(l, false);
  return [...out.values()].sort();
}

function isPreinstalled(spec: string, fqbn = ""): boolean {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : "";
  const p = PINNED_LIBRARIES[name];
  return !!p && p.preinstalled && p.version === version && (!p.only || p.only.some((x) => fqbn.startsWith(x)));
}

/** `s` without `prefix`, or undefined when it does not start with it. */
function p0(s: string, prefix: string): string | undefined {
  return s.startsWith(prefix) ? s.slice(prefix.length) : undefined;
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

/** Collect sketch sources as { relative path → content }. */
export function collectSources(sketchDir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        // Arduino compiles the sketch root and its src/ folder recursively; nothing else.
        if (depth === 0 && name === "src") walk(abs, depth + 1);
        else if (depth > 0) walk(abs, depth + 1);
        continue;
      }
      if (SOURCE_EXT.test(name)) files.set(relative(sketchDir, abs), readFileSync(abs, "utf8"));
    }
  };
  walk(sketchDir, 0);
  return files;
}

function pickMain(sources: Map<string, string>, sketchDir: string, main?: string): string {
  const inos = [...sources.keys()].filter((f) => /\.(ino|pde)$/.test(f) && !f.includes("/"));
  if (main) {
    const m = basename(main);
    if (!sources.has(m)) {
      throw new RunnerError("no-main", `Build failed: the main sketch '${m}' is not in ${sketchDir} (found: ${inos.join(", ") || "no .ino files"}). Fix: write it first (write_file) or point firmware.sketch at an existing .ino.`);
    }
    return m;
  }
  if (inos.length === 1) return inos[0]!;
  const byFolder = `${basename(sketchDir)}.ino`;
  if (inos.includes(byFolder)) return byFolder;
  if (inos.length === 0) {
    throw new RunnerError("no-main", `Build failed: no .ino file in ${sketchDir}. Fix: write the sketch first, e.g. write_file("firmware/main.ino", "...").`);
  }
  throw new RunnerError("no-main", `Build failed: ${inos.length} .ino files in ${sketchDir} (${inos.join(", ")}) and none is marked as main. Fix: set firmware.sketch to the main one.`);
}

function parseSize(output: string): BuildResult["size"] {
  const f = output.match(/Sketch uses (\d+) bytes.*?Maximum is (\d+) bytes/);
  const r = output.match(/Global variables use (\d+) bytes.*?Maximum is (\d+) bytes/);
  if (!f || !r) return undefined;
  return { flash: Number(f[1]), flashMax: Number(f[2]), ram: Number(r[1]), ramMax: Number(r[2]) };
}

function uidArgs(): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && gid !== undefined ? ["--user", `${uid}:${gid}`] : [];
}

/** Install a non-preinstalled library into the cache (once). Returns the folder to pass as --libraries. */
async function ensureLibrary(spec: string, log: (l: string) => void, runtime: Runtime = "docker"): Promise<string> {
  const root = join(cacheDir(), "arduino-libs");
  const dir = join(root, slug(spec));
  // The same folder serves both runtimes: Docker mounts it at /extra, a native build reads it in place.
  const ret = runtime === "native" ? join(dir, "libraries") : `/extra/${slug(spec)}/libraries`;
  if (existsSync(join(dir, ".ok"))) return ret;
  mkdirSync(dir, { recursive: true });
  log(`installing Arduino library ${spec}…`);
  const r =
    runtime === "native"
      ? await installLibraryNative(spec, dir)
      : await exec(
          "docker",
          ["run", "--rm", ...uidArgs(), "-v", `${root}:/extra`, "-e", `ARDUINO_DIRECTORIES_USER=/extra/${slug(spec)}`, "-e", `ARDUINO_DIRECTORIES_DOWNLOADS=/extra/${slug(spec)}/.dl`, RUNNER_IMAGE, "lib", "install", spec],
          { timeoutMs: 10 * 60_000 },
        );
  if (r.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    const why = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
    throw new RunnerError(
      "library-install-failed",
      `Could not install the Arduino library '${spec}': ${why}. Fix: check the exact name and version in the Arduino Library Manager (names are case-sensitive, e.g. "Adafruit SSD1306"), and that you are online for the first install.`,
    );
  }
  writeFileSync(join(dir, ".ok"), spec + "\n");
  rmSync(join(dir, ".dl"), { recursive: true, force: true });
  return ret;
}

/**
 * Compile a sketch with arduino-cli in the pinned Docker image, or (round 11) Faber's native toolchain
 * when Docker is not usable (FABER_RUNTIME). Identical inputs return the cached result.
 * Throws RunnerError only for environment problems (Docker missing, image/library install failures);
 * compile errors come back as `ok: false` with diagnostics.
 */
export async function buildFirmware(req: BuildRequest): Promise<BuildResult> {
  const t0 = Date.now();
  switch (req.language ?? "arduino") {
    case "arduino":
      return buildArduino(req, t0);
    case "micropython":
      return buildMicroPython(req, t0);
    case "esp-idf":
      return buildEspIdf(req, t0);
    case "platformio":
      return buildPlatformIO(req, t0);
    default:
      throw new RunnerError("language-not-built", `Build failed: firmware.language '${req.language}' has no toolchain in Faber yet. Why: ${req.language === "rust" ? "the Rust (esp-hal / rp-hal) image is planned, not built" : "the Zephyr SDK image is planned, not built"} (docs/firmware-languages.md). Fix: use "arduino", "micropython", "esp-idf" or "platformio".`);
  }
}

async function buildArduino(reqIn: BuildRequest, t0: number): Promise<BuildResult> {
  if (!reqIn.fqbn) throw new RunnerError("missing-fqbn", 'Build failed: an Arduino build needs a board (FQBN). Fix: set firmware.build.fqbn, e.g. "arduino:avr:uno", or set firmware.board to a board part.');
  const req = reqIn as BuildRequest & { fqbn: string };
  const log = req.log ?? (() => {});
  if (!existsSync(req.sketchDir)) {
    throw new RunnerError("no-sketch", `Build failed: the sketch folder ${req.sketchDir} does not exist. Fix: write the sketch first, e.g. write_file("firmware/main.ino", "...").`);
  }
  const sources = collectSources(req.sketchDir);
  // Round 13: a person's faber_device.h holds their device token and Wi-Fi password; Faber's own
  // builds (simulator, factory pack, build kit) never compile it. A simulation build gets its own.
  sources.delete(DEVICE_SECRETS_HEADER);
  sources.delete(LEGACY_DEVICE_SECRETS_HEADER);
  for (const [rel, text] of Object.entries(req.extraSources ?? {})) sources.set(rel, text);
  const main = pickMain(sources, req.sketchDir, req.main);
  const libraries = resolveLibraries(req.libraries);

  // Round 11: Docker and native builds of the same inputs are cached apart (same sources, other compilers).
  const keyOf = (runtime: Runtime) => {
    const h = createHash("sha256");
    const family = nativeFamilyOf(req.fqbn);
    h.update(`image=${runtime === "native" && family ? nativeToolchainId(family) : imageFor(req.fqbn)}\nfqbn=${req.fqbn}\nmain=${main}\nlibs=${libraries.join(",")}\n`);
    if (req.buildProperties?.length) h.update(`props=${req.buildProperties.join("\n")}\n`);
    if (req.purpose === "device") h.update("purpose=device\n");
    // Round 13: a simulation build of a camera sketch links Faber's camera shim from the repo.
    else if (req.fqbn.startsWith("esp32:esp32:")) {
      if ([...sources.values()].some((c) => CAMERA_SHIM_INCLUDE.test(c))) h.update(`camshim=${cameraShimHash()}\n`);
      // Round 15: a simulation build of a deep-sleep sketch links Faber's sleep shim from the repo.
      if ([...sources.values()].some((c) => SLEEP_SHIM_CALL.test(c))) h.update(`sleepshim=${sleepShimHash()}\n`);
    }
    for (const [f, c] of [...sources].sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${f}\0${c}\0`);
    return h.digest("hex").slice(0, 24);
  };
  const fromCache = (hash: string): BuildResult | undefined => {
    const resultDir = join(cacheDir(), "builds", hash);
    if (req.cache === false || !existsSync(join(resultDir, "result.json"))) return undefined;
    const cached = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8")) as BuildResult;
    // Flash images (ESP32 family) are kept next to result.json, without their trailing padding.
    const flash = cached.format === "esp-flash" ? readCachedFlash(resultDir) : undefined;
    if (cached.format === "esp-flash" && !flash) return undefined;
    return { ...cached, ...(flash ? { binary: flash } : {}), diagnostics: refineWithSources(cached.diagnostics, sources), cached: true, durationMs: Date.now() - t0 };
  };
  let runtime: Runtime;
  try {
    runtime = await arduinoRuntimeFor(req.fqbn);
  } catch (err) {
    // Nothing can compile right now, but an earlier build of these exact inputs still counts.
    const hit = fromCache(keyOf("docker")) ?? fromCache(keyOf("native"));
    if (hit) return hit;
    throw err;
  }
  const hash = keyOf(runtime);
  const resultDir = join(cacheDir(), "builds", hash);
  const hit = fromCache(hash);
  if (hit) return hit;
  const running = inflight.get(hash);
  if (running) return running;
  const p = compile(req, sources, main, libraries, hash, resultDir, log, t0, runtime).finally(() => inflight.delete(hash));
  inflight.set(hash, p);
  return p;
}

/**
 * Libraries that read a setup header from the sketch folder with #include <name.h> (TFT_eSPI's
 * tft_setup.h) only find it when the sketch folder is on the include path of every compile, the
 * library's own included. Added only when the sketch has such a file, so every other build keeps
 * the exact same command (and the same bytes).
 */
const SKETCH_SETUP_HEADERS = ["tft_setup.h"];
export function sketchSetupFlags(sources: Map<string, string>, forceInclude?: string, sketchDir = "/work/sketch"): string[] {
  const setup = SKETCH_SETUP_HEADERS.some((h) => sources.has(h));
  if (!setup && !forceInclude) return [];
  const cpp = [...(setup ? [`-I${sketchDir}`] : []), ...(forceInclude ? [`-include ${forceInclude}`] : [])].join(" ");
  return ["--build-property", `compiler.cpp.extra_flags=${cpp}`, ...(setup ? ["--build-property", `compiler.c.extra_flags=-I${sketchDir}`] : [])];
}

async function compile(
  req: BuildRequest & { fqbn: string },
  sources: Map<string, string>,
  main: string,
  libraries: string[],
  hash: string,
  resultDir: string,
  log: (l: string) => void,
  t0: number,
  runtime: Runtime = "docker",
): Promise<BuildResult> {
  const native = runtime === "native";
  const platform = platformFor(req.fqbn);
  const image = imageFor(req.fqbn);
  if (!native) {
    await ensureDocker();
    await ensureImage(log, image);
  }
  const libDirs: string[] = [];
  for (const lib of libraries) if (!isPreinstalled(lib, req.fqbn)) libDirs.push(await ensureLibrary(lib, log, runtime));

  // Arduino wants <name>/<name>.ino; we always use "sketch/sketch.ino" and map paths back.
  // One folder per process: two servers (or a test and a server) building the same sketch at once
  // must not delete each other's work (round 13: two e2e browsers, one sketch). Paths inside the
  // firmware are mapped to /work either way, so the output does not depend on the folder name.
  const work = join(cacheDir(), "work", `${hash}-${process.pid}`);
  // Where the compiler sees the work folder: /work in the container, the folder itself natively.
  const workIn = native ? work : "/work";
  rmSync(work, { recursive: true, force: true });
  const sketchOut = join(work, "sketch");
  for (const [rel, raw] of sources) {
    const content = rel === main && platform.simSketchPrelude ? `${platform.simSketchPrelude}#line 1 "${workIn}/sketch/sketch.ino"\n${raw}` : raw;
    const dest = join(sketchOut, rel === main ? "sketch.ino" : rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, content);
  }
  mkdirSync(join(work, "out"), { recursive: true });
  // Boards whose Serial is USB CDC (not emulated): the simulator build prints Serial on the hardware UART.
  if (platform.simSerialHeader) writeFileSync(join(work, "faber_sim_serial.h"), platform.simSerialHeader);
  const libRoot = join(cacheDir(), "arduino-libs");
  mkdirSync(libRoot, { recursive: true });

  const compileArgs = [
    "--fqbn", req.fqbn, "--output-dir", `${workIn}/out`, "--warnings", "default",
    ...libDirs.flatMap((d) => ["--libraries", d]),
    ...sketchSetupFlags(sources, platform.simSerialHeader ? `${workIn}/faber_sim_serial.h` : undefined, `${workIn}/sketch`),
    ...(req.buildProperties ?? []).flatMap((p) => ["--build-property", p]),
  ];
  let r: { code: number; stdout: string; stderr: string };
  if (native) {
    log(`compiling natively (${req.fqbn}, Faber's arduino-cli toolchain)…`);
    r = await compileNative({ fqbn: req.fqbn, args: compileArgs, sketch: `${work}/sketch`, outDir: join(work, "out"), workDir: work, ...(req.purpose ? { purpose: req.purpose } : {}), timeoutMs: 10 * 60_000 });
  } else {
    const args = [
      "run", "--rm", ...uidArgs(), ...(platform.dockerPlatform ? ["--platform", platform.dockerPlatform] : []),
      "-v", `${work}:/work`, "-v", `${libRoot}:/extra:ro`, "-w", "/work",
      ...(req.purpose === "device" ? ["-e", "FABER_SIM=0"] : []),
      image,
      "compile", ...compileArgs,
      "/work/sketch",
    ];
    r = await exec("docker", args, { timeoutMs: 5 * 60_000 });
  }
  // eslint-disable-next-line no-control-regex
  const output = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  if (/Unable to find image|Cannot connect to the Docker daemon/.test(r.stderr)) {
    throw new RunnerError("docker-not-running", `Build failed: ${r.stderr.trim().split("\n")[0]}. Fix: start Docker Desktop and build again.`);
  }
  if (/Invalid FQBN|platform not installed|Platform '[^']+' not found/i.test(output)) {
    throw new RunnerError("bad-fqbn", `Build failed: the board '${req.fqbn}' is not supported by the build image (${output.trim().split("\n").find((l) => /fqbn|platform/i.test(l)) ?? ""}). Fix: use one of ${SUPPORTED_FQBNS.map((f) => `"${f}"`).join(", ")} (firmware.build.fqbn; the board part's mcu.fqbn is the default).`);
  }
  const prefix = req.displayPrefix ?? "";
  const nativeSketch = (s: string) => p0(s, `${work}/sketch/`) ?? p0(s, `${work}/jsim/sketch/`) ?? p0(s, `/private${work}/sketch/`);
  const pathMap = (p: string): string | undefined => {
    const n = native ? nativeSketch(p) : undefined;
    const m = (n !== undefined ? [p, n] : undefined) ?? p.match(/^(?:\/work\/sketch|\/tmp\/[^/]*\/sketch)\/(.+)$/) ?? p.match(/^(?:.*\/)?sketch\/(sketch\.ino(?:\.cpp)?)$/);
    if (!m) return undefined;
    let rel = m[1]!.replace(/\.ino\.cpp$/, ".ino");
    if (rel === "sketch.ino") rel = main;
    return prefix + rel;
  };
  const diagnostics = refineWithSources(parseCompilerOutput(output, pathMap), sources);
  const kind = outputFormatFor(req.fqbn);
  const hexPath = join(work, "out", kind === "bin" ? "sketch.ino.merged.bin" : platform.simHex ? "sketch.ino.sim.hex" : "sketch.ino.hex");
  const ok = r.code === 0 && existsSync(hexPath);
  const binary = ok && kind === "bin" ? new Uint8Array(readFileSync(hexPath)) : undefined;
  // A failure the compiler did not explain (a tool that did not start, a killed build) is not cached:
  // the next build tries again instead of returning the same failure.
  const unexplained = !ok && !diagnostics.some((d) => d.severity === "error");
  if (!ok && !diagnostics.some((d) => d.severity === "error")) {
    diagnostics.push({ severity: "error", message: `arduino-cli exited with code ${r.code}: ${output.trim().split("\n").slice(-4).join(" | ")}`, hint: "Read the message above; if it mentions a library, add it to firmware.libraries." });
  }
  const result: BuildResult = {
    ok,
    ...(ok && kind === "hex" ? { hex: readFileSync(hexPath, "utf8") } : {}),
    format: kind === "bin" ? "esp-flash" : "ihex",
    cached: false,
    durationMs: Date.now() - t0,
    hash,
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    ...(parseSize(output) ? { size: parseSize(output)! } : {}),
    libraries,
    logTail: output.trim().split("\n").slice(-15).join("\n"),
  };
  if (!unexplained) {
    mkdirSync(resultDir, { recursive: true });
    if (binary) writeFileSync(join(resultDir, "flash.json"), JSON.stringify(writeCachedFlash(resultDir, binary)));
    writeFileSync(join(resultDir, "result.json"), JSON.stringify(result));
  }
  rmSync(work, { recursive: true, force: true });
  return { ...result, ...(binary ? { binary } : {}) };
}

/** Keeps a merged flash image in the build cache without its 0xFF tail (often most of 4 MB). */
function writeCachedFlash(dir: string, image: Uint8Array): { pad: number; padByte: number; size: number } {
  const t = trimFlash(Buffer.from(image.buffer, image.byteOffset, image.byteLength));
  writeFileSync(join(dir, "flash.bin"), t.data);
  return { pad: t.pad, padByte: t.padByte, size: image.length };
}

function readCachedFlash(dir: string): Uint8Array | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "flash.json"), "utf8")) as { pad: number; padByte: number };
    const data = readFileSync(join(dir, "flash.bin"));
    const out = new Uint8Array(data.length + meta.pad).fill(meta.padByte);
    out.set(data);
    return out;
  } catch {
    return undefined;
  }
}
