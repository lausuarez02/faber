// Round 13, integrated: examples/see-and-say, one project built only from general parts (XIAO
// ESP32-S3 Sense camera + Wi-Fi, GC9A01 screen, MAX98357A + speaker, a button). Real build, real
// QEMU (camera port + I2S device + device network): a press captures a JPEG, the firmware POSTs it
// to a vision API through the project's relay, sends the answer to a speech API through the relay,
// and streams the audio it gets into I2S. Offline: the vision API is a mock, the speech API a cassette.
// Needs the native ESP32 toolchain + QEMU jb7 (faber setup esp32); skipped otherwise.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canBuildArduino } from "@faber/runner";
import { qemuImageAvailable } from "@faber/sim-backends/node";
import { ProjectSession } from "../src/index.ts";

const EXAMPLE = fileURLToPath(new URL("../../../examples/see-and-say/", import.meta.url));
const ready = qemuImageAvailable() && canBuildArduino("esp32:esp32:XIAO_ESP32S3").ok;
if (!ready) console.warn("skipping the see-and-say example test: the ESP32 toolchain or QEMU is not ready (Fix: pnpm faber setup esp32)");

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe.skipIf(!ready)("examples/see-and-say: picture -> vision API -> speech API -> speaker (real build, QEMU)", { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "faber-see-and-say-"));
  cpSync(EXAMPLE, dir, { recursive: true });
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("check_design: no errors; the only warning is the speaker's full-scale power (the firmware scales to 50 %)", async () => {
    const c = await call(s, "check_design");
    expect(c.errors, JSON.stringify(c)).toBe(0);
    const codes = (c.issues as string[]).map((i) => /\[([\w-]+)\]/.exec(i)?.[1]);
    expect(codes).toEqual(["amp-speaker-overpower"]);
  });

  it("run_tests: both scenarios pass offline (the full chain, and the vision API down)", async () => {
    const t = await call(s, "run_tests");
    expect(t.failed, JSON.stringify(t.results).slice(0, 4000)).toBe(0);
    expect(t.passed).toBe(2);
  });

  it("a press by hand: both calls go through the relay (mock, then cassette) and the run's recording is the speech, scaled", async () => {
    await call(s, "set_camera_frame", { scene: "face" });
    let r = await call(s, "run", { ms: 2500 });
    expect(r.serial).toContain("ready");
    const press = await call(s, "interact", { part: "btn", action: "click" });
    let serial = String(r.serial) + String(press.serial ?? "");
    const audio: string[] = [];
    for (let i = 0; i < 8 && !serial.includes("played"); i++) {
      r = await call(s, "run", { ms: 1000 });
      serial += String(r.serial);
      if (typeof r.audio === "string") audio.push(r.audio);
    }
    expect(serial).toMatch(/photo \d+ bytes 320x240/);
    expect(serial).toContain("said: Nice keyboard. Shame about the crumbs.");
    expect(serial).toContain("played 29760 bytes");

    const net = await call(s, "read_network", {});
    const http = ((net.entries ?? net.log ?? []) as Array<Record<string, unknown>>).filter((e) => e.kind === "http");
    expect(http.some((e) => e.via === "relay" && e.host === "api.vision.example" && e.status === 200 && e.source === "mock"), JSON.stringify(http.slice(-6))).toBe(true);
    expect(http.some((e) => e.via === "relay" && e.host === "api.speech.example" && e.status === 200 && e.source === "cassette"), JSON.stringify(http.slice(-6))).toBe(true);

    // The page plays what the board played: the API's chirp at the firmware's VOLUME (0.5 of 80 % FS).
    const file = audio.map((a) => /GET \/api\/audio\/(run-\d+\.wav)/.exec(a)?.[1]).filter(Boolean);
    expect(file.length, audio.join("\n")).toBeGreaterThan(0);
    let peak = 0;
    for (const f of file) {
      const wav = readFileSync(join(dir, ".faber", "audio", f!));
      const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(9000);
    expect(peak).toBeLessThanOrEqual(13200);
  });

  it("the device build has no relay settings (the person's faber_device.h adds them on their machine)", async () => {
    const dev = await s.deviceFirmware();
    expect("data" in dev, JSON.stringify(dev)).toBe(true);
    if (!("data" in dev)) return;
    const img = Buffer.from(dev.data as Uint8Array);
    expect(img.includes(Buffer.from("relay.sandbox.faber"))).toBe(false);
    expect(img.includes(Buffer.from("no relay in this build"))).toBe(true);
  });
});
