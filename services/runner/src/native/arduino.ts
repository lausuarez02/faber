// Round 11: Fabwright's native Arduino toolchain, for a machine without (working) Docker. The same
// pinned arduino-cli, cores and libraries as the Docker images (toolchains/*/Dockerfile), installed
// under ~/.fabwright/toolchains/arduino/<cli version> with Fabwright's own data / user / download folders,
// so it never touches a person's Arduino IDE install (~/Library/Arduino15, ~/Documents/Arduino).
//
//   bin/arduino-cli              the release binary, SHA-256 checked
//   data/                        cores and their compilers (ARDUINO_DIRECTORIES_DATA)
//   user/base/libraries          the libs3 set + Servo + Fabwright's LiquidCrystal_I2C (the runner image)
//   user/esp32/libraries         base + network libraries + FabwrightEth + FabwrightSim (arduino-esp32 r3)
//   shims/python                 `python` for core recipes that call it (Seeed nRF52's UF2 step)
//   installed/<family>.json      written last: the family is ready
//
// The post-build steps the images' entrypoints do (RP2040 ELF -> Intel HEX, the ESP32 Wi-Fi / TLS
// shim and padded merged flash, the nRF52 sim.hex) run here too, so a native build gives the runner
// the same files a Docker build does.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fabwrightHome } from "@fabwright/sim-backends/node";
import { REPO_ROOT } from "../config.ts";
import { RunnerError, type ExecResult } from "../docker.ts";

export const ARDUINO_CLI_VERSION = "1.5.1";

/** arduino-cli release archives (https://github.com/arduino/arduino-cli/releases/tag/v1.5.1, 1.5.1-checksums.txt). */
export const ARDUINO_CLI_ASSETS: Record<string, { file: string; sha256: string }> = {
  "darwin-arm64": { file: "arduino-cli_1.5.1_macOS_ARM64.tar.gz", sha256: "cb952e8c1621c95ef5f1d17831c945e3d0ec5973f89c557a7ec8feb9c4f7d4c9" },
  "darwin-x64": { file: "arduino-cli_1.5.1_macOS_64bit.tar.gz", sha256: "c982e940027996bea9901050e95fae99c59c1dcfee54beedecaf28141e7bf2e7" },
  "linux-x64": { file: "arduino-cli_1.5.1_Linux_64bit.tar.gz", sha256: "28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b" },
  "linux-arm64": { file: "arduino-cli_1.5.1_Linux_ARM64.tar.gz", sha256: "1e69e077479f300614d4551334e0a33f08ee40b04315d83b8e7e0e94f0d0ee62" },
};

export type NativeFamily = "avr" | "rp2040" | "esp32" | "stm32" | "mbed_nano" | "nrf52";

export interface NativeCore {
  family: NativeFamily;
  label: string;
  /** "vendor:arch@version", the same pin as the family's Dockerfile. */
  core: string;
  /** Board manager index for cores outside Arduino's own index. */
  index?: string;
  /** FQBN prefix this core builds. */
  prefix: string;
  /** Library set: "base" (runner image) or "esp32" (arduino-esp32 r3 image). */
  libs: "base" | "esp32";
  /** What the first install downloads / takes, measured on an M4 Max (round 11). */
  size: string;
  /** Tools of this core that only exist for x86-64 (run through Rosetta on Apple silicon). */
  x64Tools?: string;
  /** Folders under data/packages/ the Dockerfile deletes after the install (other chips, debuggers). */
  prune?: string[];
  /** The core's GCC knows -ffile-prefix-map (GCC 8+), so paths in the firmware read as in the image. */
  prefixMap?: boolean;
}

const PICO_INDEX = "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json";
const ESP32_INDEX = "https://espressif.github.io/arduino-esp32/package_esp32_index.json";
const STM_INDEX = "https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json";
const SEEED_INDEX = "https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json";
export const NATIVE_INDEXES = [PICO_INDEX, ESP32_INDEX, STM_INDEX, SEEED_INDEX];

