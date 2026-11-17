/**
 * Round 13 (audio): what the board played over I2S during one `run`, kept as a WAV so the page can
 * play it in step with the run's frames (WebAudio, muted under test drivers). Generic: whatever the
 * firmware sent to whatever I2S sink is wired (an amplifier); nothing here knows what the sound is.
 *
 * The WAV is mono 16-bit at 16 kHz: each block the bus carried is placed at its virtual time
 * (silence where nothing played), channel 0 taken (the left slot, what a mono amplifier plays by
 * default), resampled linearly to 16 kHz and scaled from its bit depth to 16 bits. The amplifier's
 * gain and channel select are not applied (its `level` state shows them).
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { I2sBlock, Simulation } from "@fabwright/sim-core";
import { stateDirPath } from "@fabwright/project-format/node";

export const RUN_AUDIO_RATE = 16_000;
/** Runs longer than this keep no audio (the page plays at most 10 s of a run at real speed). */
export const RUN_AUDIO_MAX_MS = 20_000;
/** WAV files kept in .fabwright/audio (the oldest go). */
const KEEP = 20;

/** What the log entry of a run carries so the page can play its sound. */
export interface RunAudio {
  /** File name under .fabwright/audio, served at GET /api/audio/<file>. */
  file: string;
  /** The I2S sink(s) the sound went to (the amplifier part ids). */
  parts: string[];
  /** Virtual time (ms) of the WAV's first sample: the run's start. */
  vt: number;
  ms: number;
  rate: number;
  /** Peak of the recording, 0..1 of full scale. */
  peak: number;
}

/** Records the I2S blocks of one run (with their virtual start time). `stop()` returns them. */
export function recordI2s(sim: Simulation, t0Ms: number): { stop(): { blocks: { ms: number; block: I2sBlock }[]; t0: number } } {
  const blocks: { ms: number; block: I2sBlock }[] = [];
  const mcu = sim.mcu;
  const cps = mcu?.cyclesPerSecond ?? 0;
  // A block's cycle is the backend's; the simulation's clock may be offset from it (after a reset).
  const off = sim.i2s.onBlock((block) => blocks.push({ ms: mcu && cps > 0 ? ((block.cycle + (sim.cycles - mcu.cycles)) / cps) * 1000 : sim.timeMs, block }));
  return {
    stop() {
      off();
      return { blocks, t0: t0Ms };
    },
  };
}

/** Mono 16-bit samples at RUN_AUDIO_RATE for [t0, t0 + ms), or undefined when everything was silent. */
export function mixRunAudio(blocks: readonly { ms: number; block: I2sBlock }[], t0: number, ms: number): { pcm: Int16Array; peak: number } | undefined {
  const n = Math.max(0, Math.round((ms * RUN_AUDIO_RATE) / 1000));
  if (!n || !blocks.length) return undefined;
  const pcm = new Int16Array(n);
  let peak = 0;
  for (const { ms: at, block } of blocks) {
    const ch = Math.max(1, block.channels);
    const frames = Math.floor(block.samples.length / ch);
    if (!frames || block.sampleRate <= 0) continue;
    const scale = 2 ** (16 - block.bits);
    const start = ((at - t0) * RUN_AUDIO_RATE) / 1000;
    const outFrames = Math.floor((frames * RUN_AUDIO_RATE) / block.sampleRate);
    for (let j = 0; j < outFrames; j++) {
      const i = Math.round(start) + j;
      if (i < 0 || i >= n) continue;
      const src = (j * block.sampleRate) / RUN_AUDIO_RATE;
      const k = Math.floor(src);
      const f = src - k;
      const a = block.samples[k * ch]!;
      const b = k + 1 < frames ? block.samples[(k + 1) * ch]! : a;
      const v = Math.max(-32768, Math.min(32767, Math.round((a + (b - a) * f) * scale)));
      pcm[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  return peak > 0 ? { pcm, peak: peak / 32768 } : undefined;
}

export function wavBytes(pcm: Int16Array, rate = RUN_AUDIO_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** The folder run audio lives in. */
export const runAudioDir = (projectDir: string) => join(stateDirPath(projectDir), "audio");

/** A safe file name from GET /api/audio/<file> (no paths), or undefined. */
export function runAudioFile(projectDir: string, name: string): string | undefined {
  return /^run-\d+\.wav$/.test(name) ? join(runAudioDir(projectDir), name) : undefined;
}

/** Writes the run's WAV (when anything played) and keeps the folder small. */
export function saveRunAudio(projectDir: string, seq: number, rec: { blocks: { ms: number; block: I2sBlock }[]; t0: number }, ms: number, parts: string[]): RunAudio | undefined {
  if (ms > RUN_AUDIO_MAX_MS) return undefined;
  const mix = mixRunAudio(rec.blocks, rec.t0, ms);
  if (!mix) return undefined;
  const dir = runAudioDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const file = `run-${seq}.wav`;
  writeFileSync(join(dir, file), wavBytes(mix.pcm));
  try {
    const old = readdirSync(dir)
      .filter((f) => /^run-\d+\.wav$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(KEEP);
    for (const o of old) rmSync(join(dir, o.f), { force: true });
  } catch {
    // a file went away meanwhile: nothing to trim
  }
  return { file, parts, vt: Math.round(rec.t0 * 1000) / 1000, ms: Math.round(ms * 1000) / 1000, rate: RUN_AUDIO_RATE, peak: Math.round(mix.peak * 1000) / 1000 };
}
