// firmware.language "micropython": check every .py with mpy-cross, then flash the pinned MicroPython
// firmware plus a littlefs image with the files (micropython.ts). In process: no Docker.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { BuildRequest, BuildResult } from "../build.ts";
import type { CompileDiagnostic } from "../diagnostics.ts";
import { RunnerError } from "../docker.ts";
import { checkSyntax, composeMicroPython, USB_MAIN_FILE } from "./micropython.ts";

/** Files that go onto the device: .py modules plus small data files next to them. */
const DEVICE_FILE = /\.(py|json|txt|csv|bin|pbm|raw)$/;

export async function buildMicroPython(req: BuildRequest, t0: number): Promise<BuildResult> {
  const log = req.log ?? (() => {});
  if (!req.chip) throw new RunnerError("micropython-no-chip", "Build failed: MicroPython needs to know the board's chip. Fix: set firmware.board to a board part (e.g. a Raspberry Pi Pico).");
  if (!existsSync(req.sketchDir)) throw new RunnerError("no-sketch", `Build failed: the folder ${req.sketchDir} does not exist. Fix: write the program first, e.g. write_file("firmware/main.py", "...").`);
  const prefix = req.displayPrefix ?? "";
  const files = new Map<string, Uint8Array>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const name of readdirSync(req.sketchDir).sort()) {
    const abs = join(req.sketchDir, name);
    if (statSync(abs).isDirectory()) {
      if (name === "build" || name.startsWith(".")) continue;
      const nested = readdirSync(abs).filter((f) => DEVICE_FILE.test(f));
      if (nested.length) diagnostics.push({ severity: "warning", file: prefix + relative(req.sketchDir, abs), message: `folder ${name}/ is not copied to the device (${nested.length} file${nested.length === 1 ? "" : "s"})`, hint: "Jumper writes MicroPython files at the root of the device filesystem; folders are not supported yet. Move the modules next to main.py and import them by name." });
      continue;
    }
    if (!DEVICE_FILE.test(name)) continue;
    files.set(name, new Uint8Array(readFileSync(abs)));
  }
  const main = req.main ?? "main.py";
  if (!files.has(main)) {
    throw new RunnerError("no-main", `Build failed: ${prefix}${main} does not exist (found: ${[...files.keys()].join(", ") || "no .py files"}). Fix: write it first, e.g. write_file("firmware/main.py", "from machine import Pin\\n...").`);
  }
  // MicroPython runs boot.py then main.py. A main file with another name is copied as main.py.
  if (main !== "main.py") {
    files.set("main.py", files.get(main)!);
    files.delete(main);
  }
  for (const [name, bytes] of files) {
    if (!name.endsWith(".py")) continue;
    const display = prefix + (name === "main.py" && main !== "main.py" ? main : name);
    const d = await checkSyntax(name, new TextDecoder().decode(bytes));
    if (d) diagnostics.push({ ...d, file: display });
  }
  const h = createHash("sha256");
  h.update(`micropython\nchip=${req.chip}\nboard=${req.board ?? ""}\nfw=${req.micropythonFirmware ?? ""}\n`);
  for (const [n, b] of files) h.update(n).update("\0").update(b).update("\0");
  const hash = h.digest("hex").slice(0, 24);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const base = { cached: false, hash, diagnostics, errors, warnings: diagnostics.length - errors, libraries: [], language: "micropython" as const };
  if (errors) return { ...base, ok: false, durationMs: Date.now() - t0, logTail: diagnostics.map((d) => `${d.file}:${d.line ?? "?"}: ${d.message}`).join("\n") };
  const out = await composeMicroPython({ chip: req.chip, ...(req.board ? { board: req.board } : {}), ...(req.micropythonFirmware ? { spec: req.micropythonFirmware } : {}), files, log });
  return {
    ...base,
    ok: true,
    format: out.format,
    ...(out.hex !== undefined ? { hex: out.hex } : {}),
    ...(out.binary ? { binary: out.binary } : {}),
    durationMs: Date.now() - t0,
    summary: `MicroPython ${out.firmware.version} (${out.firmware.id}) + ${files.size} file${files.size === 1 ? "" : "s"} (${out.fsBytesUsed} B of a ${Math.round(out.fsBytes / 1024)} KB littlefs)${out.files.includes(USB_MAIN_FILE) ? `; main.py runs through Jumper's USB launcher (waits 40 ms for the computer to open the port)` : ""}`,
    logTail: `MicroPython ${out.firmware.version} ${out.firmware.id} + littlefs with ${out.files.join(", ")}`,
  };
}