/** One entry per Docker build image (services/runner/src/config.ts PLATFORMS), same core versions. */
export const NATIVE_CORES: Record<NativeFamily, NativeCore> = {
  avr: { family: "avr", label: "Arduino AVR (Uno, Nano)", core: "arduino:avr@1.8.8", prefix: "arduino:avr:", libs: "base", size: "about 190 MB, 1 minute" },
  rp2040: { family: "rp2040", label: "RP2040 (arduino-pico)", core: "rp2040:rp2040@6.3.1", index: PICO_INDEX, prefix: "rp2040:rp2040:", libs: "base", prefixMap: true, size: "about 700 MB, 1 minute", prune: ["rp2040/tools/pqt-gcc-riscv", "rp2040/tools/pqt-openocd"] },
  esp32: { family: "esp32", label: "ESP32 / S3 / C3 (arduino-esp32)", core: "esp32:esp32@3.3.12", index: ESP32_INDEX, prefix: "esp32:esp32:", libs: "esp32", prefixMap: true, size: "about 2.5 GB, 4 minutes",
    prune: ["esp32c5-libs", "esp32c6-libs", "esp32h2-libs", "esp32p4-libs", "esp32p4_es-libs", "esp32s2-libs", "xtensa-esp-elf-gdb", "riscv32-esp-elf-gdb", "openocd-esp32", "dfu-util"].map((t) => `esp32/tools/${t}`) },
  stm32: { family: "stm32", label: "STM32 (STM32duino)", core: "STMicroelectronics:stm32@2.11.0", index: STM_INDEX, prefix: "STMicroelectronics:stm32:", libs: "base", prefixMap: true, size: "about 1.5 GB, 2 minutes" },
  mbed_nano: { family: "mbed_nano", label: "Arduino Nano 33 BLE (Mbed)", core: "arduino:mbed_nano@4.4.1", prefix: "arduino:mbed_nano:", libs: "base", size: "about 600 MB, 1 minute" },
  nrf52: { family: "nrf52", label: "Seeed XIAO nRF52840", core: "Seeeduino:nrf52@1.1.13", index: SEEED_INDEX, prefix: "Seeeduino:nrf52:", libs: "base", prefixMap: true, size: "about 500 MB, 1 minute", x64Tools: "adafruit-nrfutil (the DFU zip step)" },
};

/** Board families `fabwright setup` takes (a family can need several cores). */
export const SETUP_FAMILIES: Record<string, { label: string; cores: NativeFamily[] }> = {
  avr: { label: "Arduino Uno / Nano (AVR)", cores: ["avr"] },
  rp2040: { label: "RP2040 (Pico, XIAO RP2040, RP2040-Zero)", cores: ["rp2040"] },
  esp32: { label: "ESP32 / S3 / C3", cores: ["esp32"] },
  stm32: { label: "STM32 (Blue Pill, Black Pill, Nucleo)", cores: ["stm32"] },
  nrf52: { label: "nRF52840 (Nano 33 BLE, XIAO nRF52840)", cores: ["mbed_nano", "nrf52"] },
};

/** The libs3 set, exactly as toolchains/arduino/Dockerfile + services/runner/docker/Dockerfile install it (--no-deps). */
export const BASE_LIBRARIES = [
  "Adafruit BusIO@1.17.4",
  "Adafruit GFX Library@1.13.0",
  "Adafruit SSD1306@2.5.17",
  "Adafruit Unified Sensor@1.1.15",
  "Adafruit BME280 Library@2.3.0",
  "Adafruit MPU6050@2.2.9",
  "RTClib@2.1.4",
  "LiquidCrystal_PCF8574@2.3.0",
  "MPU6050@1.4.5",
  "U8g2@2.36.19",
  "Adafruit ILI9341@1.7.0",
  "Adafruit ST7735 and ST7789 Library@1.12.0",
  "Adafruit GC9A01A@1.2.0",
  "DHT sensor library@1.4.7",
  "FastLED@3.10.8",
  "TFT_eSPI@2.5.43",
  "Adafruit NeoPixel@1.15.5",
  "Servo@1.3.0",
];
/** toolchains/arduino-esp32/Dockerfile.sim: installed with their dependencies, as there. */
export const ESP32_NETWORK_LIBRARIES = ["PubSubClient@2.8.0", "MQTT@2.5.3", "ArduinoJson@7.4.3", "WebSockets@2.7.2"];

export function nativeArduinoDir(): string {
  return join(fabwrightHome(), "toolchains", "arduino", ARDUINO_CLI_VERSION);
}

function hostKey(): string {
  return `${platform()}-${arch()}`;
}

