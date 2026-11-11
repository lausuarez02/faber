// MicroPython as a firmware language. There is no compile step: Jumper flashes the official,
// pinned MicroPython firmware for the chip and a littlefs filesystem holding the project's .py
// files at the address that firmware mounts, exactly what `mpremote cp` would leave on a real board.
// MicroPython then runs boot.py and main.py and offers its REPL on the console (USB CDC on the
// RP2040, UART0 on the ESP32 family), so the Serial panel is the REPL.
//
// Before flashing, every .py is compiled with mpy-cross (MicroPython's own compiler, WebAssembly
// build, MIT) to report syntax errors at file:line. Runtime errors are the firmware's tracebacks,
// mapped back to firmware/<file>:<line> by runtimeErrors().
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { cacheDir, REPO_ROOT } from "../config.ts";
import type { CompileDiagnostic } from "../diagnostics.ts";
import { RunnerError } from "../docker.ts";
import { espPartitions, flashToIntelHex, padFlash, uf2ToFlash } from "./images.ts";
import { buildLittleFs, checkLfsName } from "./littlefs.ts";

export const MICROPYTHON_VERSION = "1.29.0";

export interface MicroPythonFirmware {
  /** MicroPython board id (micropython.org/download/<id>). */
  id: string;
  version: string;
  chip: "rp2040" | "esp32" | "esp32c3" | "esp32s3";
  /** File name under https://micropython.org/resources/firmware/. */
  file: string;
  sha256: string;
  /** Shipped in the repo (gzip), so the board needs no download (MIT, see NOTICE). */
  bundled?: string;
  /** Board part types that get this build by default. */
  boards: readonly string[];
  layout:
    | { kind: "rp2040-uf2"; flashBytes: number; fsOffset: number; fsBytes: number }
    | { kind: "esp-bin"; flashOffset: number; flashMB: number };
  /** Verified in Jumper (a test boots it), or listed with the reason it is not. */
  verified: boolean;
  note?: string;
}

const RP2040_FLASH = 2 * 1024 * 1024;
/** MicroPython's rp2 port keeps 1408 KB of littlefs at the end of a 2 MB flash (352 blocks of 4 KB; read back with os.statvfs in the test). */
const RP2040_FS = 1408 * 1024;

export const MICROPYTHON_FIRMWARE: readonly MicroPythonFirmware[] = [
  {
    id: "RPI_PICO",
    version: MICROPYTHON_VERSION,
    chip: "rp2040",
    file: "RPI_PICO-20260824-v1.29.0.uf2",
    sha256: "e1160e602e277d85920adb5fe741435edccba9ba6ecadc85fdab75252eeff4e9",
    bundled: "toolchains/micropython/firmware/RPI_PICO-20260824-v1.29.0.uf2.gz",
    boards: ["raspberry-pi-pico", "waveshare-rp2040-zero"],
    layout: { kind: "rp2040-uf2", flashBytes: RP2040_FLASH, fsOffset: RP2040_FLASH - RP2040_FS, fsBytes: RP2040_FS },
    verified: true,
    note: "The RP2040-Zero has no official MicroPython build; the Pico build runs on it (same chip and 2 MB flash; its RGB LED is a WS2812 on GP16, driven with the neopixel module).",
  },
  {
    id: "SEEED_XIAO_RP2040",
    version: MICROPYTHON_VERSION,
    chip: "rp2040",
    file: "SEEED_XIAO_RP2040-20260824-v1.29.0.uf2",
    sha256: "eebd0fd611062f334281bd7470824fed13c67f42f4c1c4539d8a636fa7b8819e",
    boards: ["seeed-xiao-rp2040"],
    layout: { kind: "rp2040-uf2", flashBytes: RP2040_FLASH, fsOffset: RP2040_FLASH - RP2040_FS, fsBytes: RP2040_FS },
    verified: true,
  },
  {
    id: "ESP32_GENERIC",
    version: MICROPYTHON_VERSION,
    chip: "esp32",
    file: "ESP32_GENERIC-20260824-v1.29.0.bin",
    sha256: "e67ad6015a0a504c1fec9aa9bbf589d0432ed28e62546f4f8dd8a147f8bd95f6",
    boards: [],
    layout: { kind: "esp-bin", flashOffset: 0x1000, flashMB: 4 },
    verified: true,
  },
  {
    id: "ESP32_GENERIC_C3",
    version: MICROPYTHON_VERSION,
    chip: "esp32c3",
    file: "ESP32_GENERIC_C3-20260824-v1.29.0.bin",
    sha256: "bf72ed9eb88ad3a8f49d02c3d371f9ea34c90a8a303aeb9e324d8efd4a2a655a",
    boards: [],
    layout: { kind: "esp-bin", flashOffset: 0, flashMB: 4 },
    verified: true,
  },
  {
    id: "ESP32_GENERIC_S3",
    version: MICROPYTHON_VERSION,
    chip: "esp32s3",
    file: "ESP32_GENERIC_S3-20260824-v1.29.0.bin",
    sha256: "1dd9dcd27ba2d6a1cb7f7b49a063f46d3d807d68b0151161233920228285e300",
    boards: [],
    layout: { kind: "esp-bin", flashOffset: 0, flashMB: 8 },
    verified: false,
    note: "Stops after 'Failed to set QIE bit, not enabling QIO mode' in QEMU, with or without emulated PSRAM; its REPL is on USB-OTG, which QEMU does not model.",
  },
];

