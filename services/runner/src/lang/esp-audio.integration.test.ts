// Round 13 (audio): real I2S on every ESP chip through QEMU jb6 (patch 0004). The esp_audio fixture
// (packages/sim-backends/fixtures/esp32/esp_audio, plain arduino-esp32 ESP_I2S code written for the
// real board) plays a 1 kHz sine, a WAV from flash (440 Hz), the tone at 8 / 22.05 / 44.1 kHz and at
// 48 kHz stereo 32-bit, then records from a microphone (PDM on the S3, standard I2S elsewhere).
// Checked on the frames the I2S bus receives: sample rate, bit depth, channel count, frequency
// (zero crossings) and level of every burst, the DMA pacing write() (it blocks for as long as the
// samples take to play), and the microphone reading what a source on the bus provides.
// Needs the QEMU image (Docker) or the native QEMU (fabwright setup esp32); skipped otherwise.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { I2sBus, type I2sBlock } from "@fabwright/sim-core";
import { QemuEspBackend, qemuImageAvailable } from "@fabwright/sim-backends/qemu-esp";
import { buildFirmware, flashImageOf } from "../build.ts";
import { canBuildArduino } from "../runtime.ts";

const FIX = fileURLToPath(new URL("../../../../packages/sim-backends/fixtures/esp32/", import.meta.url));
const available = qemuImageAvailable() && existsSync(`${FIX}esp_audio.esp32s3.bin.gz`);
type Chip = "esp32" | "esp32s3" | "esp32c3";
const CHIPS: Chip[] = ["esp32s3", "esp32c3", "esp32"];

interface Burst {
  rate: number;
  bits: number;
  channels: number;
  /** Channel 0 samples of the burst. */
  left: number[];
  /** Largest |sample| of the other channels (stereo). */
  otherPeak: number;
}

/** Splits what the bus received into bursts of sound: same format, separated by >= 200 silent frames. */
export function burstsOf(blocks: readonly I2sBlock[]): Burst[] {
  const out: Burst[] = [];
  let cur: Burst | undefined;
  let quiet = 0;
  for (const b of blocks) {
    const ch = Math.max(1, b.channels);
    for (let i = 0; i + ch - 1 < b.samples.length; i += ch) {
      const v = b.samples[i]!;
      let other = 0;
      for (let c = 1; c < ch; c++) other = Math.max(other, Math.abs(b.samples[i + c]!));
      const sameFormat = cur && cur.rate === b.sampleRate && cur.bits === b.bits && cur.channels === ch;
      if (v === 0 && other === 0) {
        quiet++;
        if (cur && (quiet >= 200 || !sameFormat)) cur = undefined;
        else if (cur) cur.left.push(0);
        continue;
      }
      if (!sameFormat) {
        cur = { rate: b.sampleRate, bits: b.bits, channels: ch, left: [], otherPeak: 0 };
        out.push(cur);
      } else if (quiet) {
        // short silence inside a burst stays in it (zeros of the sine itself)
      }
      quiet = 0;
      cur!.left.push(v);
      cur!.otherPeak = Math.max(cur!.otherPeak, other);
    }
  }
  return out.filter((x) => x.left.length >= 300);
}

/** The longest stretch of a burst without 4 or more zeros in a row (a gap where the DMA ran dry). */
function longestRun(x: number[]): number[] {
  let best: [number, number] = [0, 0];
  let start = 0;
  let zeros = 0;
  for (let i = 0; i <= x.length; i++) {
    if (i < x.length && x[i] === 0) zeros++;
    if (i === x.length || zeros >= 4) {
      const end = i - zeros;
      if (end - start > best[1] - best[0]) best = [start, end];
      if (i < x.length) {
        while (i < x.length && x[i] === 0) i++;
        start = i;
        zeros = 0;
        i--;
      }
    } else if (x[i] !== 0) zeros = 0;
  }
  return x.slice(best[0], best[1]);
}

