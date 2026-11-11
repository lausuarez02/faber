// The local runner's second job (decision 0006): own the emulator processes of process backends
// (Espressif QEMU for the ESP32 family, Renode for Cortex-M boards). It checks Docker and the
// image before a start and says why and how to fix it, builds a missing image with progress, reaps
// containers a crashed Jumper left behind (by label), and disposes every emulator it started.
// Ports are never fixed: every bridge listens on a free port the OS picks (never 7780).
import { spawn } from "node:child_process";
import { QEMU_ESP_IMAGE, RENODE_IMAGE, EMULATOR_LABEL, OWNER_LABEL, qemuPreflight, qemuRuntime, renodeRuntime, renodeUnavailable } from "@jumper/sim-backends/node";
import type { McuBackend } from "@jumper/sim-core";
import { QEMU_ESP_DOCKERFILE_DIR, REPO_ROOT } from "./config.ts";
import { join } from "node:path";
import { exec, RunnerError } from "./docker.ts";

export type ProcessBackendId = "qemu-esp" | "renode";

export interface EmulatorInfo {
  backend: ProcessBackendId;
  image: string;
  /** "Espressif QEMU 9.2.2 + Jumper bridge" */
  name: string;
  /** How a person gets the image when Jumper cannot build it itself. */
  setup: string;
  /** Jumper can build it from the repo (toolchains/…) in about this long. */
  buildDir?: string;
  buildMinutes?: number;
}

export const EMULATORS: Record<ProcessBackendId, EmulatorInfo> = {
  "qemu-esp": { backend: "qemu-esp", image: QEMU_ESP_IMAGE, name: "Espressif QEMU 9.2.2 with the Jumper bridge", setup: "pnpm jumper setup esp32", buildDir: QEMU_ESP_DOCKERFILE_DIR, buildMinutes: 2 },
  renode: { backend: "renode", image: RENODE_IMAGE, name: "Renode 1.17.0", setup: "pnpm jumper setup renode", buildDir: join(REPO_ROOT, "toolchains/renode"), buildMinutes: 2 },
};

export function emulatorOf(backend: string | undefined): EmulatorInfo | undefined {
  return backend === "qemu-esp" || backend === "renode" ? EMULATORS[backend] : undefined;
}

export interface EmulatorCheck {
  ok: boolean;
  code?: "docker-missing" | "docker-not-running" | "image-missing";
  /** What failed, why, and the fix, in one message. */
  message?: string;
  image: string;
  dockerMs?: number;
}