/** The firmware for a board part, else the first one for its chip. `spec` is 'ID' or 'ID@version'. */
export function pickMicroPythonFirmware(opts: { chip: string; board?: string; spec?: string }): MicroPythonFirmware {
  const all = MICROPYTHON_FIRMWARE;
  if (opts.spec) {
    const [id, version] = opts.spec.split("@");
    const hit = all.find((f) => f.id === id && (!version || f.version === version));
    if (!hit) {
      const ids = all.filter((f) => f.chip === opts.chip).map((f) => `"${f.id}@${f.version}"`);
      throw new RunnerError("micropython-unknown-firmware", `MicroPython firmware '${opts.spec}' is not one Jumper has pinned. Fix: set firmware.build.firmware to one of ${ids.join(", ") || "(none for this chip)"} or remove it to use the board's default.`);
    }
    if (hit.chip !== opts.chip) throw new RunnerError("micropython-wrong-chip", `MicroPython firmware '${opts.spec}' is built for ${hit.chip}, but the board is ${opts.chip}. Fix: remove firmware.build.firmware, or pick a build for ${opts.chip}.`);
    return hit;
  }
  const byBoard = opts.board ? all.find((f) => f.boards.includes(opts.board!)) : undefined;
  const byChip = all.find((f) => f.chip === opts.chip && f.verified) ?? all.find((f) => f.chip === opts.chip);
  const hit = byBoard ?? byChip;
  if (!hit) {
    throw new RunnerError("micropython-unsupported-chip", `MicroPython does not run on ${opts.chip} in Jumper. Why: ${opts.chip === "atmega328p" ? "MicroPython needs far more than the ATmega328P's 2 KB of RAM" : "no MicroPython build for this chip boots in Jumper's emulator yet (docs/firmware-languages.md lists why)"}. Fix: use Arduino (firmware.language "arduino"), or a Raspberry Pi Pico / XIAO RP2040 / ESP32 board for MicroPython.`);
  }
  return hit;
}

/** The firmware bytes: bundled copy, cached download, or a fresh download (sha256-checked). */
export async function microPythonFirmwareBytes(fw: MicroPythonFirmware, log: (l: string) => void = () => {}): Promise<Uint8Array> {
  const verify = (b: Uint8Array, where: string) => {
    const got = createHash("sha256").update(b).digest("hex");
    if (got !== fw.sha256) throw new RunnerError("micropython-checksum", `The MicroPython firmware ${fw.file} (${where}) has sha256 ${got.slice(0, 12)}…, not the pinned ${fw.sha256.slice(0, 12)}…. Why: the file is damaged or was replaced. Fix: delete ${where} and build again (it downloads a fresh copy).`);
    return b;
  };
  if (fw.bundled) {
    const p = join(REPO_ROOT, fw.bundled);
    if (existsSync(p)) return verify(new Uint8Array(gunzipSync(readFileSync(p))), p);
  }
  const cached = join(cacheDir(), "micropython", fw.file);
  if (existsSync(cached)) return verify(new Uint8Array(readFileSync(cached)), cached);
  const url = `https://micropython.org/resources/firmware/${fw.file}`;
  log(`downloading MicroPython ${fw.version} for ${fw.id} (${url}, first build only)…`);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new RunnerError("micropython-download", `Could not download the MicroPython firmware ${fw.file}: ${(err as Error).message}. Why: the first MicroPython build for ${fw.id} fetches the official firmware from micropython.org. Fix: check your internet connection and build again, or put the file at ${cached}.`);
  }
  if (!res.ok) throw new RunnerError("micropython-download", `Could not download ${url}: HTTP ${res.status}. Fix: build again later, or download it yourself to ${cached}.`);
  const bytes = verify(new Uint8Array(await res.arrayBuffer()), url);
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached + ".tmp", bytes);
  renameSync(cached + ".tmp", cached);
  return bytes;
}

