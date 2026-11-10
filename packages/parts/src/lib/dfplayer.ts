// DFPlayer Mini serial protocol and the clip table (round 7, voice).
//
// The module listens at 9600 baud 8N1 for 10-byte frames:
//   0x7E 0xFF 0x06 CMD FEEDBACK PARAM_H PARAM_L CHK_H CHK_L 0xEF
// CHK = 0 - (0xFF + 0x06 + CMD + FEEDBACK + PARAM_H + PARAM_L), as 16 bits. Many sketches leave the
// checksum out (8 bytes: ... PARAM_L 0xEF); the module accepts both, and so does this decoder.
// Replies use the same frame (FEEDBACK 0). Written from the public DFPlayer Mini manual's tables;
// no third-party code.
//
// What it says: the clips are TEXT. A clip table maps track numbers to words, as lines
// "1: hi! I'm Eggy" (or a JSON object {"1": "hi! I'm Eggy"}); "2/5: ..." is folder 2 track 5.

export const DF = {
  START: 0x7e,
  VERSION: 0xff,
  LEN: 0x06,
  END: 0xef,
  // commands (MCU → module)
  NEXT: 0x01,
  PREV: 0x02,
  PLAY_TRACK: 0x03,
  VOL_UP: 0x04,
  VOL_DOWN: 0x05,
  VOLUME: 0x06,
  EQ: 0x07,
  LOOP_TRACK: 0x08,
  SOURCE: 0x09,
  SLEEP: 0x0a,
  RESET: 0x0c,
  RESUME: 0x0d,
  PAUSE: 0x0e,
  PLAY_FOLDER: 0x0f,
  PLAY_MP3: 0x12,
  ADVERT: 0x13,
  STOP: 0x16,
  // replies (module → MCU)
  TRACK_DONE: 0x3d,
  ONLINE: 0x3f,
  ERROR: 0x40,
  ACK: 0x41,
  Q_STATUS: 0x42,
  Q_VOLUME: 0x43,
  Q_EQ: 0x44,
  Q_FILES: 0x48,
  Q_TRACK: 0x4c,
} as const;

/** Human names for the commands the decoder knows (for warnings and the inspector). */
export const DF_COMMAND_NAMES: Record<number, string> = {
  0x01: "next",
  0x02: "previous",
  0x03: "play track",
  0x04: "volume up",
  0x05: "volume down",
  0x06: "set volume",
  0x07: "set EQ",
  0x08: "loop track",
  0x09: "set source",
  0x0a: "sleep",
  0x0c: "reset",
  0x0d: "play / resume",
  0x0e: "pause",
  0x0f: "play folder track",
  0x12: "play mp3 folder track",
  0x13: "advert",
  0x16: "stop",
  0x42: "query status",
  0x43: "query volume",
  0x44: "query EQ",
  0x48: "query file count",
  0x4c: "query current track",
};

/** 16-bit checksum over VERSION, LEN, CMD, FEEDBACK, PARAM_H, PARAM_L. */
export function dfChecksum(cmd: number, feedback: number, param: number): number {
  const sum = DF.VERSION + DF.LEN + (cmd & 0xff) + (feedback & 0xff) + ((param >> 8) & 0xff) + (param & 0xff);
  return (0x10000 - sum) & 0xffff;
}

/** The 10 bytes of a frame. */
export function dfFrame(cmd: number, param = 0, feedback = 0): number[] {
  const chk = dfChecksum(cmd, feedback, param);
  return [DF.START, DF.VERSION, DF.LEN, cmd & 0xff, feedback ? 1 : 0, (param >> 8) & 0xff, param & 0xff, (chk >> 8) & 0xff, chk & 0xff, DF.END];
}

export interface DfCommand {
  cmd: number;
  feedback: boolean;
  param: number;
  /** False for the 8-byte form without a checksum. */
  checksum: boolean;
}

export type DfDecoded = { ok: true; frame: DfCommand } | { ok: false; error: string };

/**
 * Collects bytes into frames. Feed every received byte; it returns a decoded command when a frame
 * ends, an error for a malformed one (bad length / version / checksum / end byte), else undefined.
 * Bytes before a 0x7E are noise and are skipped (counted in `skipped`).
 */
export class DfFrameDecoder {
  private buf: number[] = [];
  skipped = 0;

