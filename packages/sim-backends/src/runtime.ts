// Round 11: where Jumper's local programs run. Docker (pinned Linux images: Linux, CI, any machine
// with a working engine) or native (Jumper-managed builds under ~/.jumper: a Mac without Docker).
//
//   JUMPER_RUNTIME=auto (default)  Docker when its engine answers within a short probe, otherwise the
//                                  native install when there is one (so native is the default on a Mac
//                                  without Docker).
//   JUMPER_RUNTIME=docker|native   always that one.
//
// Older per-emulator switches (JUMPER_QEMU_ESP_RUNTIME, JUMPER_RENODE_RUNTIME) still win for their
// emulator. Node only (spawnSync).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Runtime = "docker" | "native";
export type RuntimeSetting = Runtime | "auto";

/**
 * Jumper's own folder for native toolchains and emulators (~/.jumper). Override with JUMPER_NATIVE_HOME,
 * not JUMPER_HOME: tests point JUMPER_HOME (projects registry) at a temp folder and must still find the
 * installed toolchains.
 */
export function jumperHome(): string {
  return process.env.JUMPER_NATIVE_HOME || join(homedir(), ".jumper");
}

export function runtimeSetting(): RuntimeSetting {
  const v = (process.env.JUMPER_RUNTIME ?? "auto").trim().toLowerCase();
  return v === "docker" || v === "native" ? v : "auto";
}

export interface DockerProbe {
  ok: boolean;
  /** Why Docker cannot be used, in plain words (when not ok). */
  why?: string;
  ms: number;
}

let probeCache: { at: number; probe: DockerProbe } | undefined;

/** How long the probe waits for `docker info` (JUMPER_DOCKER_PROBE_MS, default 4 s). */
export function dockerProbeMs(): number {
  const n = Number(process.env.JUMPER_DOCKER_PROBE_MS);
  return Number.isFinite(n) && n > 0 ? n : 4_000;
}

/**
 * Does the Docker engine answer? `docker info` with a short timeout, remembered for 30 s (a hung
 * Docker Desktop costs the probe once, not on every call).
 */
export function probeDocker(force = false): DockerProbe {
  if (!force && probeCache && Date.now() - probeCache.at < 30_000) return probeCache.probe;
  const t0 = Date.now();
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: dockerProbeMs() });
  const ms = Date.now() - t0;
  let probe: DockerProbe;
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") probe = { ok: false, why: "the 'docker' command is not installed", ms };
  else if (r.error) probe = { ok: false, why: `Docker did not answer within ${Math.round(dockerProbeMs() / 1000)} s (its engine is starting, stuck or out of disk space)`, ms };
  else if (r.status !== 0) probe = { ok: false, why: `Docker is not running (${(r.stderr || "docker info failed").trim().split("\n")[0]})`, ms };
  else probe = { ok: true, ms };
  probeCache = { at: Date.now(), probe };
  return probe;
}

/** Forget the cached probe (tests; after `jumper setup` started Docker). */
export function resetDockerProbe(): void {
  probeCache = undefined;
}

/**
 * Picks the runtime for one program. `override` is a per-program variable (e.g. JUMPER_RENODE_RUNTIME)
 * that wins when set; `nativeInstalled` says whether the native build is on this machine; `dockerReady`
 * (optional) says whether Docker has what it needs (the image), so an auto pick prefers a ready native
 * install over a Docker image that would first have to be built.
 */
export function pickRuntime(o: { override?: string; nativeInstalled: () => boolean; dockerReady?: () => boolean }): Runtime {
  const ov = o.override?.trim().toLowerCase();
  if (ov === "docker" || ov === "native") return ov;
  const s = runtimeSetting();
  if (s !== "auto") return s;
  if (probeDocker().ok) {
    if (!o.dockerReady || o.dockerReady() || !o.nativeInstalled()) return "docker";
    return "native";
  }
  return o.nativeInstalled() ? "native" : "docker";
}

// ---------------------------------------------------------------- native emulators

/** Espressif QEMU 9.2.2 (tag esp-develop-9.2.2-20260417) + Jumper's patches 0001-0005 (bridge v6: + I2S, Ethernet RX queueing). */
export const NATIVE_QEMU_TAG = "9.2.2-20260417-jb6";
export const RENODE_VERSION = "1.17.0";

/** ~/.jumper/emulators/qemu-esp/<tag>: `bin/qemu-system-xtensa`, `bin/qemu-system-riscv32`. */
export function nativeQemuDir(): string {
  return process.env.JUMPER_QEMU_ESP_DIR || join(jumperHome(), "emulators", "qemu-esp", NATIVE_QEMU_TAG);
}

/** The qemu-system-* to run natively: Jumper's install when present, else the name (found on PATH). */
export function nativeQemuBinary(name: string): string {
  const p = join(nativeQemuDir(), "bin", name);
  return existsSync(p) ? p : name;
}

export function nativeQemuInstalled(): boolean {
  return existsSync(join(nativeQemuDir(), "bin", "qemu-system-xtensa")) && existsSync(join(nativeQemuDir(), "bin", "qemu-system-riscv32"));
}

/** ~/.jumper/emulators/renode/1.17.0 (Renode.app on macOS, the portable folder on Linux). */
export function nativeRenodeDir(): string {
  return join(jumperHome(), "emulators", "renode", RENODE_VERSION);
}

/** Jumper's Renode executable for this OS (whether or not it is installed). */
export function jumperRenodeBinary(): string {
  return process.platform === "darwin" ? join(nativeRenodeDir(), "Renode.app", "Contents", "MacOS", "renode") : join(nativeRenodeDir(), "renode");
}

/** The Renode to run natively: JUMPER_RENODE_BIN, else Jumper's install, else `renode` on PATH. */
export function nativeRenodeBinary(): string {
  if (process.env.JUMPER_RENODE_BIN) return process.env.JUMPER_RENODE_BIN;
  const p = jumperRenodeBinary();
  return existsSync(p) ? p : "renode";
}

export function nativeRenodeInstalled(): boolean {
  return !!process.env.JUMPER_RENODE_BIN || existsSync(jumperRenodeBinary());
}
