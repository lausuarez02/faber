// A littlefs (v2) filesystem image built in process, for MicroPython's flash filesystem.
//
// The filesystem code is littlefs itself (BSD-3-Clause) compiled to WebAssembly by the `littlefs`
// npm package (wokwi/littlefs-wasm, ISC). Nothing is reimplemented: the image is exactly what
// littlefs writes, so MicroPython mounts it like one it formatted itself.
//
// Limits of that build (stated, not hidden): it exports format / mount / write_file only, so files
// live at the root of the filesystem (no folders), and every file is written whole.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export class LittleFsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LittleFsGeometry {
  /** Erase block size in bytes (4096 on every MicroPython port Jumper runs). */
  blockSize: number;
  /** Number of blocks in the filesystem partition. */
  blockCount: number;
}

interface LfsModule {
  HEAPU8: Uint8Array;
  addFunction(fn: (...a: number[]) => number | void, sig: string): number;
  _new_lfs(): number;
  _new_lfs_config(read: number, prog: number, erase: number, sync: number, blockCount: number, blockSize: number): number;
  _lfs_format(lfs: number, cfg: number): number;
  _lfs_mount(lfs: number, cfg: number): number;
  _lfs_unmount(lfs: number): number;
  cwrap(name: string, ret: null, args: string[]): (...a: unknown[]) => void;
  _free(p: number): void;
}

const require = createRequire(import.meta.url);
let modulePromise: Promise<LfsModule> | undefined;

function lfsModule(): Promise<LfsModule> {
  // One instance per process; the image buffer is swapped per call (calls are serialised below).
  // The package is built for the web (it fetches its .wasm); hand it the bytes instead.
  modulePromise ??= (require("littlefs") as (o?: object) => Promise<LfsModule>)({ wasmBinary: readFileSync(require.resolve("littlefs/dist/littlefs.wasm")) });
  return modulePromise;
}

let current: Uint8Array | undefined;
let geometry: LittleFsGeometry | undefined;
let callbacks: { read: number; prog: number; erase: number; sync: number } | undefined;
let queue: Promise<unknown> = Promise.resolve();
let writeFile: ((...a: unknown[]) => void) | undefined;

/** A valid littlefs file name at the root: no folders, no control characters, at most 255 bytes. */
export function checkLfsName(name: string): string | undefined {
  if (name.includes("/")) return `'${name}' is inside a folder. Why: Jumper writes MicroPython files at the root of the device filesystem (folders are not supported yet). Fix: put the module next to main.py and import it by name`;
  if (!name || /[\x00-\x1f]/.test(name)) return `'${name}' is not a valid file name`;
  if (new TextEncoder().encode(name).length > 255) return `'${name}' is longer than 255 bytes`;
  return undefined;
}

/**
 * Format a littlefs image of `blockSize * blockCount` bytes and write `files` (name → bytes) at
 * its root. Unused blocks stay erased (0xFF), as on a freshly erased flash.
 */
export function buildLittleFs(files: ReadonlyMap<string, Uint8Array>, geo: LittleFsGeometry): Promise<Uint8Array> {
  const run = queue.then(() => build(files, geo));
  queue = run.catch(() => undefined);
  return run;
}

async function build(files: ReadonlyMap<string, Uint8Array>, geo: LittleFsGeometry): Promise<Uint8Array> {
  for (const name of files.keys()) {
    const bad = checkLfsName(name);
    if (bad) throw new LittleFsError("bad-file-name", `Cannot put ${bad}.`);
  }
  for (const [name, data] of files) {
    if (data.length > 4 << 20) throw new LittleFsError("file-too-large", `'${name}' is ${Math.round(data.length / 1024)} KB. Why: files are written through a 5 MB buffer. Fix: keep each file under 4 MB.`);
  }
  const total = [...files.values()].reduce((n, f) => n + Math.ceil((f.length + 64) / geo.blockSize) * geo.blockSize, 0);
  if (total > (geo.blockCount - 4) * geo.blockSize) {
    throw new LittleFsError("fs-full", `The MicroPython files need about ${Math.round(total / 1024)} KB, more than the ${Math.round(((geo.blockCount - 4) * geo.blockSize) / 1024)} KB filesystem on this board. Fix: remove large files from firmware/, or pick a board with more flash.`);
  }
  const m = await lfsModule();
  const image = new Uint8Array(geo.blockSize * geo.blockCount).fill(0xff);
  current = image;
  geometry = geo;
  callbacks ??= {
    read: m.addFunction((_cfg, block, off, buffer, size) => {
      const start = block! * geometry!.blockSize + off!;
      m.HEAPU8.set(current!.subarray(start, start + size!), buffer!);
      return 0;
    }, "iiiiii"),
    prog: m.addFunction((_cfg, block, off, buffer, size) => {
      const start = block! * geometry!.blockSize + off!;
      current!.set(m.HEAPU8.subarray(buffer!, buffer! + size!), start);
      return 0;
    }, "iiiiii"),
    erase: m.addFunction((_cfg, block) => {
      const start = block! * geometry!.blockSize;
      current!.fill(0xff, start, start + geometry!.blockSize);
      return 0;
    }, "iii"),
    sync: m.addFunction(() => 0, "ii"),
  };
  const cfg = m._new_lfs_config(callbacks.read, callbacks.prog, callbacks.erase, callbacks.sync, geo.blockCount, geo.blockSize);
  const lfs = m._new_lfs();
  try {
    if (m._lfs_format(lfs, cfg) !== 0) throw new LittleFsError("fs-format", "littlefs could not format the filesystem image");
    if (m._lfs_mount(lfs, cfg) !== 0) throw new LittleFsError("fs-mount", "littlefs could not mount the image it just formatted");
    // The package exports no malloc: names and contents go through emscripten's stack (5 MB),
    // which ccall's "array" arguments use.
    writeFile ??= m.cwrap("lfs_write_file", null, ["number", "array", "array", "number"]);
    for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      writeFile(lfs, new TextEncoder().encode(name + "\0"), data.length ? data : new Uint8Array(1), data.length);
    }
    m._lfs_unmount(lfs);
  } finally {
    m._free(lfs);
    m._free(cfg);
    current = undefined;
  }
  return image;
}
