import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { cacheDir, imageFor, PINNED_LIBRARIES, platformFor, RUNNER_IMAGE, SUPPORTED_FQBNS } from "./config.ts";
import { parseCompilerOutput, type CompileDiagnostic } from "./diagnostics.ts";
import { ensureDocker, ensureImage, exec, RunnerError } from "./docker.ts";

export interface BuildRequest {
  /** Absolute folder holding the sketch sources: every .ino/.h/.hpp/.c/.cpp/.S in it (and its src/ folder). */
  sketchDir: string;
  /** Main .ino file inside sketchDir. Default: the only .ino, or the one named like the folder. */
  main?: string;
  /** e.g. "arduino:avr:uno", "rp2040:rp2040:rpipico" (picks the Docker image). */
  fqbn: string;
  /** "Name" or "Name@version". Names without a version resolve to Jumper's pinned versions. */
  libraries?: readonly string[];
  /** Prefix for file paths in diagnostics, e.g. "firmware/" so errors read "firmware/pet.ino:12". */
  displayPrefix?: string;
  /** Reuse a cached result for identical inputs (default true). */
  cache?: boolean;
  /** Progress lines (image builds, library installs). */
  log?: (line: string) => void;
}

export interface BuildResult {
  ok: boolean;
  /** Intel HEX text (when ok). */
  hex?: string;
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
      throw new RunnerError("bad-library", `Library '${spec}' has an invalid version '${version}'. Fix: write it as "Name@1.2.3" (as shown in the Arduino Library Manager) or just "Name" for Jumper's pinned version.`);
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

function isPreinstalled(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : "";
  const p = PINNED_LIBRARIES[name];
  return !!p && p.preinstalled && p.version === version;
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
async function ensureLibrary(spec: string, log: (l: string) => void): Promise<string> {
  const root = join(cacheDir(), "arduino-libs");
  const dir = join(root, slug(spec));
  if (existsSync(join(dir, ".ok"))) return `/extra/${slug(spec)}/libraries`;
  mkdirSync(dir, { recursive: true });
  log(`installing Arduino library ${spec}…`);
  const r = await exec(
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
  return `/extra/${slug(spec)}/libraries`;
}

/**
 * Compile a sketch with arduino-cli in the pinned Docker image. Identical inputs return the cached result.
 * Throws RunnerError only for environment problems (Docker missing, image/library install failures);
 * compile errors come back as `ok: false` with diagnostics.
 */
export async function buildFirmware(req: BuildRequest): Promise<BuildResult> {
  const t0 = Date.now();
  const log = req.log ?? (() => {});
  if (!existsSync(req.sketchDir)) {
    throw new RunnerError("no-sketch", `Build failed: the sketch folder ${req.sketchDir} does not exist. Fix: write the sketch first, e.g. write_file("firmware/main.ino", "...").`);
  }
  const sources = collectSources(req.sketchDir);
  const main = pickMain(sources, req.sketchDir, req.main);
  const libraries = resolveLibraries(req.libraries);

  const h = createHash("sha256");
  h.update(`image=${imageFor(req.fqbn)}\nfqbn=${req.fqbn}\nmain=${main}\nlibs=${libraries.join(",")}\n`);
  for (const [f, c] of [...sources].sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${f}\0${c}\0`);
  const hash = h.digest("hex").slice(0, 24);

  const resultDir = join(cacheDir(), "builds", hash);
  if (req.cache !== false && existsSync(join(resultDir, "result.json"))) {
    const cached = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8")) as BuildResult;
    return { ...cached, diagnostics: refineWithSources(cached.diagnostics, sources), cached: true, durationMs: Date.now() - t0 };
  }
  const running = inflight.get(hash);
  if (running) return running;
  const p = compile(req, sources, main, libraries, hash, resultDir, log, t0).finally(() => inflight.delete(hash));
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
export function sketchSetupFlags(sources: Map<string, string>, forceInclude?: string): string[] {
  const setup = SKETCH_SETUP_HEADERS.some((h) => sources.has(h));
  if (!setup && !forceInclude) return [];
  const cpp = [...(setup ? ["-I/work/sketch"] : []), ...(forceInclude ? [`-include ${forceInclude}`] : [])].join(" ");
  return ["--build-property", `compiler.cpp.extra_flags=${cpp}`, ...(setup ? ["--build-property", "compiler.c.extra_flags=-I/work/sketch"] : [])];
}

async function compile(
  req: BuildRequest,
  sources: Map<string, string>,
  main: string,
  libraries: string[],
  hash: string,
  resultDir: string,
  log: (l: string) => void,
  t0: number,
): Promise<BuildResult> {
  await ensureDocker();
  const platform = platformFor(req.fqbn);
  const image = imageFor(req.fqbn);
  await ensureImage(log, image);
  const libDirs: string[] = [];
  for (const lib of libraries) if (!isPreinstalled(lib)) libDirs.push(await ensureLibrary(lib, log));

  // Arduino wants <name>/<name>.ino; we always use "sketch/sketch.ino" and map paths back.
  const work = join(cacheDir(), "work", hash);
  rmSync(work, { recursive: true, force: true });
  const sketchOut = join(work, "sketch");
  for (const [rel, content] of sources) {
    const dest = join(sketchOut, rel === main ? "sketch.ino" : rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, content);
  }
  mkdirSync(join(work, "out"), { recursive: true });
  // Boards whose Serial is USB CDC (not emulated): the simulator build prints Serial on the hardware UART.
  if (platform.simSerialHeader) writeFileSync(join(work, "jumper_sim_serial.h"), platform.simSerialHeader);
  const libRoot = join(cacheDir(), "arduino-libs");
  mkdirSync(libRoot, { recursive: true });

  const args = [
    "run", "--rm", ...uidArgs(), ...(platform.dockerPlatform ? ["--platform", platform.dockerPlatform] : []),
    "-v", `${work}:/work`, "-v", `${libRoot}:/extra:ro`, "-w", "/work",
    image,
    "compile", "--fqbn", req.fqbn, "--output-dir", "/work/out", "--warnings", "default",
    ...libDirs.flatMap((d) => ["--libraries", d]),
    ...sketchSetupFlags(sources, platform.simSerialHeader ? "/work/jumper_sim_serial.h" : undefined),
    "/work/sketch",
  ];
  const r = await exec("docker", args, { timeoutMs: 5 * 60_000 });
  // eslint-disable-next-line no-control-regex
  const output = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  if (/Unable to find image|Cannot connect to the Docker daemon/.test(r.stderr)) {
    throw new RunnerError("docker-not-running", `Build failed: ${r.stderr.trim().split("\n")[0]}. Fix: start Docker Desktop and build again.`);
  }
  if (/Invalid FQBN|platform not installed|Platform '[^']+' not found/i.test(output)) {
    throw new RunnerError("bad-fqbn", `Build failed: the board '${req.fqbn}' is not supported by the build image (${output.trim().split("\n").find((l) => /fqbn|platform/i.test(l)) ?? ""}). Fix: use one of ${SUPPORTED_FQBNS.map((f) => `"${f}"`).join(", ")} (firmware.build.fqbn; the board part's mcu.fqbn is the default).`);
  }
  const prefix = req.displayPrefix ?? "";
  const pathMap = (p: string): string | undefined => {
    const m = p.match(/^(?:\/work\/sketch|\/tmp\/[^/]*\/sketch)\/(.+)$/) ?? p.match(/^(?:.*\/)?sketch\/(sketch\.ino(?:\.cpp)?)$/);
    if (!m) return undefined;
    let rel = m[1]!.replace(/\.ino\.cpp$/, ".ino");
    if (rel === "sketch.ino") rel = main;
    return prefix + rel;
  };
  const diagnostics = refineWithSources(parseCompilerOutput(output, pathMap), sources);
  const hexPath = join(work, "out", platform.simHex ? "sketch.ino.sim.hex" : "sketch.ino.hex");
  const ok = r.code === 0 && existsSync(hexPath);
  if (!ok && !diagnostics.some((d) => d.severity === "error")) {
    diagnostics.push({ severity: "error", message: `arduino-cli exited with code ${r.code}: ${output.trim().split("\n").slice(-4).join(" | ")}`, hint: "Read the message above; if it mentions a library, add it to firmware.libraries." });
  }
  const result: BuildResult = {
    ok,
    ...(ok ? { hex: readFileSync(hexPath, "utf8") } : {}),
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
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(join(resultDir, "result.json"), JSON.stringify(result));
  rmSync(work, { recursive: true, force: true });
  return result;
}