export function arduinoCliPath(): string {
  return join(nativeArduinoDir(), "bin", process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli");
}

export function nativeFamilyOf(fqbn: string): NativeFamily | undefined {
  return (Object.values(NATIVE_CORES).find((c) => fqbn.startsWith(c.prefix)) ?? undefined)?.family;
}

function stampPath(f: NativeFamily): string {
  return join(nativeArduinoDir(), "installed", `${f}.json`);
}

/** True when the family's core (and its library set) is installed natively and matches the pins here. */
export function nativeCoreInstalled(f: NativeFamily): boolean {
  try {
    const s = JSON.parse(readFileSync(stampPath(f), "utf8")) as { core?: string; cli?: string };
    return s.core === NATIVE_CORES[f].core && s.cli === ARDUINO_CLI_VERSION && existsSync(arduinoCliPath());
  } catch {
    return false;
  }
}

/** Identifies a native build's toolchain in the build cache key (never shared with a Docker build's key). */
export function nativeToolchainId(f: NativeFamily): string {
  return `native:arduino-cli@${ARDUINO_CLI_VERSION}/${NATIVE_CORES[f].core}/${NATIVE_CORES[f].libs === "esp32" ? "libs3+net-r3" : "libs3-r1"}/${hostKey()}`;
}

/** The environment every native arduino-cli call runs with. */
export function nativeEnv(libs: "base" | "esp32", extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const d = nativeArduinoDir();
  return {
    ...process.env,
    ARDUINO_DIRECTORIES_DATA: join(d, "data"),
    ARDUINO_DIRECTORIES_DOWNLOADS: join(d, "downloads"),
    ARDUINO_DIRECTORIES_USER: join(d, "user", libs),
    ARDUINO_UPDATER_ENABLE_NOTIFICATION: "false",
    ARDUINO_BUILD_CACHE_PATH: join(d, "build-cache"),
    ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS: NATIVE_INDEXES.join(" "),
    ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL: "false",
    // ctags (Arduino's prototype generator) fails with "cannot open temporary file" without TMPDIR,
    // which MCP stdio clients do not pass on.
    TMPDIR: process.env.TMPDIR || tmpdir(),
    PATH: `${join(d, "shims")}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

/** Run a command, streaming its output lines to `onLine`; never throws for a non-zero exit. */
export function run(cmd: string, args: readonly string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    const lines = (d: string) => {
      if (!o.onLine) return;
      partial += d;
      const parts = partial.split(/\r?\n|\r/);
      partial = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) o.onLine(p.trimEnd());
    };
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      lines(d.toString());
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      lines(d.toString());
    });
    const timer = o.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          stderr += `\n[fabwright] killed after ${o.timeoutMs} ms`;
        }, o.timeoutMs)
      : undefined;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function tail(s: string, n = 6): string {
  return s.trim().split("\n").slice(-n).join(" | ");
}

/** Download `url` to `dest`, checking its SHA-256 when given; progress every ~10 %. */
export async function download(url: string, dest: string, sha256: string | undefined, log: (l: string) => void, what: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw new RunnerError("download-failed", `Could not download ${what} from ${url}: ${(err as Error).message}. Why: no network connection, or GitHub is unreachable. Fix: check your connection, then run the setup again.`);
  }
  if (!res.ok || !res.body) throw new RunnerError("download-failed", `Could not download ${what}: ${url} answered HTTP ${res.status}. Fix: check your connection, then run the setup again.`);
  const total = Number(res.headers.get("content-length")) || 0;
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const out = createWriteStream(tmp);
  const h = createHash("sha256");
  let got = 0;
  let next = 0.1;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    h.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    if (total && got / total >= next) {
      log(`  ${what}: ${Math.round((got / total) * 100)} % of ${(total / 1e6).toFixed(1)} MB`);
      next += 0.1;
    }
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  const digest = h.digest("hex");
  if (sha256 && digest !== sha256) {
    rmSync(tmp, { force: true });
    throw new RunnerError("checksum-mismatch", `${what} failed its checksum (got ${digest}, expected ${sha256}). Why: the download was damaged or the file on the server changed. Fix: run the setup again; if it repeats, do not use this file and report it.`);
  }
  renameSync(tmp, dest);
}

/** Download, verify and unpack arduino-cli into bin/ (once). */
export async function ensureArduinoCli(log: (l: string) => void = () => {}): Promise<string> {
  const cli = arduinoCliPath();
  if (existsSync(cli)) {
    const v = await run(cli, ["version"]).catch(() => undefined);
    if (v && v.code === 0 && v.stdout.includes(`Version: ${ARDUINO_CLI_VERSION}`)) return cli;
  }
  const asset = ARDUINO_CLI_ASSETS[hostKey()];
  if (!asset) {
    throw new RunnerError("native-unsupported", `Fabwright has no native arduino-cli for ${hostKey()}. Why: the native toolchain is pinned for macOS (arm64, x64) and Linux (x64, arm64). Fix: use Docker on this machine (start Docker Desktop, FABWRIGHT_RUNTIME=docker).`);
  }
  const dl = join(nativeArduinoDir(), "downloads", asset.file);
  log(`downloading arduino-cli ${ARDUINO_CLI_VERSION} (${asset.file}, SHA-256 checked)…`);
  await download(`https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/${asset.file}`, dl, asset.sha256, log, "arduino-cli");
  mkdirSync(dirname(cli), { recursive: true });
  const r = await run("tar", ["-xzf", dl, "-C", dirname(cli), "arduino-cli"]);
  if (r.code !== 0) throw new RunnerError("unpack-failed", `Could not unpack ${asset.file}: ${tail(r.stderr)}. Fix: free some disk space, then run the setup again.`);
  chmodSync(cli, 0o755);
  rmSync(dl, { force: true });
  return cli;
}

function writeShims(): void {
  const dir = join(nativeArduinoDir(), "shims");
  mkdirSync(dir, { recursive: true });
  // Seeed's nRF52 core runs `python uf2_wrap.py`; macOS and many Linux systems only have python3.
  const py = join(dir, "python");
  writeFileSync(py, '#!/bin/sh\nexec python3 "$@"\n');
  chmodSync(py, 0o755);
}

async function cli(args: string[], libs: "base" | "esp32", log: (l: string) => void, timeoutMs = 60 * 60_000): Promise<ExecResult> {
  // Progress bars ("12.5 MiB / 311.6 MiB  4.01%") repeat many times a second: keep the "downloaded" /
  // "installed" lines only.
  return run(arduinoCliPath(), args, { env: nativeEnv(libs), timeoutMs, onLine: (l) => (/\d B \/ |iB \/ /.test(l) ? undefined : log(`  ${l}`)) });
}

let indexUpdated = false;

async function ensureIndex(log: (l: string) => void): Promise<void> {
  if (indexUpdated) return;
  log("updating the Arduino board and library indexes…");
  let r = await cli(["core", "update-index"], "base", log, 10 * 60_000);
  if (r.code !== 0) throw new RunnerError("index-failed", `Could not update the Arduino board index: ${tail(r.stderr || r.stdout)}. Why: one of the board manager URLs did not answer (${NATIVE_INDEXES.join(", ")}). Fix: check your connection, then run the setup again.`);
  r = await cli(["lib", "update-index"], "base", log, 10 * 60_000);
  if (r.code !== 0) throw new RunnerError("index-failed", `Could not update the Arduino library index: ${tail(r.stderr || r.stdout)}. Fix: check your connection, then run the setup again.`);
  indexUpdated = true;
}

function libsDir(libs: "base" | "esp32"): string {
  return join(nativeArduinoDir(), "user", libs, "libraries");
}

async function ensureLibrarySet(libs: "base" | "esp32", log: (l: string) => void): Promise<void> {
  const stamp = join(nativeArduinoDir(), "user", libs, ".fabwright-libs.json");
  const want = { base: BASE_LIBRARIES, net: libs === "esp32" ? ESP32_NETWORK_LIBRARIES : [], rev: 1 };
  try {
    if (JSON.stringify(JSON.parse(readFileSync(stamp, "utf8"))) === JSON.stringify(want)) return;
  } catch {
    // not installed yet
  }
  await ensureIndex(log);
  log(`installing the pinned Arduino libraries (${libs === "esp32" ? "libs3 + network libraries + FabwrightEth / FabwrightSim" : "libs3 + Servo"})…`);
  let r = await cli(["lib", "install", "--no-deps", ...BASE_LIBRARIES], libs, log, 20 * 60_000);
  if (r.code !== 0) throw new RunnerError("library-install-failed", `Could not install Fabwright's pinned Arduino libraries: ${tail(r.stderr || r.stdout)}. Fix: check your connection, then run the setup again.`);
  if (libs === "esp32") {
    r = await cli(["lib", "install", ...ESP32_NETWORK_LIBRARIES], libs, log, 20 * 60_000);
    if (r.code !== 0) throw new RunnerError("library-install-failed", `Could not install the ESP32 network libraries (${ESP32_NETWORK_LIBRARIES.join(", ")}): ${tail(r.stderr || r.stdout)}. Fix: check your connection, then run the setup again.`);
  }
  const own = [join(REPO_ROOT, "toolchains/arduino/libraries/LiquidCrystal_I2C")];
  if (libs === "esp32") own.push(join(REPO_ROOT, "toolchains/arduino-esp32/libraries/FabwrightEth"), join(REPO_ROOT, "toolchains/arduino-esp32/libraries/FabwrightSim"));
  for (const src of own) {
    const dest = join(libsDir(libs), basename(src));
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }
  writeFileSync(stamp, JSON.stringify(want));
}

/** Installed size of a folder in bytes (du -sk). */
export async function folderBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const r = await run("du", ["-sk", dir]);
  return Number(r.stdout.trim().split(/\s+/)[0] ?? 0) * 1024;
}

const installing = new Map<NativeFamily, Promise<void>>();

/**
 * Installs one core natively with progress: arduino-cli, the board index, the core at its pinned
 * version (arduino-cli checks every archive's checksum from the index), the library set. Returns at
 * once when it is already there.
 */
export function installNativeCore(f: NativeFamily, log: (l: string) => void = () => {}): Promise<void> {
  let p = installing.get(f);
  if (!p) {
    p = (async () => {
      if (nativeCoreInstalled(f)) return;
      const c = NATIVE_CORES[f];
      await ensureArduinoCli(log);
      writeShims();
      await ensureIndex(log);
      log(`installing ${c.core} (${c.label}; ${c.size})…`);
      let r: ExecResult | undefined;
      // Large cores come as many archives; a transient "unexpected EOF" must not end the setup
      // (arduino-cli resumes from its download folder and re-checks every checksum).
      for (let i = 0; i < 4; i++) {
        r = await cli(["core", "install", c.core], "base", log);
        if (r.code === 0) break;
        log(`  retrying (${i + 1}/3): ${tail(r.stderr || r.stdout, 1)}`);
      }
      if (!r || r.code !== 0) {
        throw new RunnerError("core-install-failed", `Could not install ${c.core}: ${tail(r?.stderr || r?.stdout || "")}. Why: a download failed or the disk is full. Fix: check your connection and free disk space (${c.size}), then run \`fabwright setup\` again.`);
      }
      await ensureLibrarySet(c.libs, log);
      pruneCore(f);
      rmSync(join(nativeArduinoDir(), "downloads"), { recursive: true, force: true });
      mkdirSync(dirname(stampPath(f)), { recursive: true });
      writeFileSync(stampPath(f), JSON.stringify({ core: c.core, cli: ARDUINO_CLI_VERSION, libs: c.libs, host: hostKey(), at: new Date().toISOString() }));
    })().finally(() => installing.delete(f));
    installing.set(f, p);
  }
  return p;
}

/** Deletes what the family's Dockerfile deletes after the install (idempotent). */
export function pruneCore(f: NativeFamily): void {
  for (const rel of NATIVE_CORES[f].prune ?? []) rmSync(join(nativeArduinoDir(), "data", "packages", rel), { recursive: true, force: true });
}

/** The ESP32 shim's include test (toolchains/arduino-esp32/fabwright-arduino-esp32.sh NETWORK_INCLUDES). */
const NETWORK_INCLUDE = /#[ \t]*include[ \t]*[<"](WiFi|WiFiMulti|WiFiClient|WiFiClientSecure|WiFiUdp|WiFiServer|WiFiGeneric|NetworkClientSecure|NetworkClient|Network|HTTPClient|HTTPUpdate|WebServer|WebSocketsClient|WebSockets|WebSocketsServer|ArduinoWebsockets|PubSubClient|MQTT|MQTTClient|ArduinoMqttClient|AsyncMqttClient|ESPmDNS|AsyncUDP|esp_wifi|esp_http_client|esp_websocket_client|mqtt_client)\.h[>"]/;

/** The camera shim's include test (toolchains/arduino-esp32/fabwright-arduino-esp32.sh CAMERA_INCLUDES). */
export const CAMERA_SHIM_INCLUDE = /#[ \t]*include[ \t]*[<"](esp_camera|esp_camera_af)\.h[>"]/;
const CAMERA_INCLUDE = CAMERA_SHIM_INCLUDE;

function sketchIncludes(dir: string, re: RegExp): boolean {
  const walk = (d: string): boolean => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (walk(p)) return true;
      } else if (/\.(ino|cpp|c|h|hpp)$/.test(name) && re.test(readFileSync(p, "utf8"))) return true;
    }
    return false;
  };
  return existsSync(dir) && walk(dir);
}

