import { spawn } from "node:child_process";
import { BASE_DOCKERFILE_DIR, BASE_IMAGE, RUNNER_DOCKERFILE_DIR, RUNNER_IMAGE } from "./config.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, collect output. Never throws for a non-zero exit; throws only if the binary is missing. */
export function exec(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          stderr += `\n[jumper] killed after ${opts.timeoutMs} ms`;
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

/** Throws a RunnerError that says what to do when Docker is missing or not running. */
export async function ensureDocker(): Promise<void> {
  let res: ExecResult;
  try {
    res = await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  } catch {
    throw new RunnerError(
      "docker-missing",
      "Build failed: the 'docker' command was not found, and Jumper compiles firmware inside a pinned Docker image. Fix: install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then build again.",
    );
  }
  if (res.code !== 0) {
    throw new RunnerError(
      "docker-not-running",
      `Build failed: Docker is installed but not running (${firstLine(res.stderr) || "docker info failed"}). Fix: start Docker Desktop (macOS: open -a Docker), wait until it says "running", then build again.`,
    );
  }
}

let imageReady: Promise<void> | undefined;

/** Builds the base toolchain image and the runner image if they are missing (first run: a few minutes). */
export function ensureImage(log: (line: string) => void = () => {}): Promise<void> {
  imageReady ??= (async () => {
    if ((await exec("docker", ["image", "inspect", RUNNER_IMAGE])).code === 0) return;
    if ((await exec("docker", ["image", "inspect", BASE_IMAGE])).code !== 0) {
      log(`building toolchain image ${BASE_IMAGE} (first run only, a few minutes)…`);
      const r = await exec("docker", ["build", "-t", BASE_IMAGE, BASE_DOCKERFILE_DIR], { timeoutMs: 20 * 60_000 });
      if (r.code !== 0) throw new RunnerError("image-build-failed", `Could not build the toolchain image ${BASE_IMAGE}: ${tail(r.stderr || r.stdout)}. Fix: check your network connection (it downloads arduino-cli and the AVR core), then build again.`);
    }
    log(`building runner image ${RUNNER_IMAGE} (pinned libraries)…`);
    const r = await exec("docker", ["build", "--build-arg", `BASE_IMAGE=${BASE_IMAGE}`, "-t", RUNNER_IMAGE, RUNNER_DOCKERFILE_DIR], { timeoutMs: 20 * 60_000 });
    if (r.code !== 0) throw new RunnerError("image-build-failed", `Could not build the runner image ${RUNNER_IMAGE}: ${tail(r.stderr || r.stdout)}. Fix: check your network connection (it downloads Arduino libraries), then build again.`);
  })().catch((err) => {
    imageReady = undefined;
    throw err;
  });
  return imageReady;
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]?.trim() ?? "";
}

function tail(s: string, n = 6): string {
  return s.trim().split("\n").slice(-n).join(" | ");
}
