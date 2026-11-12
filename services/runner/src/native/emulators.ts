// Round 11: native emulators managed by Jumper, for a machine without (working) Docker.
//
//   ~/.jumper/emulators/qemu-esp/<tag>   Espressif QEMU 9.2.2 + Jumper's patches 0001-0006 (bridge v6 + camera port),
//                                        built on this machine from source (Jumper does not ship QEMU
//                                        binaries; GPL-2.0, its own process). Same configure flags as
//                                        toolchains/qemu-esp/Dockerfile, macOS UI parts off.
//   ~/.jumper/emulators/renode/1.17.0    Renode 1.17.0 portable (MIT), the release archive, SHA-256 checked.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { jumperHome, jumperRenodeBinary, NATIVE_QEMU_TAG, nativeQemuDir, nativeQemuInstalled, nativeRenodeDir, RENODE_VERSION } from "@jumper/sim-backends/node";
import { REPO_ROOT } from "../config.ts";
import { RunnerError } from "../docker.ts";
import { download, run } from "./arduino.ts";

/** Espressif's QEMU release tag the patches apply to (toolchains/qemu-esp/Dockerfile QEMU_TAG). */
export const QEMU_UPSTREAM_TAG = "esp-develop-9.2.2-20260417";
export const QEMU_PATCHES = ["0001-jumper-bridge.patch", "0002-jumper-peripherals.patch", "0003-jumper-pads.patch", "0004-jumper-i2s.patch", "0005-jumper-eth-rx.patch", "0006-jumper-camera.patch"];
/** The branch of a JUMPER_QEMU_SRC checkout that equals the patch series applied to the tag. */
export const QEMU_SRC_BRANCH = "jumper-jb7";
/** toolchains/qemu-esp/Dockerfile's configure line, plus what a Mac build leaves out (Cocoa UI, GnuTLS). */
export const QEMU_CONFIGURE = [
  "--target-list=xtensa-softmmu,riscv32-softmmu",
  "--enable-gcrypt", "--enable-slirp", "--disable-gnutls", "--disable-sdl", "--disable-gtk", "--disable-vnc", "--disable-capstone",
  "--disable-docs", "--disable-tools", "--disable-user", "--disable-werror", "--disable-containers",
];
const BUILD_TOOLS = ["ninja==1.13.0", "tomli==2.2.1"];

export const RENODE_ASSETS: Record<string, { file: string; sha256: string; kind: "dmg" | "tar" }> = {
  "darwin-arm64": { file: `renode-${RENODE_VERSION}.osx-arm64-portable.dmg`, sha256: "63b1fb691207f503cea937e4ec8fad3e068a517d0abac3c24c0206c62f6c4d12", kind: "dmg" },
  "linux-arm64": { file: `renode-${RENODE_VERSION}.linux-arm64-portable.tar.gz`, sha256: "e9051578411441bfb47b77de0381cfba3badce03663367fab561472fd7807f1f", kind: "tar" },
};

function tail(s: string, n = 6): string {
  return s.trim().split("\n").slice(-n).join(" | ");
}

/** What the QEMU build needs from the machine, each with its fix. Empty when ready. */
export function qemuBuildPrereqs(): string[] {
  const missing: string[] = [];
  if (spawnSync("cc", ["--version"], { stdio: "ignore" }).status !== 0) missing.push(platform() === "darwin" ? "a C compiler (Fix: xcode-select --install)" : "a C compiler (Fix: install build-essential)");
  if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) missing.push("python3 (Fix: xcode-select --install, or install Python 3)");
  if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) missing.push("git (Fix: xcode-select --install)");
  const pc = spawnSync("pkg-config", ["--version"], { stdio: "ignore" });
  if (pc.status !== 0) missing.push(platform() === "darwin" ? "pkg-config (Fix: brew install pkgconf)" : "pkg-config (Fix: apt install pkg-config)");
  else {
    // libslirp: QEMU's user networking, as in the Docker image (--enable-slirp). Espressif's 9.2.2 also
    // compiles net/slirp.c when slirp is disabled, so the build needs its header either way.
    for (const [mod, brew, apt] of [["glib-2.0", "glib", "libglib2.0-dev"], ["pixman-1", "pixman", "libpixman-1-dev"], ["libgcrypt", "libgcrypt", "libgcrypt20-dev"], ["slirp", "libslirp", "libslirp-dev"]] as const) {
      if (spawnSync("pkg-config", ["--exists", mod], { stdio: "ignore" }).status !== 0) missing.push(`${mod} (Fix: ${platform() === "darwin" ? `brew install ${brew}` : `apt install ${apt}`})`);
    }
  }
  return missing;
}