/** Frequency from sign changes (zeros skipped) over the longest gap-free stretch, the peak, and the frames to the last sample. */
export function toneOf(b: Burst): { hz: number; peak: number; frames: number; gapFrames: number } {
  const run = longestRun(b.left);
  let last = 0;
  let changes = 0;
  let first = -1;
  let lastAt = -1;
  run.forEach((v, i) => {
    if (v === 0) return;
    const sgn = Math.sign(v);
    if (last && sgn !== last) {
      changes++;
      if (first < 0) first = i;
      lastAt = i;
    }
    last = sgn;
  });
  const hz = changes > 1 ? ((changes - 1) / 2) * (b.rate / (lastAt - first)) : 0;
  let end = b.left.length;
  while (end > 0 && b.left[end - 1] === 0) end--;
  const peak = b.left.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  // Silent frames inside the burst: runs of 4 or more zeros before its last sample.
  let gapFrames = 0;
  for (let i = 0, z = 0; i <= end; i++) {
    if (i < end && b.left[i] === 0) z++;
    else {
      if (z >= 4) gapFrames += z;
      z = 0;
    }
  }
  return { hz, peak, frames: end, gapFrames };
}

function boot(chip: Chip, image?: Uint8Array) {
  const be = new QemuEspBackend({ chip, network: false });
  let serial = "";
  be.onSerial((b) => (serial += String.fromCharCode(b)));
  const bus = new I2sBus();
  const blocks: I2sBlock[] = [];
  bus.onBlock((b) => blocks.push(b));
  // A microphone stand-in: a 500 Hz sine at 8000 (about -12 dBFS), on the left / first slot.
  let frame = 0;
  bus.attach("mic", {
    i2sProvide: (req) => {
      const out = new Int32Array(req.frames * req.channels);
      for (let f = 0; f < req.frames; f++) out[f * req.channels] = Math.round(8000 * Math.sin((2 * Math.PI * 500 * frame++) / req.sampleRate)) * 2 ** (req.bits - 16);
      return out;
    },
  });
  be.attachI2s(bus);
  be.load(image ?? new Uint8Array(gunzipSync(readFileSync(`${FIX}esp_audio.${chip}.bin.gz`))));
  const until = (text: string, maxMs: number) => {
    const step = Math.round(be.cyclesPerSecond / 200);
    for (let i = 0; i < maxMs / 5 && !serial.includes(text); i++) be.step(step);
    return serial.includes(text);
  };
  return { be, bus, blocks, until, serial: () => serial };
}