// ------------------------------------------------------------------------------- syntax check

const require = createRequire(import.meta.url);

/** MicroPython's compiler on one file: a SyntaxError (or IndentationError) at file:line, or nothing. */
type MpyCrossFactory = (m: { arguments: string[]; inputFileContents: string; wasmBinary: Uint8Array; callback(status: number, mpy: Uint8Array | undefined, out: string[], err: string[]): void }) => unknown;
let mpyCross: { run: MpyCrossFactory; wasm: Uint8Array } | undefined;
let mpyQueue: Promise<unknown> = Promise.resolve();

/** MicroPython's compiler on one file: a SyntaxError (or IndentationError) at file:line, or nothing. */
export function checkSyntax(file: string, source: string): Promise<CompileDiagnostic | undefined> {
  // The emscripten module is created per call (it exits like a program); calls run one at a time.
  const p = mpyQueue.then(() => checkOne(file, source));
  mpyQueue = p.catch(() => undefined);
  return p;
}

async function checkOne(file: string, source: string): Promise<CompileDiagnostic | undefined> {
  // The package's compile() fetches its .wasm by path, which Node's fetch refuses; load the bytes.
  mpyCross ??= { run: require("@pybricks/mpy-cross-v6/build/mpy-cross-v6.js") as MpyCrossFactory, wasm: readFileSync(require.resolve("@pybricks/mpy-cross-v6/build/mpy-cross-v6.wasm")) };
  const { run, wasm } = mpyCross;
  const r = await new Promise<{ status: number; out: string[]; err: string[] }>((resolve) => {
    run({ arguments: [file], inputFileContents: source, wasmBinary: wasm, callback: (status, _mpy, out, err) => resolve({ status, out, err }) });
  });
  if (r.status === 0) return undefined;
  const text = [...r.err, ...r.out].join("\n");
  // Traceback (most recent call last):\n  File "main.py", line 3\nSyntaxError: invalid syntax
  const m = /File "([^"]+)", line (\d+)[^\n]*\n(?:.*\n)*?(\w*Error): ?(.*)/.exec(text);
  if (!m) return { severity: "error", file, message: text.trim() || `mpy-cross exited with ${r.status}` };
  return { severity: "error", file, line: Number(m[2]), message: `${m[3]}: ${m[4] || "invalid syntax"}`, hint: syntaxHint(m[3]!, m[4] ?? "") };
}

function syntaxHint(kind: string, msg: string): string {
  if (kind === "IndentationError" || /indent/.test(msg)) return "Python blocks are set by indentation: use 4 spaces per level, the same in every line of a block, and no tabs mixed with spaces.";
  if (/invalid syntax/.test(msg)) return "Check this line and the one above it: a missing ':' after if/for/def/while, an unclosed bracket or quote, or '=' where '==' was meant.";
  return "Fix the line shown, then build again.";
}

// ------------------------------------------------------------------------------- build

/**
 * On the RP2040 the console is USB CDC. The emulated computer opens the port about 13 ms after
 * reset; text MicroPython prints before that waits in its USB buffer until the next print, so a
 * main.py that prints once and ends would show nothing. A terminal that is already open sees the
 * text, so Jumper adds this boot.py (only when the project has none; the person's own boot.py
 * replaces it, and it is listed in the build output).
 */
export const USB_BOOT_PY = `# boot.py added by Jumper because the project has none (your own boot.py replaces it).
# The console is the USB port: give the computer 50 ms to open it before main.py runs,
# so main.py's first prints reach the Serial panel.
import time
for _ in range(50):
    time.sleep_ms(1)
`;

export interface MicroPythonBuild {
  /** Intel HEX (RP2040) or a padded ESP flash image. */
  format: "ihex" | "esp-flash";
  hex?: string;
  binary?: Uint8Array;
  firmware: MicroPythonFirmware;
  /** Files written into the device filesystem. */
  files: string[];
  fsBytesUsed: number;
  fsBytes: number;
}