/**
 * A private Python venv with what QEMU's build needs beyond the system: ninja, and tomli for Pythons
 * older than 3.11 (macOS ships 3.9). Pinned, from PyPI, once. Returns its bin folder.
 */
async function ensureBuildTools(log: (l: string) => void): Promise<string> {
  const venv = join(jumperHome(), "emulators", "qemu-esp", ".tools");
  const bin = join(venv, "bin");
  const ok = () => spawnSync(join(bin, "ninja"), ["--version"], { stdio: "ignore" }).status === 0 && spawnSync(join(bin, "python3"), ["-c", "import tomli"], { stdio: "ignore" }).status === 0;
  if (ok()) return bin;
  log(`installing QEMU's build tools (${BUILD_TOOLS.join(", ")}) into ${venv}…`);
  let r = await run("python3", ["-m", "venv", venv]);
  if (r.code === 0) r = await run(join(bin, "pip"), ["install", "--disable-pip-version-check", "--quiet", ...BUILD_TOOLS]);
  if (r.code !== 0 || !ok()) throw new RunnerError("qemu-build-failed", `Could not install QEMU's build tools (${BUILD_TOOLS.join(", ")}): ${tail(r.stderr || r.stdout)}. Why: pip could not reach PyPI, or python3 has no venv module. Fix: check your connection (or brew install ninja), then run \`jumper setup esp32\` again.`);
  return bin;
}

/**
 * Builds Jumper's patched QEMU into ~/.jumper/emulators/qemu-esp/<tag> (once; a few minutes).
 * Source: JUMPER_QEMU_SRC (a git checkout with branch QEMU_SRC_BRANCH, e.g. the spike repo) or Espressif's
 * tag cloned from GitHub with toolchains/qemu-esp's patches applied.
 */
