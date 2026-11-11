// Round 11: runtime selection (JUMPER_RUNTIME) with a fake `docker` on PATH and a fake native install
// in a temporary JUMPER_HOME. No real Docker or toolchain needed.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickRuntime, probeDocker, qemuPreflight, renodeUnavailable, resetDockerProbe } from "@jumper/sim-backends/node";
import { arduinoRuntimeFor, canBuildArduino, nativeFamilyOf, NATIVE_CORES, setupNameFor } from "../src/index.ts";
import { nativeToolchainId } from "../src/native/arduino.ts";
import { setupTargetOf } from "../src/native/setup.ts";

let dir: string;
const saved = { ...process.env };

/** A `docker` that answers `info` per `mode` and `image inspect` with `images` present. */
function fakeDocker(mode: "up" | "down" | "hang", images: string[] = []): void {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
case "$1" in
  info) ${mode === "up" ? 'echo 29.0.0; exit 0' : mode === "down" ? 'echo "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?" >&2; exit 1' : "sleep 10"} ;;
  image) eval last=\\$\$#; for i in ${images.map((i) => `"${i}"`).join(" ") || '""'}; do [ "$i" = "$last" ] && exit 0; done; exit 1 ;;
esac
exit 1
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  resetDockerProbe();
}

/** Marks a native core as installed in the temporary JUMPER_HOME. */
function fakeNative(family: keyof typeof NATIVE_CORES): void {
  const root = join(dir, "home", "toolchains", "arduino", "1.5.1");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "installed"), { recursive: true });
  writeFileSync(join(root, "bin", "arduino-cli"), "#!/bin/sh\n");
  writeFileSync(join(root, "installed", `${family}.json`), JSON.stringify({ core: NATIVE_CORES[family].core, cli: "1.5.1" }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jumper-rt-"));
  process.env.JUMPER_HOME = join(dir, "home");
  delete process.env.JUMPER_RUNTIME;
  delete process.env.JUMPER_QEMU_ESP_RUNTIME;
  delete process.env.JUMPER_RENODE_RUNTIME;
  delete process.env.JUMPER_RENODE_BIN;
  delete process.env.JUMPER_QEMU_ESP_DIR;
});

afterEach(() => {
  process.env = { ...saved };
  resetDockerProbe();
  rmSync(dir, { recursive: true, force: true });
});

describe("JUMPER_RUNTIME selection", () => {
  it("forced values win; auto takes Docker when it answers, native otherwise", () => {
    fakeDocker("up");
    expect(pickRuntime({ nativeInstalled: () => true })).toBe("docker");
    process.env.JUMPER_RUNTIME = "native";
    expect(pickRuntime({ nativeInstalled: () => false })).toBe("native");
    process.env.JUMPER_RUNTIME = "docker";
    expect(pickRuntime({ nativeInstalled: () => true })).toBe("docker");
    delete process.env.JUMPER_RUNTIME;
    expect(pickRuntime({ override: "native", nativeInstalled: () => false })).toBe("native");
    fakeDocker("down");
    expect(pickRuntime({ nativeInstalled: () => true })).toBe("native");
    // Nothing usable: Docker, so its own error (with the fix) is what the person reads.
    expect(pickRuntime({ nativeInstalled: () => false })).toBe("docker");
  });

  it("auto prefers a ready native install over a Docker image that would have to be built", () => {
    fakeDocker("up");
    expect(pickRuntime({ nativeInstalled: () => true, dockerReady: () => false })).toBe("native");
    expect(pickRuntime({ nativeInstalled: () => true, dockerReady: () => true })).toBe("docker");
    expect(pickRuntime({ nativeInstalled: () => false, dockerReady: () => false })).toBe("docker");
  });

  it("a hung Docker costs one short probe, then native", () => {
    fakeDocker("hang");
    process.env.JUMPER_DOCKER_PROBE_MS = "400";
    const t0 = Date.now();
    const p = probeDocker(true);
    expect(p.ok).toBe(false);
    expect(p.why).toMatch(/did not answer within/);
    expect(Date.now() - t0).toBeLessThan(3_000);
    const t1 = Date.now();
    expect(pickRuntime({ nativeInstalled: () => true })).toBe("native");
    expect(Date.now() - t1).toBeLessThan(100); // cached
  });
});