/**
 * Compose MicroPython firmware + a littlefs filesystem with `files` (name → text) into the image
 * the chip's emulator loads. Throws RunnerError for environment problems; syntax errors are the
 * caller's (checkSyntax) business.
 */
export async function composeMicroPython(opts: { chip: string; board?: string; spec?: string; files: ReadonlyMap<string, string | Uint8Array>; log?: (l: string) => void }): Promise<MicroPythonBuild> {
  const fw = pickMicroPythonFirmware(opts);
  const bytes = await microPythonFirmwareBytes(fw, opts.log);
  const files = new Map<string, Uint8Array>();
  for (const [name, content] of opts.files) {
    const bad = checkLfsName(name);
    if (bad) throw new RunnerError("micropython-bad-file", `Cannot put ${bad}.`);
    files.set(name, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }
  if (fw.layout.kind === "rp2040-uf2" && !files.has("boot.py")) files.set("boot.py", new TextEncoder().encode(USB_BOOT_PY));
  const used = [...files.values()].reduce((n, b) => n + b.length, 0);
  if (fw.layout.kind === "rp2040-uf2") {
    const base = 0x1000_0000;
    const flash = uf2ToFlash(bytes, base, fw.layout.flashBytes);
    for (let i = fw.layout.fsOffset; i < fw.layout.flashBytes; i++) {
      if (flash[i] !== 0xff) throw new RunnerError("micropython-layout", `The MicroPython firmware ${fw.file} reaches into its own filesystem area (0x${(base + fw.layout.fsOffset).toString(16)}). Why: the pinned layout does not match this build. Fix: report it; this is a Jumper bug.`);
    }
    const fs = await buildLittleFs(files, { blockSize: 4096, blockCount: fw.layout.fsBytes / 4096 });
    flash.set(fs, fw.layout.fsOffset);
    return { format: "ihex", hex: flashToIntelHex(flash, base), firmware: fw, files: [...files.keys()].sort(), fsBytesUsed: used, fsBytes: fw.layout.fsBytes };
  }
  const flash = padFlash(bytes, fw.layout.flashOffset, fw.layout.flashMB);
  const vfs = espPartitions(flash).find((p) => p.label === "vfs" || (p.type === 1 && p.subtype === 0x81));
  if (!vfs) throw new RunnerError("micropython-layout", `The MicroPython firmware ${fw.file} has no 'vfs' partition in its partition table, so there is nowhere to put main.py. Fix: report it; this is a Jumper bug.`);
  const fs = await buildLittleFs(files, { blockSize: 4096, blockCount: vfs.size / 4096 });
  flash.set(fs, vfs.offset);
  return { format: "esp-flash", binary: flash, firmware: fw, files: [...files.keys()].sort(), fsBytesUsed: used, fsBytes: vfs.size };
}

// ------------------------------------------------------------------------------- runtime errors

export interface RuntimeError {
  /** firmware/<file> when the traceback names a project file. */
  file?: string;
  line?: number;
  /** "ValueError: boom" */
  message: string;
  /** The whole traceback as printed. */
  traceback: string;
}

/**
 * MicroPython tracebacks in console text, innermost frame first mapped to the project's files:
 *
 *   Traceback (most recent call last):
 *     File "main.py", line 9, in <module>
 *     File "helper.py", line 2, in f
 *   ValueError: boom
 *
 * `prefix` is prepended to file names (e.g. "firmware/"). Frames in frozen modules ("<stdin>",
 * "ssd1306.py" when not a project file) are kept but only project files get a path.
 */
export function microPythonErrors(text: string, projectFiles: ReadonlySet<string>, prefix = "firmware/"): RuntimeError[] {
  const out: RuntimeError[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("Traceback (most recent call last):")) continue;
    const frames: { file: string; line: number }[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const m = /^\s+File "([^"]+)", line (\d+)/.exec(lines[j]!);
      if (!m) break;
      frames.push({ file: m[1]!.replace(/^\/+/, ""), line: Number(m[2]) });
    }
    const msg = lines[j]?.trim();
    if (!msg) continue;
    const own = [...frames].reverse().find((f) => projectFiles.has(f.file));
    out.push({
      ...(own ? { file: prefix + own.file, line: own.line } : {}),
      message: msg,
      traceback: lines.slice(i, j + 1).join("\n"),
    });
    i = j;
  }
  return out;
}
