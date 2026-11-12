// Round 13 (audio): the sound a run played. When an agent or the person runs a board with an I2S
// amplifier in the session (ESP32 boards run there), the run's log entry names a WAV of what the
// firmware sent (GET /api/audio/<file>, mono 16-bit, 16 kHz); the followed page plays it with
// WebAudio in step with the run's frames. Never in automated tests (navigator.webdriver), in a
// hidden tab or when the person muted the page's sound (the same toggle as the speech bubble).
// window.__jumperAudio counts what was asked and played, for tests.
import { speechMuted, subscribeSpeechMuted } from "../voice/speech.ts";
import { followBase } from "./followRun.ts";

export interface RunAudioRef {
  file: string;
  parts: string[];
  /** Virtual time (ms) of the first sample. */
  vt: number;
  ms: number;
  rate: number;
  peak: number;
}

interface AudioStats {
  requested: number;
  played: number;
  silenced: number;
  last?: { file: string; parts: string[]; reason?: string };
}

const stats: AudioStats = { requested: 0, played: 0, silenced: 0 };
let ctx: AudioContext | undefined;
let current: AudioBufferSourceNode | undefined;

function publish(): void {
  try {
    (globalThis as { __jumperAudio?: AudioStats }).__jumperAudio = { ...stats };
  } catch {
    // no global object to write to
  }
}
publish();

/** Why the page will not make a sound now, or undefined when it may. */
export function soundBlocked(): string | undefined {
  try {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return "no WebAudio in this browser";
    if (navigator.webdriver) return "a test drives this page";
    if (document.visibilityState !== "visible") return "the tab is hidden";
    if (speechMuted()) return "sound is muted on this page";
    return undefined;
  } catch {
    return "no WebAudio in this browser";
  }
}

/** The URL of a run recording, on the followed server (or this page's own server). */
export function runAudioUrl(file: string, base = followBase() ?? ""): string {
  return `${base}/api/audio/${encodeURIComponent(file)}`;
}

/**
 * Plays a run's recording, starting where the run's frames start (`fromVt`, virtual ms).
 * Resolves once playback has started (or was skipped, with the reason in __jumperAudio.last).
 */
export async function playRunAudio(a: RunAudioRef, fromVt = a.vt): Promise<void> {
  stats.requested++;
  const blocked = soundBlocked();
  if (blocked) {
    stats.silenced++;
    stats.last = { file: a.file, parts: a.parts, reason: blocked };
    publish();
    return;
  }
  try {
    const r = await fetch(runAudioUrl(a.file), { cache: "no-store" });
    if (!r.ok) throw new Error(`GET /api/audio/${a.file} answered ${r.status}`);
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    current?.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0, Math.max(0, (fromVt - a.vt) / 1000));
    current = src;
    stats.played++;
    stats.last = { file: a.file, parts: a.parts };
  } catch (err) {
    stats.silenced++;
    stats.last = { file: a.file, parts: a.parts, reason: (err as Error).message };
  }
  publish();
}

// Muting the page's sound stops a recording that is playing.
subscribeSpeechMuted(() => {
  if (speechMuted()) stopRunAudio();
});

/** Stop whatever plays (mute, project switch). */
export function stopRunAudio(): void {
  try {
    current?.stop();
  } catch {
    // already stopped
  }
  current = undefined;
}
