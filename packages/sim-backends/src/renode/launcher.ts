// Starts one Renode process (Docker image jumper/renode by default) for one board with one ELF.
// Renode runs a generated start script: compile the Jumper bridge (C#, MIT), create the machine,
// load the board's platform plus the per-run additions (I2C targets, SPI target), load the ELF, and
// dial back to Jumper's bridge port. Everything after that goes over the bridge socket.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EMULATOR_LABEL, OWNER_LABEL } from "../qemu-esp/launcher.ts";
import { jumperRenodeBinary, nativeRenodeBinary, nativeRenodeInstalled, pickRuntime, probeDocker } from "../runtime.ts";

const exec = promisify(execFile);

/** Keep in sync with toolchains/renode/Dockerfile. */
export const RENODE_IMAGE = "jumper/renode:1.17.0-r1";
/** This folder's platforms/ (board .repl files, Python and C# models, the bridge). */
export const PLATFORMS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "platforms");

export interface RenodeLaunch {
  /** Host folder mounted read-only at /jumper/run (start.resc, the ELF, extra.repl). */
  runDir: string;
  image?: string;
  runtime?: "docker" | "native";
  /** Renode's own log goes here (a file path). Default: discarded. */
  logFile?: string;
  /** Extra Docker labels; jumper.emulator=1 and jumper.owner-pid=<pid> are always set (the runner's reaper). */
  labels?: Record<string, string>;
}

export interface RenodeProcess {
  child: ChildProcess;
  name?: string;
  argv: readonly string[];
  stop(): void;
}

export function launchRenode(o: RenodeLaunch): RenodeProcess {
  const out = o.logFile ? openSync(o.logFile, "a") : "ignore";
  let argv: string[];
  let name: string | undefined;
  if ((o.runtime ?? renodeRuntime()) === "docker") {
    name = `jumper-renode-${process.pid}-${randomBytes(3).toString("hex")}`;
    argv = [
      "docker", "run", "--rm", "-i", "--name", name, "--label", "jumper.renode=1",
      "--label", `${EMULATOR_LABEL}=1`, "--label", `${OWNER_LABEL}=${process.pid}`, "--label", "jumper.backend=renode",
      ...Object.entries(o.labels ?? {}).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      "--add-host=host.docker.internal:host-gateway",
      "-v", `${PLATFORMS_DIR}:/jumper/platforms:ro`,
      "-v", `${o.runDir}:/jumper/run:ro`,
      o.image ?? RENODE_IMAGE,
      "--disable-gui", "--console", "--plain", "/jumper/run/start.resc",
    ];
  } else {
    argv = [renodeBinary(), "--disable-gui", "--console", "--plain", `${o.runDir}/start.resc`];
  }
  // stdin stays open (never written): Renode's console exits on EOF, and it ends with this process.
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", out, out] });
  if (typeof out === "number") closeSync(out);
  child.unref();
  const stop = () => {
    if (name) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { child, name, argv, stop };
}

/**
 * Docker or a native Renode 1.17 on this machine (round 11: ~/.jumper/emulators/renode/1.17.0, installed
 * by `jumper setup renode`; or JUMPER_RENODE_BIN; or \`renode\` on PATH). JUMPER_RENODE_RUNTIME=docker|native
 * forces one; otherwise JUMPER_RUNTIME (auto: Docker when it answers and has the image, else native when
 * installed). Native starts faster; the macOS build is not notarised.
 */
export function renodeRuntime(): "docker" | "native" {
  return pickRuntime({
    override: process.env.JUMPER_RENODE_RUNTIME,
    nativeInstalled: nativeRenodeInstalled,
    dockerReady: () => spawnSync("docker", ["image", "inspect", RENODE_IMAGE], { stdio: "ignore", timeout: 10_000 }).status === 0,
  });
}

export function renodeBinary(): string {
  return nativeRenodeBinary();
}

/** Remove Renode containers a crashed Jumper process left behind. */
export async function reapRenodeContainers(): Promise<number> {
  const { stdout } = await exec("docker", ["ps", "-aq", "--filter", "label=jumper.renode=1"]);
  const ids = stdout.split("\n").filter(Boolean);
  if (ids.length) await exec("docker", ["rm", "-f", ...ids]);
  return ids.length;
}

/** Why the Renode backend cannot start here, with the fix, or undefined when Docker and the image are ready. */
export function renodeUnavailable(image = RENODE_IMAGE, runtime = renodeRuntime()): string | undefined {
  if (runtime === "native") {
    const bin = renodeBinary();
    const absent = bin === "renode" ? (spawnSync("renode", ["--version"], { stdio: "ignore", timeout: 30_000 }).error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" : !existsSync(bin);
    if (absent) {
      return `Renode is not installed natively (no ${bin})${probeDocker().ok ? "" : `, and Docker cannot run it instead: ${probeDocker().why}`}. Fix: run \`jumper setup renode\` (downloads Renode 1.17.0, about 75 MB, checksum-checked), then run again.`;
    }
    const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
    if (v.error || v.status !== 0) {
      return `Renode did not run as '${bin}' (${v.error?.message ?? (v.stderr || "").trim()}). Why: ${bin === "renode" ? "Jumper's Renode is not installed and none is on PATH" : "the install is damaged or macOS blocked it"}. Fix: run \`jumper setup renode\` (installs Renode 1.17.0 in ${jumperRenodeBinary().split("/Renode.app")[0]}), or set JUMPER_RENODE_BIN to Renode 1.17's executable.`;
    }
    return undefined;
  }
  const info = probeDocker();
  if (!info.ok) {
    return nativeRenodeInstalled()
      ? `This board runs in Renode, the runtime is forced to Docker, and ${info.why}. Fix: unset JUMPER_RUNTIME / JUMPER_RENODE_RUNTIME (Jumper's native Renode is installed), or start Docker Desktop, then run again.`
      : `This board runs in Renode, and neither runtime is ready: ${info.why}, and Renode is not installed natively. Fix: run \`jumper setup renode\` (native Renode 1.17.0, no Docker needed), or start Docker Desktop (restart it if it hangs; free disk space if it is full), then run again.`;
  }
  const img = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 15_000 });
  if (img.status !== 0) {
    return `The Renode emulator image ${image} is not on this machine (or Docker cannot read it). Fix: build it once from the Jumper repo with \`docker build -t ${image} toolchains/renode\` (about 1 minute, 650 MB), then run again.`;
  }
  return undefined;
}

/** True when Docker answers and the Renode image is present (tests skip otherwise). */
export function renodeAvailable(image = RENODE_IMAGE): boolean {
  return renodeUnavailable(image) === undefined;
}