describe("Arduino builds pick a runtime per board family", () => {
  it("maps FQBNs to native families and setup names", () => {
    expect(nativeFamilyOf("arduino:avr:uno")).toBe("avr");
    expect(nativeFamilyOf("esp32:esp32:XIAO_ESP32S3")).toBe("esp32");
    expect(nativeFamilyOf("STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8")).toBe("stm32");
    expect(nativeFamilyOf("arduino:mbed_nano:nano33ble")).toBe("mbed_nano");
    expect(setupNameFor("arduino:mbed_nano:nano33ble")).toBe("nrf52");
    expect(setupNameFor("Seeeduino:nrf52:xiaonRF52840")).toBe("nrf52");
    expect(setupTargetOf("pico")).toBe("rp2040");
    expect(setupTargetOf("renode")).toBe("renode");
    expect(nativeToolchainId("esp32")).toMatch(/^native:arduino-cli@1\.5\.1\/esp32:esp32@3\.3\.12\//);
  });

  it("Docker down + native installed: native; nothing installed: what failed, why, and the fix", async () => {
    fakeDocker("down");
    await expect(arduinoRuntimeFor("arduino:avr:uno")).rejects.toThrow(/nothing on this computer can compile for arduino:avr:uno\. Why: Docker is not running .*Fix: run `jumper setup avr`/);
    expect(canBuildArduino("arduino:avr:uno")).toMatchObject({ ok: false });
    fakeNative("avr");
    await expect(arduinoRuntimeFor("arduino:avr:uno")).resolves.toBe("native");
    expect(canBuildArduino("arduino:avr:uno")).toEqual({ ok: true, runtime: "native" });
    // Another family is still missing.
    await expect(arduinoRuntimeFor("esp32:esp32:esp32")).rejects.toThrow(/jumper setup esp32/);
  });

  it("Docker up: its image when present, the native toolchain when the image is missing", async () => {
    fakeNative("avr");
    fakeDocker("up", ["jumper/arduino-runner:1.5.1-avr1.8.8-libs3-r1"]);
    await expect(arduinoRuntimeFor("arduino:avr:uno")).resolves.toBe("docker");
    fakeDocker("up", []);
    await expect(arduinoRuntimeFor("arduino:avr:uno")).resolves.toBe("native");
    // No native rp2040: Docker builds its image as before.
    await expect(arduinoRuntimeFor("rp2040:rp2040:rpipico")).resolves.toBe("docker");
  });

  it("JUMPER_RUNTIME=native without the toolchain says which setup to run", async () => {
    fakeDocker("up");
    process.env.JUMPER_RUNTIME = "native";
    await expect(arduinoRuntimeFor("STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8")).rejects.toThrow(/JUMPER_RUNTIME is native.*Fix: run `jumper setup stm32`/);
  });
});

describe("emulators say why and how to fix it when neither runtime is there", () => {
  it("QEMU and Renode name jumper setup and Docker", () => {
    fakeDocker("down");
    process.env.JUMPER_QEMU_ESP_DIR = join(dir, "no-qemu");
    process.env.PATH = `${join(dir, "bin")}:/usr/bin:/bin`;
    expect(qemuPreflight()).toMatch(/Docker is not running.*native QEMU is not installed either\. Fix: run `jumper setup esp32`.*or start Docker Desktop/);
    expect(qemuPreflight({ runtime: "native" })).toMatch(/native ESP32 emulator is not installed.*Docker cannot run it instead: Docker is not running.*Fix: run `jumper setup esp32`/);
    expect(renodeUnavailable()).toMatch(/Renode is not installed natively.*Fix: run `jumper setup renode`/);
  });
});
