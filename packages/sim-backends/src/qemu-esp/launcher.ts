// Starts Espressif's QEMU (Jumper image) for one chip, connected back to a bridge port.
// Docker by default (jumper/qemu-esp image, GPL-2.0 QEMU in its own process); a native
// qemu-system-* on PATH works the same with runtime "native".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ESP_CHIPS, type EspChip } from "./chips.ts";

/** Bridge protocol 3: GPIO matrix + interrupts, LEDC, SPI, RMT, ADC, UART1/2, I2C on every chip, I2S. */
export const QEMU_ESP_IMAGE = "jumper/qemu-esp:9.2.2-20260417-jb3";

export interface QemuLaunchOptions {
  chip: EspChip;
  /** Merged 2/4/8/16 MB flash image (esptool merge-bin), e.g. <sketch>.ino.merged.bin. */
  flashImage: string;
  bridgePort: number;
  runtime?: "docker" | "native";
  image?: string;
  /** icount shift: one guest instruction = 2^shift ns of virtual time. Default 3 (125 MIPS). Xtensa needs ≥ 2. */
  icountShift?: number;
  /** Emulated Ethernet (OpenCores MAC, slirp user networking). Default true. */
  network?: boolean;
  /** Where QEMU's own stdout/stderr go (a file path). Default: discarded. */
  logFile?: string;
  extraArgs?: readonly string[];
}

export interface QemuProcess {
  child: ChildProcess;
  argv: readonly string[];
  stop(): void;
}

export function qemuArgs(o: QemuLaunchOptions, flashPathInside: string, bridgeHost: string): string[] {
  const c = ESP_CHIPS[o.chip];
  return [
    c.qemu,
    "-M", c.machine,
    "-display", "none", "-monitor", "none", "-serial", "none",
    "-snapshot",
    "-icount", `shift=${o.icountShift ?? 3},align=off,sleep=off`,
    "-rtc", "clock=vm",
    "-drive", `file=${flashPathInside},if=mtd,format=raw`,
    ...(o.network === false ? ["-nic", "none"] : ["-nic", "user,model=open_eth"]),
    "-chardev", `socket,id=jb,host=${bridgeHost},port=${o.bridgePort},nodelay=on`,
    "-global", `driver=${c.gpioType},property=bridge,value=jb`,
    "-global", `driver=${c.gpioType},property=sync,value=on`,
    ...(o.extraArgs ?? []),
  ];
}

export function launchQemu(o: QemuLaunchOptions): QemuProcess {
  const out = o.logFile ? openSync(o.logFile, "a") : "ignore";
  let argv: string[];
  let name: string | undefined;
  if ((o.runtime ?? "docker") === "docker") {
    name = `jumper-qemu-esp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    argv = [
      "docker", "run", "--rm", "--name", name,
      "--add-host=host.docker.internal:host-gateway",
      "-v", `${dirname(o.flashImage)}:/fw:ro`,
      o.image ?? QEMU_ESP_IMAGE,
      ...qemuArgs(o, `/fw/${basename(o.flashImage)}`, "host.docker.internal"),
    ];
  } else {
    argv = qemuArgs(o, o.flashImage, "127.0.0.1");
  }
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", out, out] });
  if (typeof out === "number") closeSync(out);
  child.unref();
  const stop = () => {
    if (name) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { child, argv, stop };
}

/** True when `docker` answers and the QEMU image is present. */
export function qemuImageAvailable(image = QEMU_ESP_IMAGE): boolean {
  const r = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
  return r.status === 0;
}

/**
 * Checks that the emulator can start, and says why not with the fix (Docker not running, image
 * missing, QEMU not on PATH). Returns undefined when it can.
 */
export function qemuPreflight(o: { runtime?: "docker" | "native"; image?: string; chip?: EspChip } = {}): string | undefined {
  if ((o.runtime ?? "docker") === "native") {
    const bin = ESP_CHIPS[o.chip ?? "esp32"].qemu;
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 });
    return r.status === 0 ? undefined : `${bin} is not on PATH, so the ESP32 emulator cannot start (runtime "native"). Fix: install Jumper's patched QEMU (toolchains/qemu-esp) or use runtime "docker".`;
  }
  const image = o.image ?? QEMU_ESP_IMAGE;
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15_000 });
  if (info.error || info.status !== 0) {
    return "Docker is not running, so the ESP32 emulator (QEMU in a container) cannot start. Fix: start Docker Desktop, then press Run again.";
  }
  const img = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 15_000 });
  if (img.status !== 0) {
    return `The ESP32 emulator image ${image} is not installed. Fix: run \`jumper setup esp32\` (or docker build -t ${image} toolchains/qemu-esp).`;
  }
  return undefined;
}