describe.skipIf(!available)("I2S audio on real ESP firmware (ESP_I2S, QEMU jb6)", { timeout: 300_000 }, () => {
  const backends: QemuEspBackend[] = [];
  afterAll(() => backends.forEach((b) => b.close()));

  for (const chip of CHIPS) {
    it(`${chip}: tones, a WAV from flash, 8 to 48 kHz, 32-bit stereo, and a microphone`, () => {
      const s = boot(chip);
      backends.push(s.be);
      expect(s.until("audio done", 15_000), s.serial()).toBe(true);
      const log = s.serial();
      expect(log).toContain("audio begin 1");
      // write() returns every byte, and blocks while the DMA plays them out at 16 kHz: 6400 frames
      // = 400 ms, minus what the 6 x 240-frame DMA ring holds (90 ms).
      const w = log.match(/sine wrote (\d+) in (\d+) ms/)!;
      expect(Number(w[1])).toBe(12800);
      expect(Number(w[2])).toBeGreaterThanOrEqual(300);
      expect(log).toMatch(/rate 8000 wrote 1600 in/);
      expect(log).toMatch(/rate 22050 wrote 4410 in/);
      expect(log).toMatch(/rate 44100 wrote 8820 in/);
      expect(log).toContain("stereo32 wrote 38400");

      const bursts = burstsOf(s.blocks).map((b) => ({ ...b, ...toneOf(b) }));
      const summary = bursts.map((b) => `${b.rate}/${b.bits}/${b.channels} ${b.hz.toFixed(1)} Hz peak ${b.peak} ${b.frames} frames (gaps ${b.gapFrames})`);
      console.log(`${chip}: ${summary.join("; ")}`);
      const expectTone = (i: number, rate: number, bits: number, hz: number, frames: number, peak: number, gap = 0) => {
        const b = bursts[i];
        expect(b, summary.join("\n")).toBeDefined();
        expect(b!.rate).toBe(rate);
        expect(b!.bits).toBe(bits);
        expect(b!.hz).toBeGreaterThan(hz * 0.99);
        expect(b!.hz).toBeLessThan(hz * 1.01);
        expect(Math.abs(b!.frames - gap - frames)).toBeLessThanOrEqual(frames * 0.01 + 2);
        expect(b!.gapFrames).toBeLessThanOrEqual(gap + 3);
        expect(Math.abs(b!.peak - peak)).toBeLessThanOrEqual(peak * 0.01);
      };
      expect(bursts).toHaveLength(6);
      expectTone(0, 16000, 16, 1000, 6400, 16384);
      // The WAV. On the ESP32, arduino-esp32 sends mono as stereo in 128-frame chunks (its HW v1
      // workaround); after the ring ran dry ESP-IDF's i2s_channel_write() takes a fresh DMA buffer for
      // each chunk while its queue is nearly full, so the first buffer plays 128 frames then 112 of
      // silence. That is the driver's behaviour, reproduced, not an emulator gap.
      expectTone(1, 16000, 16, 440, 4000, 16384, chip === "esp32" ? 112 : 0);
      expectTone(2, 8000, 16, 1000, 800, 16384);
      expectTone(3, 22050, 16, 1000, 2205, 16384);
      expectTone(4, 44100, 16, 1000, 4410, 16384);
      expectTone(5, 48000, 32, 1000, 4800, 2 ** 30);
      expect(bursts[5]!.channels).toBe(2);
      expect(bursts[5]!.otherPeak).toBe(0); // right channel silent
      // Mono 16-bit: one sample per frame on the S3 / C3; arduino-esp32 sends mono as two equal
      // slots on the ESP32 (its HW v1 workaround), so both are fine.
      expect([1, 2]).toContain(bursts[0]!.channels);

      // The microphone: what the source on the bus provided, read back by the firmware.
      expect(log).toContain("mic begin 1");
      const m = log.match(/mic got (\d+) rms=(\d+) hz=(\d+)/)!;
      expect(Number(m[1])).toBe(3200);
      expect(Math.abs(Number(m[2]) - 8000 / Math.SQRT2)).toBeLessThan(8000 / Math.SQRT2 * 0.05);
      expect(Math.abs(Number(m[3]) - 500)).toBeLessThanOrEqual(15);
      expect(s.bus.stats.framesIn).toBeGreaterThanOrEqual(3200);
      expect(s.bus.stats.inFormat).toMatchObject({ sampleRate: 16000, bits: 16 });
    });
  }

  // MP3 decoded on the device: ESP_I2S::playMP3() uses libhelix-mp3 (RealNetworks RPSL / RCSL,
  // prebuilt in arduino-esp32 3.x), so no image linking it is committed: built here when a toolchain
  // is ready (Docker image or `fabwright setup esp32`), then run.
  const mp3Build = canBuildArduino("esp32:esp32:esp32s3");
  it.skipIf(!mp3Build.ok)("esp32s3: an MP3 (1 kHz, 16 kHz mono) decoded on the device plays through I2S", async () => {
    const { cpSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const work = mkdtempSync(join(tmpdir(), "fabwright-mp3-"));
    cpSync(`${FIX}esp_mp3`, join(work, "esp_mp3"), { recursive: true });
    const r = await buildFirmware({ sketchDir: join(work, "esp_mp3"), fqbn: "esp32:esp32:esp32s3:FlashMode=dio" });
    rmSync(work, { recursive: true, force: true });
    expect(r.ok, r.logTail).toBe(true);
    const s = boot("esp32s3", flashImageOf(r)!);
    backends.push(s.be);
    expect(s.until("mp3 done", 10_000), s.serial()).toBe(true);
    expect(s.serial()).toMatch(/mp3 played 1 in \d+ ms/);
    const bursts = burstsOf(s.blocks).map((b) => ({ ...b, ...toneOf(b) }));
    console.log(`mp3: ${bursts.map((b) => `${b.rate}/${b.bits}/${b.channels} ${b.hz.toFixed(1)} Hz peak ${b.peak} ${b.frames} frames`).join("; ")}`);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ rate: 16000, bits: 16, channels: 1 });
    // The codec's first frame is its priming (quiet, noisy): measure where the tone is loud.
    const x = bursts[0]!.left;
    const loud = (v: number) => Math.abs(v) > bursts[0]!.peak / 2;
    const a = x.findIndex(loud);
    const z = x.length - 1 - [...x].reverse().findIndex(loud);
    const toneHz = toneOf({ ...bursts[0]!, left: x.slice(a, z + 1) }).hz;
    expect(Math.abs(toneHz - 1000)).toBeLessThan(5);
    // Lossy at 32 kbit/s: near half scale, and about half a second (plus the codec's padding).
    expect(bursts[0]!.peak).toBeGreaterThan(16384 * 0.8);
    expect(bursts[0]!.peak).toBeLessThan(16384 * 1.25);
    expect(bursts[0]!.frames).toBeGreaterThan(7600);
    expect(bursts[0]!.frames).toBeLessThan(9600);
  });
});
