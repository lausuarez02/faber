// Round 11: `faber setup` for native runtimes. One entry point for the CLI and the app, so both say
// the same things: what is installed, what each family needs, and progress while it installs.
import { faberHome, nativeQemuDir, nativeQemuInstalled, nativeRenodeDir, nativeRenodeInstalled, probeDocker, runtimeSetting } from "@faber/sim-backends/node";
import { RunnerError } from "../docker.ts";
import { folderBytes, installNativeCore, pruneCore, NATIVE_CORES, nativeArduinoDir, nativeCoreInstalled, SETUP_FAMILIES, type NativeFamily } from "./arduino.ts";
import { installNativeQemu, installNativeRenode } from "./emulators.ts";

/** What `faber setup <target>` installs natively. */
export const SETUP_TARGETS: Record<string, { label: string; cores: NativeFamily[]; qemu?: boolean; renode?: boolean }> = {
  avr: { ...SETUP_FAMILIES.avr!, label: SETUP_FAMILIES.avr!.label },
  rp2040: { ...SETUP_FAMILIES.rp2040! },
  esp32: { ...SETUP_FAMILIES.esp32!, qemu: true },
  stm32: { ...SETUP_FAMILIES.stm32!, renode: true },
  nrf52: { ...SETUP_FAMILIES.nrf52!, renode: true },
  renode: { label: "Renode boards (STM32 + nRF52840)", cores: ["stm32", "mbed_nano", "nrf52"], renode: true },
};
/** Aliases people type. */
const ALIASES: Record<string, string> = { arduino: "avr", uno: "avr", nano: "avr", pico: "rp2040", esp: "esp32", "esp32s3": "esp32", "esp32c3": "esp32", nrf52840: "nrf52", mbed: "nrf52", "mbed_nano": "nrf52" };

export function setupTargetOf(name: string): string | undefined {
  const n = name.toLowerCase();
  return SETUP_TARGETS[n] ? n : ALIASES[n];
}

export interface NativeComponentStatus {
  id: string;
  label: string;
  installed: boolean;
  path: string;
}

/** Every native component and whether it is on this machine. */
export function nativeStatus(): NativeComponentStatus[] {
  return [
    ...Object.values(NATIVE_CORES).map((c) => ({ id: c.family, label: `${c.label}: ${c.core}`, installed: nativeCoreInstalled(c.family), path: nativeArduinoDir() })),
    { id: "qemu-esp", label: "Espressif QEMU 9.2.2 + Faber bridge (ESP32 / S3 / C3)", installed: nativeQemuInstalled(), path: nativeQemuDir() },
    { id: "renode", label: "Renode 1.17.0 (STM32, nRF52840)", installed: nativeRenodeInstalled(), path: nativeRenodeDir() },
  ];
}

export interface SetupStep {
  what: string;
  ok: boolean;
  /** Already there (nothing downloaded). */
  skipped: boolean;
  ms: number;
  /** Size on disk after the step (the shared folder for Arduino cores). */
  bytes?: number;
  error?: string;
}

/** One line for `faber setup list` / the app: where things will run and why. */
export function runtimeSummary(): string {
  const s = runtimeSetting();
  if (s !== "auto") return `FABER_RUNTIME=${s}: every build and emulator runs ${s === "docker" ? "in Docker" : `natively (${faberHome()})`}.`;
  const d = probeDocker();
  return d.ok
    ? `FABER_RUNTIME=auto: Docker answers (${d.ms} ms), so Docker runs what it has images for; native installs are used when an image is missing.`
    : `FABER_RUNTIME=auto: ${d.why}, so Faber uses its native installs in ${faberHome()}.`;
}

/**
 * Installs `target` ("all", a family such as esp32, or renode) natively with progress lines. Each
 * step reports its time and size; a failed step does not stop the others (the error says why / fix),
 * and the call throws at the end when any step failed.
 */
export async function setupNative(target: string, log: (l: string) => void = () => {}): Promise<SetupStep[]> {
  const t = target === "all" ? undefined : setupTargetOf(target);
  if (target !== "all" && !t) {
    throw new RunnerError("unknown-target", `faber setup: no board family called '${target}'. Why: native setup knows ${Object.keys(SETUP_TARGETS).join(", ")} (and all). Fix: faber setup list.`);
  }
  const targets = t ? [SETUP_TARGETS[t]!] : Object.values(SETUP_TARGETS);
  const cores = [...new Set(targets.flatMap((x) => x.cores))];
  const steps: SetupStep[] = [];
  const step = async (what: string, already: boolean, fn: () => Promise<unknown>, sizeOf?: () => Promise<number>) => {
    const t0 = Date.now();
    log(`${what}: ${already ? "already installed" : "installing…"}`);
    try {
      if (!already) await fn();
      const bytes = sizeOf ? await sizeOf() : undefined;
      const s: SetupStep = { what, ok: true, skipped: already, ms: Date.now() - t0, ...(bytes !== undefined ? { bytes } : {}) };
      steps.push(s);
      if (!already) log(`${what}: ready in ${(s.ms / 1000).toFixed(0)} s${bytes ? ` (${(bytes / 1e9).toFixed(2)} GB on disk)` : ""}`);
    } catch (err) {
      steps.push({ what, ok: false, skipped: false, ms: Date.now() - t0, error: (err as Error).message });
      log(`${what}: FAILED. ${(err as Error).message}`);
    }
  };
  for (const c of cores) {
    if (nativeCoreInstalled(c)) pruneCore(c);
    await step(`${NATIVE_CORES[c].core} (${NATIVE_CORES[c].label})`, nativeCoreInstalled(c), () => installNativeCore(c, log), () => folderBytes(nativeArduinoDir()));
  }
  if (targets.some((x) => x.qemu)) await step("Espressif QEMU + Faber bridge (built here)", nativeQemuInstalled(), () => installNativeQemu(log), () => folderBytes(nativeQemuDir()));
  if (targets.some((x) => x.renode)) await step("Renode 1.17.0", nativeRenodeInstalled(), () => installNativeRenode(log), () => folderBytes(nativeRenodeDir()));
  const failed = steps.filter((s) => !s.ok);
  if (failed.length) {
    throw new RunnerError("setup-failed", `${failed.length} of ${steps.length} setup steps failed: ${failed.map((f) => `${f.what}: ${f.error}`).join(" / ")}`);
  }
  return steps;
}
