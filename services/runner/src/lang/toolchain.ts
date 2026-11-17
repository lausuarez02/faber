// Toolchain images for the languages beyond Arduino: one pinned Docker image per toolchain, built
// from toolchains/<dir> on first use (or ahead of time with `faber setup <language>`), run with
// the project copied into /work/project and the outputs read back from /work/out.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config.ts";
import { ensureDocker, exec, RunnerError, type ExecResult } from "../docker.ts";

export interface ToolchainImage {
  /** Pinned tag, e.g. "faber/esp-idf:5.5.5-r1". */
  image: string;
  /** Folder under toolchains/ with its Dockerfile. */
  dir: string;
  /** Image it is built FROM, if it is one of Faber's (built first when missing). */
  base?: { image: string; dir: string; buildArg: string };
  /** What `faber setup` calls it, and how long / large the first build is, in plain words. */
  setup: string;
  firstBuild: string;
}

export const ESP_IDF_IMAGE: ToolchainImage = {
  image: process.env.FABER_ESP_IDF_IMAGE ?? "faber/esp-idf:5.5.5-r1",
  dir: "toolchains/esp-idf",
  base: { image: "faber/arduino-esp32:3.3.12-r2", dir: "toolchains/arduino-esp32", buildArg: "BASE_IMAGE" },
  setup: "esp-idf",
  firstBuild: "about 1.5 GB on top of the ESP32 Arduino image (6.5 GB), 5 to 15 minutes",
};

export const PLATFORMIO_IMAGE: ToolchainImage = {
  image: process.env.FABER_PLATFORMIO_IMAGE ?? "faber/platformio:6.2.0-avr5.3.0-r1",
  dir: "toolchains/platformio",
  setup: "platformio",
  firstBuild: "about 400 MB, 1 to 3 minutes",
};

const ready = new Map<string, Promise<void>>();

async function imageExists(image: string): Promise<boolean> {
  return (await exec("docker", ["image", "inspect", image])).code === 0;
}

/** Build the toolchain image (and its Faber base image) if missing. Errors say why and how to fix. */
export function ensureToolchainImage(t: ToolchainImage, log: (l: string) => void = () => {}): Promise<void> {
  let p = ready.get(t.image);
  if (!p) {
    p = (async () => {
      await ensureDocker();
      if (await imageExists(t.image)) return;
      if (process.env.FABER_NO_IMAGE_BUILD) {
        throw new RunnerError("image-missing", `Build failed: the toolchain image ${t.image} is not installed. Fix: run "faber setup ${t.setup}" (${t.firstBuild}), then build again.`);
      }
      if (t.base && !(await imageExists(t.base.image))) {
        log(`building ${t.base.image} first (the ${t.setup} image is built on it)…`);
        const r = await exec("docker", ["build", "-t", t.base.image, join(REPO_ROOT, t.base.dir)], { timeoutMs: 60 * 60_000 });
        if (r.code !== 0) throw new RunnerError("image-build-failed", `Could not build ${t.base.image}: ${tail(r.stderr || r.stdout)}. Fix: check your network connection and free disk space, then run "faber setup ${t.setup}".`);
      }
      log(`building toolchain image ${t.image} (first ${t.setup} build only: ${t.firstBuild})…`);
      const args = ["build", "-t", t.image, ...(t.base ? ["--build-arg", `${t.base.buildArg}=${t.base.image}`] : []), join(REPO_ROOT, t.dir)];
      const r = await exec("docker", args, { timeoutMs: 60 * 60_000 });
      if (r.code !== 0) throw new RunnerError("image-build-failed", `Could not build the toolchain image ${t.image}: ${tail(r.stderr || r.stdout)}. Fix: check your network connection and free disk space (${t.firstBuild}), then run "faber setup ${t.setup}".`);
    })().catch((err) => {
      ready.delete(t.image);
      throw err;
    });
    ready.set(t.image, p);
  }
  return p;
}

function uidArgs(): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && gid !== undefined ? ["--user", `${uid}:${gid}`] : [];
}

/** Copy `projectDir` into a fresh work folder and run the image's entrypoint with `args`. */
export async function runToolchain(
  t: ToolchainImage,
  work: string,
  projectDir: string,
  args: string[],
  opts: { timeoutMs?: number; network?: boolean; cache?: string; env?: Record<string, string> } = {},
): Promise<ExecResult & { out: string }> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "out"), { recursive: true });
  cpSync(projectDir, join(work, "project"), {
    recursive: true,
    // Never copy a previous local build into the container.
    filter: (src) => !/[/\\](build|\.pio|target|\.git)$/.test(src),
  });
  const mounts = ["-v", `${work}:/work`];
  if (opts.cache) {
    mkdirSync(opts.cache, { recursive: true });
    mounts.push("-v", `${opts.cache}:/cache`);
  }
  const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await exec("docker", ["run", "--rm", ...(opts.network ? [] : ["--network", "none"]), ...uidArgs(), ...mounts, ...env, t.image, ...args], { timeoutMs: opts.timeoutMs ?? 20 * 60_000 });
  return { ...r, out: join(work, "out") };
}

/** Files directly in a folder (for collecting outputs). */
export function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()) : [];
}

function tail(s: string, n = 6): string {
  return s.trim().split("\n").slice(-n).join(" | ");
}
