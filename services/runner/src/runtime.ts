// Round 11: which runtime builds a sketch. FABER_RUNTIME=auto (default): Docker when its engine
// answers a short probe and has (or can build) the board's image; Faber's native toolchain when
// Docker is not usable, or when it is but the image is missing and the native toolchain is ready.
import { spawnSync } from "node:child_process";
import { probeDocker, runtimeSetting, type Runtime } from "@faber/sim-backends/node";
import { exec, RunnerError } from "./docker.ts";
import { imageFor } from "./config.ts";
import { nativeArduinoDir, nativeCoreInstalled, nativeFamilyOf, NATIVE_CORES, SETUP_FAMILIES } from "./native/arduino.ts";

export function setupNameFor(fqbn: string): string {
  const f = nativeFamilyOf(fqbn);
  return (f && Object.entries(SETUP_FAMILIES).find(([, s]) => s.cores.includes(f))?.[0]) || "list";
}

async function imagePresent(image: string): Promise<boolean> {
  try {
    return (await exec("docker", ["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 10_000 })).code === 0;
  } catch {
    return false;
  }
}

/**
 * The runtime that builds `fqbn`. Throws a RunnerError with what / why / fix when neither is usable
 * (Docker down and the native toolchain not installed), or when the forced one is not.
 */
export async function arduinoRuntimeFor(fqbn: string): Promise<Runtime> {
  const setting = runtimeSetting();
  const family = nativeFamilyOf(fqbn);
  const native = !!family && nativeCoreInstalled(family);
  const setup = setupNameFor(fqbn);
  if (setting === "docker") return "docker";
  if (setting === "native") {
    if (native) return "native";
    throw new RunnerError(
      "native-missing",
      `Build failed: FABER_RUNTIME is native, and Faber's native toolchain for ${family ? NATIVE_CORES[family].label : fqbn} is not installed (${nativeArduinoDir()}). Fix: run \`faber setup ${setup}\` (${family ? NATIVE_CORES[family].size : "see faber setup list"}), then build again.`,
    );
  }
  const probe = probeDocker();
  if (probe.ok) {
    if (native && !(await imagePresent(imageFor(fqbn)))) return "native";
    return "docker";
  }
  if (native) return "native";
  throw new RunnerError(
    probe.why?.includes("not installed") ? "docker-missing" : "no-build-runtime",
    `Build failed: nothing on this computer can compile for ${fqbn}. Why: ${probe.why}, and Faber's native toolchain for ${family ? NATIVE_CORES[family].label : "this board"} is not installed. Fix: run \`faber setup ${setup}\` (installs it natively, no Docker needed${family ? `; ${NATIVE_CORES[family].size}` : ""}), or start Docker Desktop, then build again.`,
  );
}

/**
 * Sync check for tests and status lines: can this machine build `fqbn` right now without building a
 * Docker image first? Docker with the image present, or the native toolchain installed.
 */
export function canBuildArduino(fqbn: string): { ok: boolean; runtime?: Runtime; why?: string } {
  const setting = runtimeSetting();
  const family = nativeFamilyOf(fqbn);
  const native = !!family && nativeCoreInstalled(family);
  if (setting !== "docker" && native && (setting === "native" || !probeDocker().ok)) return { ok: true, runtime: "native" };
  if (setting !== "native" && probeDocker().ok) {
    if (spawnSync("docker", ["image", "inspect", imageFor(fqbn)], { stdio: "ignore", timeout: 10_000 }).status === 0) return { ok: true, runtime: "docker" };
    if (native) return { ok: true, runtime: "native" };
    return { ok: false, why: `the Docker image ${imageFor(fqbn)} is not built and the native toolchain is not installed (Fix: faber setup ${setupNameFor(fqbn)})` };
  }
  return { ok: false, why: `${probeDocker().why ?? "Docker is forced off"} and the native toolchain for ${fqbn} is not installed (Fix: faber setup ${setupNameFor(fqbn)})` };
}