export async function installNativeQemu(log: (l: string) => void = () => {}, opts: { force?: boolean } = {}): Promise<{ dir: string; built: boolean }> {
  const dest = nativeQemuDir();
  if (nativeQemuInstalled() && !opts.force) return { dir: dest, built: false };
  const missing = qemuBuildPrereqs();
  if (missing.length) {
    throw new RunnerError("qemu-prereqs", `Can't build the ESP32 emulator on this computer yet. Why: Jumper builds its patched QEMU from source here, and these are missing: ${missing.join("; ")}. Fix: install them, then run \`jumper setup esp32\` again (or use Docker: JUMPER_RUNTIME=docker).`);
  }
  const toolsBin = await ensureBuildTools(log);
  const env = { ...process.env, PATH: `${toolsBin}:${process.env.PATH ?? ""}` };
  const work = mkdtempSync(join(tmpdir(), "jumper-qemu-"));
  const src = join(work, "src");
  try {
    const spike = process.env.JUMPER_QEMU_SRC;
    if (spike) {
      log(`QEMU source: ${spike} (branch ${QEMU_SRC_BRANCH})…`);
      mkdirSync(src, { recursive: true });
      const r = await run("sh", ["-c", `git -C "$1" archive "$3" | tar -x -C "$2"`, "sh", spike, src, QEMU_SRC_BRANCH]);
      if (r.code !== 0) throw new RunnerError("qemu-build-failed", `Could not export branch ${QEMU_SRC_BRANCH} from ${spike}: ${tail(r.stderr)}. Fix: point JUMPER_QEMU_SRC at a QEMU checkout that has the ${QEMU_SRC_BRANCH} branch, or unset it to clone Espressif's QEMU.`);
    } else {
      log(`cloning Espressif's QEMU ${QEMU_UPSTREAM_TAG} from GitHub (about 200 MB)…`);
      let r = await run("git", ["clone", "--depth", "1", "--branch", QEMU_UPSTREAM_TAG, "https://github.com/espressif/qemu", src], { onLine: (l) => log(`  ${l}`) });
      if (r.code !== 0) throw new RunnerError("qemu-build-failed", `Could not clone Espressif's QEMU: ${tail(r.stderr)}. Fix: check your connection, then run \`jumper setup esp32\` again.`);
      for (const p of QEMU_PATCHES) {
        r = await run("git", ["-C", src, "apply", join(REPO_ROOT, "toolchains/qemu-esp", p)]);
        if (r.code !== 0) throw new RunnerError("qemu-build-failed", `Jumper's QEMU patch ${p} did not apply to ${QEMU_UPSTREAM_TAG}: ${tail(r.stderr)}. Why: the patch and the pinned tag are out of step. Fix: report it; meanwhile use Docker (JUMPER_RUNTIME=docker).`);
      }
    }
    const build = join(src, "build");
    mkdirSync(build, { recursive: true });
    log("configuring QEMU (xtensa + riscv32, the Docker image's options)…");
    let r = await run(join(src, "configure"), [`--prefix=${dest}`, `--python=${join(toolsBin, "python3")}`, ...QEMU_CONFIGURE, ...(platform() === "darwin" ? ["--disable-cocoa"] : [])], { cwd: build, env, onLine: () => {} });
    if (r.code !== 0) throw new RunnerError("qemu-build-failed", `QEMU's configure failed: ${tail(r.stdout + r.stderr)}. Fix: install what it names (macOS: brew install glib pixman libgcrypt libslirp pkgconf), then run \`jumper setup esp32\` again.`);
    const jobs = String(Math.max(2, cpus().length));
    log(`compiling QEMU with ${jobs} jobs (2 to 5 minutes)…`);
    let lastPct = -10;
    r = await run("ninja", ["-C", build, "-j", jobs, "install"], {
      env,
      onLine: (l) => {
        const m = l.match(/^\[(\d+)\/(\d+)\]/);
        if (!m) return;
        const pct = Math.floor((Number(m[1]) / Number(m[2])) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct - (pct % 10);
          log(`  QEMU: ${lastPct} %`);
        }
      },
    });
    if (r.code !== 0) {
      const logFile = join(jumperHome(), "emulators", "qemu-esp", "build-failed.log");
      mkdirSync(join(jumperHome(), "emulators", "qemu-esp"), { recursive: true });
      writeFileSync(logFile, r.stdout + r.stderr);
      const errors = (r.stdout + r.stderr).split("\n").filter((l) => /error:|^FAILED:/.test(l)).slice(0, 4).join(" | ");
      throw new RunnerError("qemu-build-failed", `Compiling QEMU failed: ${errors || tail(r.stdout + r.stderr)}. Fix: run \`jumper setup esp32\` again; if it fails the same way, report ${logFile} (meanwhile JUMPER_RUNTIME=docker).`);
    }
    // Keep only what Jumper runs (the install also copies firmware blobs for other boards).
    for (const sub of ["share/applications", "share/icons", "share/doc"]) rmSync(join(dest, sub), { recursive: true, force: true });
    writeFileSync(join(dest, "JUMPER-BUILD.txt"), `Espressif QEMU ${QEMU_UPSTREAM_TAG} + Jumper patches ${QEMU_PATCHES.join(", ")} (bridge v6)\nsource: ${spike ? `${spike} branch ${QEMU_SRC_BRANCH}` : "github.com/espressif/qemu"}\nconfigure: ${QEMU_CONFIGURE.join(" ")}\nhost: ${platform()}-${arch()}\nbuilt: ${new Date().toISOString()}\n`);
    if (!nativeQemuInstalled()) throw new RunnerError("qemu-build-failed", `QEMU built but ${dest}/bin has no qemu-system-xtensa / qemu-system-riscv32. Fix: run \`jumper setup esp32\` again.`);
    return { dir: dest, built: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Downloads Renode 1.17.0 (SHA-256 checked) into ~/.jumper/emulators/renode/1.17.0 (once). */
export async function installNativeRenode(log: (l: string) => void = () => {}): Promise<{ dir: string; installed: boolean }> {
  const dir = nativeRenodeDir();
  if (existsSync(jumperRenodeBinary())) return { dir, installed: false };
  const key = `${platform()}-${arch()}`;
  const asset = RENODE_ASSETS[key];
  if (!asset) {
    throw new RunnerError("native-unsupported", `Jumper has no native Renode for ${key}. Why: the pinned native Renode builds are macOS arm64 and Linux arm64. Fix: use Docker (jumper/renode image), or install Renode ${RENODE_VERSION} yourself and set JUMPER_RENODE_BIN to its executable.`);
  }
  const dl = join(jumperHome(), "downloads", asset.file);
  log(`downloading Renode ${RENODE_VERSION} (${asset.file}, about 75 MB, SHA-256 checked)…`);
  await download(`https://github.com/renode/renode/releases/download/v${RENODE_VERSION}/${asset.file}`, dl, asset.sha256, log, `Renode ${RENODE_VERSION}`);
  mkdirSync(dir, { recursive: true });
  if (asset.kind === "dmg") {
    const mnt = mkdtempSync(join(tmpdir(), "jumper-renode-"));
    let r = await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, dl]);
    if (r.code !== 0) throw new RunnerError("unpack-failed", `Could not open ${asset.file}: ${tail(r.stderr)}. Fix: run \`jumper setup renode\` again.`);
    try {
      const app = readdirSync(mnt).find((n) => n.endsWith(".app"));
      if (!app) throw new RunnerError("unpack-failed", `${asset.file} has no .app inside. Fix: run \`jumper setup renode\` again.`);
      r = await run("ditto", [join(mnt, app), join(dir, "Renode.app")]);
      if (r.code !== 0) throw new RunnerError("unpack-failed", `Could not copy Renode.app: ${tail(r.stderr)}. Fix: free disk space, then run \`jumper setup renode\` again.`);
    } finally {
      await run("hdiutil", ["detach", "-quiet", mnt]);
      rmSync(mnt, { recursive: true, force: true });
    }
  } else {
    const r = await run("tar", ["-xzf", dl, "-C", dir, "--strip-components=1"]);
    if (r.code !== 0) throw new RunnerError("unpack-failed", `Could not unpack ${asset.file}: ${tail(r.stderr)}. Fix: run \`jumper setup renode\` again.`);
  }
  rmSync(dl, { force: true });
  const v = await run(jumperRenodeBinary(), ["--version"]).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
  if (v.code !== 0) throw new RunnerError("renode-broken", `Renode was installed but does not start (${tail(v.stderr || v.stdout)}). Why: ${platform() === "darwin" ? "macOS may block the unsigned app" : "a library it needs is missing (libicu)"}. Fix: ${platform() === "darwin" ? `run \`xattr -dr com.apple.quarantine ${join(dir, "Renode.app")}\`` : "install libicu"}, then \`jumper setup renode\` again.`);
  log(`warming Renode's platform cache (the SVD files some boards fetch)…`);
  await warmRenode(log);
  return { dir, installed: true };
}

/** Same platforms toolchains/renode/Dockerfile warms, so later runs need no network. Best effort. */
async function warmRenode(log: (l: string) => void): Promise<void> {
  const plats = ["cpus/stm32f103", "cpus/stm32f4", "cpus/nrf52840", "boards/arduino_nano_33_ble"];
  const tmp = mkdtempSync(join(tmpdir(), "jumper-renode-warm-"));
  try {
    for (const p of plats) {
      const f = join(tmp, "w.resc");
      writeFileSync(f, `mach create\nmachine LoadPlatformDescription @platforms/${p}.repl\nquit\n`);
      const r = await run(jumperRenodeBinary(), ["--disable-gui", "--console", "--plain", f], { timeoutMs: 120_000 });
      if (r.code !== 0) log(`  (warming ${p} did not finish; Renode fetches it on first use instead)`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Removes a native install (used by `jumper setup --reinstall`). */
export function removeNative(what: "qemu" | "renode"): void {
  rmSync(what === "qemu" ? nativeQemuDir() : nativeRenodeDir(), { recursive: true, force: true });
}

export { NATIVE_QEMU_TAG, RENODE_VERSION };