const sketchUsesNetwork = (dir: string) => sketchIncludes(dir, NETWORK_INCLUDE);
/** True when the sketch uses Espressif's esp32-camera driver (esp_camera.h). */
export const sketchUsesCamera = (dir: string) => sketchIncludes(dir, CAMERA_INCLUDE);

/** Round 15: the deep-sleep shim's trigger (toolchains/arduino-esp32/fabwright-arduino-esp32.sh SLEEP_CALLS): the sketch deep-sleeps. */
export const SLEEP_SHIM_CALL = /\besp_deep_sleep(_start|_try_to_start)?\s*\(/;
/** True when the sketch calls esp_deep_sleep / esp_deep_sleep_start. */
export const sketchUsesSleep = (dir: string) => sketchIncludes(dir, SLEEP_SHIM_CALL);
/** The deep-sleep shim library, used straight from the repo (simulation builds only). */
export const FABWRIGHT_SLEEP_LIB = join(REPO_ROOT, "toolchains/arduino-esp32/libraries/FabwrightSleep");

/** The camera shim library, used straight from the repo (simulation builds only; never installed into the person's sketchbook). */
export const FABWRIGHT_CAMERA_LIB = join(REPO_ROOT, "toolchains/arduino-esp32/libraries/FabwrightCamera");

/** Content hash of the camera shim's sources (part of a camera sketch's build cache key). */
export function cameraShimHash(): string {
  return shimHash(FABWRIGHT_CAMERA_LIB);
}

/** Round 15: content hash of the deep-sleep shim's sources (part of a sleeping sketch's build cache key). */
export function sleepShimHash(): string {
  return shimHash(FABWRIGHT_SLEEP_LIB);
}

function shimHash(lib: string): string {
  const h = createHash("sha256");
  const src = join(lib, "src");
  if (existsSync(src)) for (const f of readdirSync(src).sort()) h.update(`${f}\0${readFileSync(join(src, f))}\0`);
  return h.digest("hex").slice(0, 16);
}

/** -Wl,--wrap=… for every __wrap_<symbol> a shim library's C files define. */
export function wrapFlagsOf(srcDir: string): string[] {
  const wraps = new Set<string>();
  for (const file of readdirSync(srcDir).filter((n) => n.endsWith(".c"))) for (const m of readFileSync(join(srcDir, file), "utf8").matchAll(/__wrap_[A-Za-z0-9_]*/g)) wraps.add(m[0]);
  return [...wraps].sort().map((w) => w.replace(/^__wrap_/, "-Wl,--wrap="));
}

function findFirst(dir: string, rel: (v: string) => string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const v of readdirSync(dir).sort().reverse()) {
    const p = join(dir, rel(v));
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Paths the compiler writes into the firmware (__FILE__ in asserts, debug info) as the Docker image
 * has them: /opt/arduino/data, /opt/arduino/user, /work and the image's build folder. So a native
 * build never carries the person's home folder, and comes out as close to the image's bytes as the
 * host compilers allow. Appended to compiler.{c,cpp,S}.extra_flags (merged with any the runner set).
 */
export function prefixMapArgs(args: readonly string[], f: NativeFamily, workDir: string, buildPath: string): string[] {
  if (!NATIVE_CORES[f].prefixMap) return [...args];
  const d = nativeArduinoDir();
  const maps = [
    `-ffile-prefix-map=${join(d, "data")}=/opt/arduino/data`,
    `-ffile-prefix-map=${join(d, "user", NATIVE_CORES[f].libs)}=/opt/arduino/user`,
    `-ffile-prefix-map=${buildPath}=/tmp/arduino/sketches/${createHash("md5").update("/work/sketch").digest("hex").toUpperCase()}`,
    `-ffile-prefix-map=${workDir}=/work`,
  ].join(" ");
  const out = [...args];
  for (const kind of ["c", "cpp", "S"]) {
    const key = `compiler.${kind}.extra_flags=`;
    const i = out.findIndex((a, j) => out[j - 1] === "--build-property" && a.startsWith(key));
    if (i >= 0) out[i] = `${out[i]} ${maps}`;
    else out.push("--build-property", `${key}${maps}`);
  }
  return out;
}

export interface NativeCompile {
  fqbn: string;
  /** `compile` arguments without the sketch, which comes last. */
  args: string[];
  sketch: string;
  outDir: string;
  /** Scratch folder for the shim's sketch copy. */
  workDir: string;
  /** "device" builds leave the ESP32 simulation shim out (FABWRIGHT_SIM=0). */
  purpose?: "simulator" | "device";
  timeoutMs?: number;
}

/**
 * `arduino-cli compile` with the native toolchain, plus the post-build step the family's Docker
 * entrypoint does, so out/ holds the same files. Returns the combined result (exit code of the
 * first failing step).
 */
export async function compileNative(c: NativeCompile): Promise<ExecResult & { sketchCopy?: string }> {
  const f = nativeFamilyOf(c.fqbn);
  if (!f || !nativeCoreInstalled(f)) {
    throw new RunnerError("native-missing", `Build failed: the native toolchain for ${c.fqbn} is not installed. Fix: run \`fabwright setup ${f ? Object.entries(SETUP_FAMILIES).find(([, s]) => s.cores.includes(f))?.[0] : "list"}\`, then build again.`);
  }
  const core = NATIVE_CORES[f];
  const data = join(nativeArduinoDir(), "data");
  let args = [...c.args];
  let sketch = c.sketch;
  let sketchCopy: string | undefined;
  let note = "";
  if (f === "esp32" && c.purpose !== "device") {
    // fabwright-arduino-esp32.sh, simulation build: each shim the sketch needs adds one include file
    // to a copy of the sketch (the person's files are never touched) and its link-time wraps.
    const net = sketchUsesNetwork(sketch);
    const cam = sketchUsesCamera(sketch);
    const slp = sketchUsesSleep(sketch);
    if (net || cam || slp) {
      sketchCopy = join(c.workDir, "jsim", basename(sketch));
      rmSync(dirname(sketchCopy), { recursive: true, force: true });
      cpSync(sketch, sketchCopy, { recursive: true });
      const wrapFlags: string[] = [];
      if (net) {
        writeFileSync(join(sketchCopy, "zz_fabwright_sim_shim.cpp"), "// Added by Fabwright for the simulation build only (not in your project).\n#include <FabwrightSim.h>\n");
        wrapFlags.push(...wrapFlagsOf(join(libsDir("esp32"), "FabwrightSim", "src")));
        note += "fabwright: simulation build, Wi-Fi shim on (WiFi.begin() joins the Fabwright sandbox network over the emulated Ethernet card)\n";
      }
      if (cam) {
        writeFileSync(join(sketchCopy, "zz_fabwright_camera_shim.cpp"), "// Added by Fabwright for the simulation build only (not in your project).\n#include <FabwrightCamera.h>\n");
        wrapFlags.push(...wrapFlagsOf(join(FABWRIGHT_CAMERA_LIB, "src")));
        args = [...args, "--library", FABWRIGHT_CAMERA_LIB];
        note += "fabwright: simulation build, camera shim on (esp_camera_fb_get() gets frames from Fabwright; the device build uses the real esp32-camera driver)\n";
      }
      if (slp) {
        writeFileSync(join(sketchCopy, "zz_fabwright_sleep_shim.cpp"), "// Added by Fabwright for the simulation build only (not in your project).\n#include <FabwrightSleep.h>\n");
        wrapFlags.push(...wrapFlagsOf(join(FABWRIGHT_SLEEP_LIB, "src")));
        args = [...args, "--library", FABWRIGHT_SLEEP_LIB];
        note += "fabwright: simulation build, deep-sleep shim on (esp_deep_sleep_start() hands the board to Fabwright, which wakes it on its timer or wake pins; RTC memory and the clock survive)\n";
      }
      // build.defines replaces the board menu's defines: keep BOARD_HAS_PSRAM for a PSRAM build, and
      // tell the camera shim the board has PSRAM the emulator lacks.
      const psram = /[:,]PSRAM=(opi|enabled)\b/.test(c.fqbn);
      const defines = ["-DFABWRIGHT_SIM=1", ...(psram ? ["-DBOARD_HAS_PSRAM", ...(cam ? ["-DFABWRIGHT_SIM_PSRAM_FALLBACK=1"] : [])] : [])].join(" ");
      args = [...args, "--build-property", `build.defines=${defines}`, "--build-property", `compiler.c.elf.extra_flags=${wrapFlags.join(" ")} `];
      sketch = sketchCopy;
    } else {
      args = [...args, "--build-property", `build.defines=-DFABWRIGHT_SIM=1${/[:,]PSRAM=(opi|enabled)\b/.test(c.fqbn) ? " -DBOARD_HAS_PSRAM" : ""}`];
    }
  }
  // The build folder is ours (not the OS temp one) so it can be mapped to the image's path.
  const buildPath = join(c.workDir, "build");
  args = prefixMapArgs(["--build-path", buildPath, ...args], f, c.workDir, buildPath);
  const r = await run(arduinoCliPath(), ["compile", ...args, sketch], { env: nativeEnv(core.libs, c.purpose === "device" ? { FABWRIGHT_SIM: "0" } : {}), timeoutMs: c.timeoutMs ?? 10 * 60_000 });
  const out = { ...r, stdout: note + r.stdout, ...(sketchCopy ? { sketchCopy } : {}) };
  if (r.code !== 0) return out;
  try {
    if (f === "rp2040") {
      // toolchains/arduino-pico/fabwright-arduino.sh: ELF -> Intel HEX (flash at 0x10000000).
      const objcopy = findFirst(join(data, "packages/rp2040/tools/pqt-gcc"), (v) => `${v}/bin/arm-none-eabi-objcopy`);
      if (!objcopy) throw new Error("arm-none-eabi-objcopy not found in the arduino-pico toolchain");
      for (const elf of readdirSync(c.outDir).filter((n) => n.endsWith(".elf"))) {
        const x = await run(objcopy, ["-O", "ihex", join(c.outDir, elf), join(c.outDir, elf.replace(/\.elf$/, ".hex"))]);
        if (x.code !== 0) return { ...out, code: x.code, stderr: out.stderr + x.stderr };
      }
    } else if (f === "esp32") {
      // fabwright-arduino-esp32.sh: the merged image, padded to at least 4 MB for QEMU.
      const app = readdirSync(c.outDir).find((n) => n.endsWith(".ino.bin") && !n.endsWith(".merged.bin"));
      if (app) {
        const appPath = join(c.outDir, app);
        const merged = appPath.replace(/\.bin$/, ".merged.bin");
        if (!existsSync(merged)) {
          const esptool = findFirst(join(data, "packages/esp32/tools/esptool_py"), (v) => `${v}/esptool`);
          if (!esptool) throw new Error("esptool not found in the arduino-esp32 tools");
          const stem = appPath.replace(/\.bin$/, "");
          const x = await run(esptool, ["--chip", "auto", "merge-bin", "-o", merged, "--pad-to-size", "4MB", "0x1000", `${stem}.bootloader.bin`, "0x8000", `${stem}.partitions.bin`, "0x10000", appPath]);
          if (x.code !== 0) return { ...out, code: x.code, stderr: out.stderr + x.stderr };
        }
        if (statSync(merged).size < 4 * 1024 * 1024) truncateSync(merged, 4 * 1024 * 1024);
        out.stdout += `fabwright: flash image ${basename(merged)} ${statSync(merged).size} bytes\n`;
      }
    } else if (f === "nrf52") {
      // toolchains/arduino-nrf52/fabwright-arduino.sh: sim.hex (MBR + SoftDevice + app) and the .uf2.
      const coreDir = join(data, "packages/Seeeduino/hardware/nrf52", NATIVE_CORES.nrf52.core.split("@")[1]!);
      const x = await run("python3", [join(REPO_ROOT, "toolchains/arduino-nrf52/fabwright-sim-hex.py"), c.outDir], { env: { ...process.env, FABWRIGHT_NRF52_CORE: coreDir } });
      if (x.code !== 0) return { ...out, code: x.code, stderr: `${out.stderr}\nfabwright: writing the simulator hex failed: ${x.stderr}` };
    }
  } catch (err) {
    return { ...out, code: 1, stderr: `${out.stderr}\nfabwright: the post-build step failed: ${(err as Error).message}. Fix: run \`fabwright setup\` again to repair the native toolchain.` };
  }
  return out;
}

/** Install a non-pinned library (firmware.libraries "Name@x.y") natively into `userDir` (its own folder). */
export async function installLibraryNative(spec: string, userDir: string): Promise<ExecResult> {
  if (!existsSync(arduinoCliPath())) await ensureArduinoCli();
  return run(arduinoCliPath(), ["lib", "install", spec], { env: nativeEnv("base", { ARDUINO_DIRECTORIES_USER: userDir, ARDUINO_DIRECTORIES_DOWNLOADS: join(userDir, ".dl") }), timeoutMs: 10 * 60_000 });
}
