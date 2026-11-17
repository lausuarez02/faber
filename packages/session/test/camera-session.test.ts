// Round 13: a camera through the session, the path agents, the CLI and the canvas use. The XIAO
// ESP32-S3 Sense template (a camera starter sketch), built with the REAL toolchain (the board's
// simulator FQBN, the camera shim linked in), run in QEMU with the camera port: frames reach the
// firmware, set_camera_frame changes what it sees (a scene, an image in the project), the tests'
// camera_frame step, errors that say what to fix, and the factory build without the shim.
// Needs the native ESP32 toolchain + QEMU jb7 (fabwright setup esp32) or Docker; skipped otherwise.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildFirmware, canBuildArduino } from "@fabwright/runner";
import { qemuImageAvailable } from "@fabwright/sim-backends/node";
import { encodePng, encodeJpeg, renderScene } from "@fabwright/sim-core";
import { ProjectSession } from "../src/index.ts";

const ready = qemuImageAvailable() && canBuildArduino("esp32:esp32:XIAO_ESP32S3").ok;
if (!ready) console.warn("skipping the camera session test: the ESP32 toolchain or the emulator with the camera port is not ready (Fix: pnpm fabwright setup esp32)");

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;
const means = (serial: string) => [...serial.matchAll(/mean=(\d+)/g)].map((m) => Number(m[1]));

describe.skipIf(!ready)("a camera through the session (XIAO ESP32-S3 Sense, real build, QEMU camera port)", { timeout: 400_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fabwright-camera-session-"));
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds the camera starter with the shim (simulation build)", async () => {
    await call(s, "new_project", { template: "xiao-esp32s3-sense" });
    const b = await call(s, "build");
    expect(b.ok, JSON.stringify(b).slice(0, 2000)).toBe(true);
    expect(b.simulator_build).toMatch(/XIAO_ESP32S3:CDCOnBoot=cdc,FlashMode=dio,PSRAM=opi/);
  });

  it("runs: the firmware gets frames of the test card, the part shows a preview", async () => {
    const r = await call(s, "run", { ms: 1500 });
    expect(r.serial).toContain("ready");
    // the board's 8 MB octal PSRAM is in the emulator too (frame buffers in PSRAM, as on the board)
    expect(r.serial).not.toMatch(/PSRAM enabled but initialization failed/);
    const m = means(r.serial);
    expect(m.length).toBeGreaterThanOrEqual(2);
    // the test card's mean brightness at 160x120 grayscale
    const card = renderScene("test-card", 160, 120).rgba;
    let sum = 0;
    for (let i = 0; i < card.length; i += 4) sum += Math.round(0.299 * card[i]! + 0.587 * card[i + 1]! + 0.114 * card[i + 2]!);
    expect(m[0]).toBe(Math.floor(sum / (160 * 120)));
    const st = r.parts.sense ?? r.parts;
    expect(JSON.stringify(st)).toMatch(/camera_frames/);
  });

  it("set_camera_frame: a scene, then an image in the project, change what the running firmware sees", async () => {
    await call(s, "set_camera_frame", { scene: "white" });
    let r = await call(s, "run", { ms: 1100 });
    expect(means(r.serial).at(-1)).toBeGreaterThan(240);
    mkdirSync(join(dir, "tests"), { recursive: true });
    const gray = new Uint8Array(64 * 48 * 4).map((_, i) => (i % 4 === 3 ? 255 : 100));
    writeFileSync(join(dir, "tests/gray.png"), encodePng(gray, 64, 48));
    await call(s, "set_camera_frame", { image: "tests/gray.png" });
    r = await call(s, "run", { ms: 1100 });
    expect(means(r.serial).at(-1)).toBe(100);
    // a JPEG works too
    writeFileSync(join(dir, "tests/face.jpg"), encodeJpeg({ width: 320, height: 240, pixels: renderScene("face", 320, 240).rgba }, 90));
    const ok = await call(s, "set_camera_frame", { image: "tests/face.jpg" });
    expect(ok.part).toBe("sense");
    // and it was never saved in the project
    expect(JSON.stringify(s.project)).not.toMatch(/data:image/);
  });

  it("errors say what to fix", async () => {
    await expect(call(s, "set_camera_frame", { image: "../outside.png" })).rejects.toThrow(/inside the project/);
    await expect(call(s, "set_camera_frame", { image: "tests/missing.jpg" })).rejects.toThrow(/No image at tests\/missing.jpg/);
    await expect(call(s, "set_camera_frame", { scene: "moon" })).rejects.toThrow(/No test scene 'moon'/);
    writeFileSync(join(dir, "tests/bad.png"), "not a png");
    await expect(call(s, "set_camera_frame", { image: "tests/bad.png" })).rejects.toThrow(/Cannot read tests\/bad.png/);
  });

  it("run_tests: the template's camera_frame scenario passes (white then black)", async () => {
    const t = await call(s, "run_tests");
    expect(t.failed, JSON.stringify(t).slice(0, 3000)).toBe(0);
    expect(t.passed).toBe(1);
  });

  it("the device build links the real driver (no shim), the simulation build the shim", async () => {
    const sketch = join(dir, "firmware");
    const sim = await buildFirmware({ sketchDir: sketch, main: "main.ino", fqbn: "esp32:esp32:XIAO_ESP32S3:CDCOnBoot=cdc,FlashMode=dio,PSRAM=opi", cache: false });
    expect(sim.ok).toBe(true);
    expect(sim.logTail).toMatch(/camera shim on/);
    const dev = await buildFirmware({ sketchDir: sketch, main: "main.ino", fqbn: "esp32:esp32:XIAO_ESP32S3:PSRAM=opi", purpose: "device", cache: false });
    expect(dev.ok, dev.logTail).toBe(true);
    expect(dev.logTail).not.toMatch(/camera shim/);
  });
});
