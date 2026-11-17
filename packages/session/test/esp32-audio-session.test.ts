// Round 13 (audio): a board that plays sound, through the session (the path agents, the CLI and the
// canvas use): a Seeed XIAO ESP32-S3 + MAX98357A I2S amplifier + a 20 mm 8 ohm speaker, an
// ESP_I2S sketch, the REAL toolchain and Espressif's QEMU (patch 0004, the I2S device). The run
// reports the amplifier playing at the level the samples have, the speaker sounding with the power
// it gets, and a recording of what was played (the page plays it) that is the sketch's 1 kHz tone.
// check_design warns that full-scale audio would overdrive this speaker.
// Needs the native ESP32 toolchain and QEMU (faber setup esp32) or Docker; skipped otherwise.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canBuildArduino } from "@faber/runner";
import { qemuImageAvailable } from "@faber/sim-backends/node";
import { ProjectSession } from "../src/index.ts";

const ready = qemuImageAvailable() && canBuildArduino("esp32:esp32:XIAO_ESP32S3").ok;
if (!ready) console.warn("skipping the ESP32 audio session test: the ESP32 toolchain and QEMU are not ready (Fix: pnpm faber setup esp32)");

const SKETCH = `// XIAO ESP32-S3 + MAX98357A: a 1 kHz beep, 300 ms on / 200 ms off, at 25 % of full scale.
#include <ESP_I2S.h>
I2SClass i2s;
int16_t buf[160];
void setup() {
  Serial.begin(115200);
  i2s.setPins(D1, D2, D3);  // BCLK, LRC (WS), DIN
  if (!i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) Serial.println("i2s failed");
  for (int i = 0; i < 160; i++) buf[i] = (int16_t)(8192 * sinf(2 * PI * 1000 * i / 16000.0f));
  Serial.println("beeper ready");
}
void loop() {
  for (int k = 0; k < 30; k++) i2s.write((uint8_t *)buf, sizeof(buf));  // 30 x 10 ms
  Serial.println("beep");
  delay(200);
}
`;

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe.skipIf(!ready)("an ESP32-S3 with an I2S amplifier and a speaker, through the session", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "faber-esp32-audio-"));
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("wires the amp and speaker; check_design says how loud the speaker may be driven", async () => {
    await call(s, "new_project", { template: "xiao-esp32s3" });
    await call(s, "place_part", { type: "max98357a", id: "amp" });
    await call(s, "place_part", { type: "speaker-20mm", id: "spk" });
    for (const [a, b] of [["amp.VIN", "xiao.5V"], ["amp.GND", "xiao.GND"], ["amp.BCLK", "xiao.GPIO2"], ["amp.LRC", "xiao.GPIO3"], ["amp.DIN", "xiao.GPIO4"], ["spk.+", "amp.OUT+"], ["spk.-", "amp.OUT-"]]) {
      await call(s, "connect", { from: a, to: b });
    }
    await call(s, "write_file", { path: "firmware/main.ino", content: SKETCH });
    const c = await call(s, "check_design");
    const text = JSON.stringify(c);
    expect(text).toContain("amp-speaker-overpower");
    expect(text).not.toContain("amp-no-speaker");
  });

  it("builds and runs: the amp plays the samples' level, the speaker sounds, and the run's recording is the 1 kHz beep", async () => {
    const b = await call(s, "build");
    expect(b.ok, JSON.stringify(b)).toBe(true);
    const r = await call(s, "run", { ms: 1500 });
    expect(r.serial).toContain("beeper ready");
    expect(r.serial).not.toContain("i2s failed");
    expect(r.serial).toContain("beep");
    // The amp reports what it plays: a 25 %-of-full-scale sine has an RMS of 0.177 (a block at the
    // end of a beep, part tone and part silence, reads lower; sample a few moments).
    const runs: Record<string, any>[] = [r];
    for (let i = 0; i < 10 && !runs.some((x) => x.parts.amp?.playing && x.parts.amp.level > 0.17); i++) runs.push(await call(s, "run", { ms: 60 }));
    const playing = runs.find((x) => x.parts.amp?.playing && x.parts.amp.level > 0.17);
    expect(playing, JSON.stringify(runs.map((x) => x.parts.amp))).toBeDefined();
    expect(playing!.parts.amp.level).toBeCloseTo(0.177, 2);
    expect(playing!.parts.amp.sampleRate).toBe(16000);
    expect(playing!.parts.spk.sounding).toBe(true);
    expect(r.audio).toMatch(/amp played I2S audio \(peak -12 dBFS\)/);
    // The recording the page plays: mono 16-bit at 16 kHz, the tone at its level.
    const file = /GET \/api\/audio\/(run-\d+\.wav)/.exec(r.audio)![1]!;
    const wav = readFileSync(join(dir, ".faber", "audio", file));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000);
    const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
    let peak = 0;
    let crossings = 0;
    let first = -1;
    let last = -1;
    let prev = 0;
    // The first beep: crossings inside its first 250 ms.
    const start = pcm.findIndex((v) => v !== 0);
    for (let i = start; i < start + 4000; i++) {
      const v = pcm[i]!;
      peak = Math.max(peak, Math.abs(v));
      if (v === 0) continue;
      const sg = Math.sign(v);
      if (prev && sg !== prev) {
        crossings++;
        if (first < 0) first = i;
        last = i;
      }
      prev = sg;
    }
    expect(peak).toBe(8192);
    expect(((crossings - 1) / 2) * (16000 / (last - first))).toBeCloseTo(1000, -1);
  });
});
