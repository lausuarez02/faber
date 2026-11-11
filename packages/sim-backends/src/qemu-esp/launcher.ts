// Starts Espressif's QEMU (Jumper image) for one chip, connected back to a bridge port.
// Docker by default (jumper/qemu-esp image, GPL-2.0 QEMU in its own process); a native
// qemu-system-* on PATH works the same with runtime "native".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ESP_CHIPS, type EspChip } from "./chips.ts";

/**
 * Bridge protocol 5: GPIO + matrix + interrupts, UART0-2, I2C on every chip (two buses on the ESP32),
 * LEDC, SPI, RMT, ADC (round 10 esp-periph) and pad pull-ups / pull-downs answered in lockstep
 * (round 10 esp-app). Override with JUMPER_QEMU_ESP_IMAGE.
 */
export const QEMU_ESP_IMAGE = "jumper/qemu-esp:9.2.2-20260417-jb5";

/** Docker labels every emulator container carries, so a later Jumper process can reap leftovers. */
export const EMULATOR_LABEL = "jumper.emulator";
export const OWNER_LABEL = "jumper.owner-pid";

export interface QemuLaunchOptions {
  chip: EspChip;
  /** Merged 2/4/8/16 MB flash image (esptool merge-bin), e.g. <sketch>.ino.merged.bin. */
  flashImage: string;
  bridgePort: number;
  runtime?: "docker" | "native";
  image?: string;
  /** icount shift: one guest instruction = 2^shift ns of virtual time. Default 3 (125 MIPS). Xtensa needs ≥ 2. */
  icountShift?: number;
  /**
   * The emulated network card (OpenCores Ethernet, "open_eth"):
   *   true (default): QEMU's own user networking (NAT, no Jumper policy);
   *   { framePort }: plugged into Jumper's device network (DeviceNetHost.framePort), where the
   *     sandbox DNS, mocks, secrets, faults and the Wi-Fi shim's access point live;
   *   false: no card.
   */
  network?: boolean | QemuNetwork;
  /** Where QEMU's own stdout/stderr go (a file path). Default: discarded. */
  logFile?: string;
  extraArgs?: readonly string[];
  /** Extra Docker labels (key → value). jumper.emulator=1 and jumper.owner-pid=<pid> are always set. */
  labels?: Record<string, string>;
}

export interface QemuNetwork {
  /** Port of the device network's frame server on this machine. */
  framePort: number;
  /** MAC of the card (QEMU's eFuse has none); give each board on one network its own. */
  mac?: string;
}

/** A stable, locally administered MAC for board number `n` on a sandbox network. */
export function boardMac(n: number): string {
  return `02:4a:4d:00:${((n >> 8) & 0xff).toString(16).padStart(2, "0")}:${(n & 0xff).toString(16).padStart(2, "0")}`;
}

function netArgs(net: QemuLaunchOptions["network"], host: string): string[] {
  if (net === false) return ["-nic", "none"];
  if (net === undefined || net === true) return ["-nic", "user,model=open_eth"];
  return [
    "-netdev", `stream,id=jn,server=off,addr.type=inet,addr.host=${host},addr.port=${net.framePort}`,
    "-net", `nic,netdev=jn,model=open_eth${net.mac ? `,macaddr=${net.mac}` : ""}`,
  ];
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
    ...netArgs(o.network, bridgeHost),
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
      "--label", `${EMULATOR_LABEL}=1`, "--label", `${OWNER_LABEL}=${process.pid}`, "--label", "jumper.backend=qemu-esp",
      ...Object.entries(o.labels ?? {}).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
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