/** Docker present and running, and the emulator's image on this machine. ~50 to 300 ms. */
export async function checkEmulator(backend: ProcessBackendId, board = "this board"): Promise<EmulatorCheck> {
  const info = EMULATORS[backend];
  const t0 = Date.now();
  if (backend === "qemu-esp" && qemuRuntime() === "native") {
    // JUMPER_QEMU_ESP_RUNTIME=native: Jumper's patched QEMU built on this machine, no Docker involved.
    const why = qemuPreflight({ runtime: "native" }) ?? qemuPreflight({ runtime: "native", chip: "esp32c3" });
    return why ? { ok: false, code: "image-missing", image: "native qemu", message: `Can't run ${board}: ${why}` } : { ok: true, image: "native qemu", dockerMs: Date.now() - t0 };
  }
  if (backend === "renode" && renodeRuntime() === "native") {
    // JUMPER_RENODE_RUNTIME=native: a Renode 1.17 on this machine, no Docker involved.
    const why = renodeUnavailable();
    return why ? { ok: false, code: "image-missing", image: "native renode", message: `Can't run ${board}: ${why}` } : { ok: true, image: "native renode", dockerMs: Date.now() - t0 };
  }
  let r;
  try {
    r = await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
  } catch {
    return { ok: false, code: "docker-missing", image: info.image, message: `Can't run ${board}: the 'docker' command was not found. Why: ${board} runs in ${info.name}, a local emulator Jumper starts on your computer (natively, or in Docker), and neither is ready. Fix: run \`${info.setup}\` to install it natively (no Docker needed), or install Docker Desktop (https://www.docker.com/products/docker-desktop/) and start it, then press Run again.` };
  }
  if (r.code !== 0) {
    return { ok: false, code: "docker-not-running", image: info.image, message: `Can't run ${board}: Docker is not running${r.stderr.includes("[jumper] killed after") ? " (it did not answer within 15 s)" : ""}. Why: ${board} runs in ${info.name}, a local emulator Jumper starts on your computer (natively, or in Docker), and neither is ready. Fix: run \`${info.setup}\` to install it natively (no Docker needed), or start Docker Desktop (macOS: open -a Docker) and wait until it says running, then press Run again.` };
  }
  const dockerMs = Date.now() - t0;
  const img = await exec("docker", ["image", "inspect", "--format", "{{.Id}}", info.image], { timeoutMs: 15_000 });
  if (img.code !== 0) {
    return {
      ok: false,
      code: "image-missing",
      image: info.image,
      dockerMs,
      message: `Can't run ${board} yet: the emulator image ${info.image} is not on this computer. Fix: ${info.buildDir ? `press Run again and Jumper builds it (about ${info.buildMinutes} minutes, once), or run \`${info.setup}\`` : `run \`${info.setup}\``}.`,
    };
  }
  return { ok: true, image: info.image, dockerMs };
}

let building: Promise<void> | undefined;

/** Builds the QEMU image from toolchains/qemu-esp when it is missing (once, ~1 to 2 minutes). */
export async function ensureEmulatorImage(backend: ProcessBackendId, log: (line: string) => void = () => {}): Promise<void> {
  const info = EMULATORS[backend];
  const check = await checkEmulator(backend);
  if (check.ok) return;
  if (check.code !== "image-missing" || !info.buildDir) throw new RunnerError(check.code ?? "emulator", check.message ?? `Emulator ${info.image} is not available.`);
  building ??= (async () => {
    log(`building the emulator image ${info.image} from ${info.buildDir} (once, about ${info.buildMinutes} minutes)…`);
    const r = await exec("docker", ["build", "-t", info.image, info.buildDir!], { timeoutMs: 30 * 60_000 });
    if (r.code !== 0) {
      throw new RunnerError("image-build-failed", `Could not build the emulator image ${info.image}: ${(r.stderr || r.stdout).trim().split("\n").slice(-4).join(" | ")}. Fix: check your network connection (${backend === "qemu-esp" ? "it clones Espressif's QEMU from GitHub" : "it downloads Renode 1.17.0 from GitHub"}) and free disk space, then run \`${info.setup}\`.`);
    }
    log(`built ${info.image}`);
  })().finally(() => {
    building = undefined;
  });
  return building;
}

function alive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes emulator containers whose Jumper process is gone (label jumper.owner-pid). Containers of
 * running Jumper processes (another `jumper serve`, a test run) are left alone. Returns how many.
 */
export async function reapEmulators(): Promise<number> {
  let r;
  try {
    r = await exec("docker", ["ps", "-a", "--filter", `label=${EMULATOR_LABEL}=1`, "--format", `{{.ID}} {{.Label "${OWNER_LABEL}"}}`], { timeoutMs: 15_000 });
  } catch {
    return 0;
  }
  if (r.code !== 0) return 0;
  const dead = r.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[0] && !alive(Number(f[1])))
    .map((f) => f[0]!);
  if (dead.length) await exec("docker", ["rm", "-f", ...dead], { timeoutMs: 30_000 });
  return dead.length;
}

/** Every process backend this Jumper process started, so they all stop with it. */
const live = new Set<McuBackend>();
let hooked = false;

export function trackEmulator(backend: McuBackend): void {
  live.add(backend);
  if (hooked) return;
  hooked = true;
  const stopAll = () => {
    for (const b of live) {
      try {
        b.dispose?.();
      } catch {
        // best effort on the way out
      }
    }
    live.clear();
  };
  // jumper serve / the MCP server exit through process.exit on SIGINT / SIGTERM, which fires this.
  // A hard kill leaves the containers: reapEmulators() removes them on the next start.
  process.once("exit", stopAll);
}

export function untrackEmulator(backend: McuBackend): void {
  live.delete(backend);
}

export function runningEmulators(): number {
  return live.size;
}

/** Labels for this Jumper process's emulator containers. */
export function emulatorLabels(extra: Record<string, string> = {}): Record<string, string> {
  return { "jumper.session": String(process.pid), ...extra };
}

/** Fire-and-forget `docker rm -f` of one container (used when a backend's own stop failed). */
export function killContainer(name: string): void {
  spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).unref();
}
