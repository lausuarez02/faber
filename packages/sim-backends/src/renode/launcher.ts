// Starts one Renode process (Docker image jumper/renode by default) for one board with one ELF.
// Renode runs a generated start script: compile the Jumper bridge (C#, MIT), create the machine,
// load the board's platform plus the per-run additions (I2C targets, SPI target), load the ELF, and
// dial back to Jumper's bridge port. Everything after that goes over the bridge socket.
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  if ((o.runtime ?? "docker") === "docker") {
    name = `jumper-renode-${process.pid}-${randomBytes(3).toString("hex")}`;
    argv = [
      "docker", "run", "--rm", "-i", "--name", name, "--label", "jumper.renode=1",
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
    if (name) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { child, name, argv, stop };
}

/**
 * Docker (default) or a native Renode 1.17 on this machine (JUMPER_RENODE_RUNTIME=native; the binary
 * from JUMPER_RENODE_BIN or `renode` on PATH). Native starts faster; the macOS build is not notarised.
 */
export function renodeRuntime(): "docker" | "native" {
  return process.env.JUMPER_RENODE_RUNTIME === "native" ? "native" : "docker";
}

export function renodeBinary(): string {
  return process.env.JUMPER_RENODE_BIN || "renode";
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
    const v = spawnSync(renodeBinary(), ["--version"], { encoding: "utf8", timeout: 30_000 });
    if (v.error || v.status !== 0) return `JUMPER_RENODE_RUNTIME is native, but Renode did not run as '${renodeBinary()}' (${v.error?.message ?? (v.stderr || "").trim()}). Fix: set JUMPER_RENODE_BIN to Renode 1.17's executable (Renode.app/Contents/MacOS/renode on macOS), or unset JUMPER_RENODE_RUNTIME to use Docker.`;
    return undefined;
  }
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 });
  if (info.error && (info.error as NodeJS.ErrnoException).code === "ENOENT") {
    return "This board runs in Renode inside Docker, and the 'docker' command was not found. Fix: install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then run again.";
  }
  if (info.error) {
    return `This board runs in Renode inside Docker, and Docker did not answer within 15 s (${info.error.message}). Why: Docker Desktop is starting, stuck or out of disk space. Fix: open Docker Desktop and wait until it says running (restart it if it hangs; free disk space if it is full), then run again.`;
  }
  if (info.status !== 0) {
    return `This board runs in Renode inside Docker, and Docker is not running (${(info.stderr || "docker info failed").trim().split("\n")[0]}). Fix: start Docker Desktop (macOS: open -a Docker), wait until it says running, then run again.`;
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