  push(b: number): DfDecoded | undefined {
    const byte = b & 0xff;
    if (this.buf.length === 0) {
      if (byte !== DF.START) {
        this.skipped++;
        return undefined;
      }
      this.buf.push(byte);
      return undefined;
    }
    this.buf.push(byte);
    const n = this.buf.length;
    if (n === 2 && byte !== DF.VERSION) return this.fail(`byte 2 is 0x${hex(byte)}, expected 0xFF (version)`);
    if (n === 3 && byte !== DF.LEN) return this.fail(`byte 3 is 0x${hex(byte)}, expected 0x06 (length)`);
    if (n === 8 && byte === DF.END) {
      // 8-byte form: 7E FF 06 CMD FB PH PL EF (no checksum).
      const [, , , cmd, fb, ph, pl] = this.buf as [number, number, number, number, number, number, number];
      this.buf = [];
      return { ok: true, frame: { cmd, feedback: fb === 1, param: (ph << 8) | pl, checksum: false } };
    }
    if (n < 10) return undefined;
    const [, , , cmd, fb, ph, pl, ch, cl, end] = this.buf as [number, number, number, number, number, number, number, number, number, number];
    this.buf = [];
    if (end !== DF.END) return { ok: false, error: `frame for command 0x${hex(cmd)} ends with 0x${hex(end)}, expected 0xEF` };
    const want = dfChecksum(cmd, fb, (ph << 8) | pl);
    const got = (ch << 8) | cl;
    if (want !== got) return { ok: false, error: `checksum of command 0x${hex(cmd)} is 0x${hex(got, 4)}, expected 0x${hex(want, 4)}` };
    return { ok: true, frame: { cmd, feedback: fb === 1, param: (ph << 8) | pl, checksum: true } };
  }

  reset(): void {
    this.buf = [];
  }

  private fail(error: string): DfDecoded {
    this.buf = [];
    return { ok: false, error };
  }
}

export const hex = (n: number, digits = 2) => n.toString(16).toUpperCase().padStart(digits, "0");

// ------------------------------------------------------------------------------- clip table

/** Clip key for a plain track ("7") or a folder play ("2/5"). */
export const clipKey = (track: number, folder?: number) => (folder === undefined ? String(track) : `${folder}/${track}`);

/** Normalise "02/005" → "2/5", "0007" → "7"; undefined when it is not a key. */
export function normalizeClipKey(k: string): string | undefined {
  const m = /^\s*0*(\d{1,4})(?:\s*\/\s*0*(\d{1,4}))?\s*$/.exec(k);
  if (!m) return undefined;
  return m[2] !== undefined ? `${Number(m[1])}/${Number(m[2])}` : String(Number(m[1]));
}

/**
 * Parse a clip table: lines "1: hi! I'm Eggy" ("=" works too, "#" starts a comment line), or a
 * JSON object {"1": "hi!"}. Returns the table plus problems (lines that are not "N: words").
 */
export function parseClips(text: string | unknown): { clips: Map<string, string>; problems: string[] } {
  const clips = new Map<string, string>();
  const problems: string[] = [];
  if (text !== null && typeof text === "object") {
    for (const [k, v] of Object.entries(text as Record<string, unknown>)) {
      const key = normalizeClipKey(k);
      if (!key) problems.push(`"${k}" is not a track number`);
      else clips.set(key, String(v ?? "").trim());
    }
    return { clips, problems };
  }
  const s = String(text ?? "").trim();
  if (s.startsWith("{")) {
    try {
      return parseClips(JSON.parse(s) as unknown);
    } catch {
      problems.push("starts with { but is not valid JSON");
      return { clips, problems };
    }
  }
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([0-9/\s]+?)\s*[:=]\s*(.*)$/.exec(line);
    const key = m ? normalizeClipKey(m[1]!) : undefined;
    if (!m || !key) {
      problems.push(`"${line.slice(0, 40)}" is not "N: words"`);
      continue;
    }
    clips.set(key, m[2]!.trim());
  }
  return { clips, problems };
}

/** The canonical text of a table: one "N: words" line per clip, in track order. */
export function formatClips(clips: Map<string, string> | Record<string, string>): string {
  const entries = clips instanceof Map ? [...clips.entries()] : Object.entries(clips);
  const order = (k: string) => k.split("/").map(Number).reduce((a, b) => a * 10_000 + b, 0) + (k.includes("/") ? 1e9 : 0);
  return entries
    .map(([k, v]) => [normalizeClipKey(k) ?? k, v] as const)
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([k, v]) => `${k}: ${v.replace(/\s*\n\s*/g, " ")}`)
    .join("\n");
}

/** Spoken words per second used to estimate a clip's length (a calm TTS voice). */
export const WORDS_PER_SECOND = 2.6;
/** Silence the module adds around a clip (decode start + MP3 padding). */
export const CLIP_PAD_MS = 300;

/** Estimated playback length of a clip's words: words / 2.6 per second + 0.3 s. */
export function estimateClipMs(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.round((words / WORDS_PER_SECOND) * 1000 + CLIP_PAD_MS);
}
