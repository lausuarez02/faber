// Round 6, frames track (decision 0004, R7): colour TFT / round screens as PNGs inside run and test
// frames (`Frame.color`), so every picture that is not the live canvas (record videos, history
// previews, gallery thumbnails, Tests filmstrips) can show the real pixels instead of a dark glass.
//
// A colour frame is the panel's full native resolution (240x240 for the GC9A01, 320x240 for the
// ILI9341), RGB, deflate-compressed: a typical UI face is 2 to 10 KB. They are only added for parts
// whose screen changed, at most every COLOR_EVERY_MS of virtual time while a run is going, and
// limitColorFrames thins a long run so one log entry stays around a megabyte at most.
import { deflateSync } from "node:zlib";
import { colorFrameToRgba, type ColorFrame } from "@jumper/sim-core";
import type { ColorFrameImage, Frame } from "./sim.ts";

/** Smallest virtual-time gap between two colour images of one part during a run's periodic frames. */
export const COLOR_EVERY_MS = 100;
/** Most colour images one run / run_tests log entry keeps (the last one of each part always stays). */
export const COLOR_MAX_IMAGES = 120;
/** Most base64 bytes of colour images in one log entry (the last one of each part always stays). */
export const COLOR_MAX_BYTES = 1_500_000;

/** What the glass shows (power, inversion applied) as an RGB PNG, base64 without a data: prefix. */
export function colorFrameImage(f: ColorFrame): ColorFrameImage {
  const rgba = new Uint8Array(f.width * f.height * 4);
  colorFrameToRgba(f, rgba);
  const stride = f.width * 3 + 1;
  const raw = Buffer.alloc(stride * f.height);
  for (let y = 0; y < f.height; y++) {
    // Filter "sub" (1): flat UI colours compress to almost nothing.
    const row = y * stride;
    raw[row] = 1;
    for (let x = 0; x < f.width; x++) {
      const s = (y * f.width + x) * 4;
      const o = row + 1 + x * 3;
      if (x === 0) {
        raw[o] = rgba[s]!;
        raw[o + 1] = rgba[s + 1]!;
        raw[o + 2] = rgba[s + 2]!;
      } else {
        raw[o] = (rgba[s]! - rgba[s - 4]!) & 0xff;
        raw[o + 1] = (rgba[s + 1]! - rgba[s - 3]!) & 0xff;
        raw[o + 2] = (rgba[s + 2]! - rgba[s - 2]!) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(f.width, 0);
  ihdr.writeUInt32BE(f.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  return { w: f.width, h: f.height, png: png.toString("base64") };
}

/** A signature that changes whenever what the glass shows changes. */
export function colorSig(f: ColorFrame): string {
  return `${f.version}:${f.on ? 1 : 0}:${f.inverted ? 1 : 0}`;
}

/**
 * Thin the colour images of a run's frames to at most `maxImages` and `maxBytes`, evenly over the
 * run; the last image of each part always stays, so the end of the run (history previews, the
 * gallery thumbnail, the last video frame) shows the real last screen. Frames are not removed, only
 * their `color` entries. Returns the same array (mutated) for convenience.
 */
export function limitColorFrames(frames: Frame[], maxImages = COLOR_MAX_IMAGES, maxBytes = COLOR_MAX_BYTES): Frame[] {
  let total = 0;
  let bytes = 0;
  const lastIdx = new Map<string, number>();
  frames.forEach((f, i) => {
    for (const [id, img] of Object.entries(f.color ?? {})) {
      total++;
      bytes += img.png.length;
      lastIdx.set(id, i);
    }
  });
  if (total <= maxImages && bytes <= maxBytes) return frames;
  const span = frames.length ? Math.max(1, frames[frames.length - 1]!.vt - frames[0]!.vt) : 1;
  const parts = Math.max(1, lastIdx.size);
  const avg = bytes / Math.max(1, total);
  const budget = Math.max(parts, Math.min(maxImages, Math.floor(maxBytes / Math.max(1, avg))));
  const gap = (span * parts) / budget;
  const keptAt = new Map<string, number>();
  let used = 0;
  frames.forEach((f, i) => {
    if (!f.color) return;
    for (const id of Object.keys(f.color)) {
      const last = lastIdx.get(id) === i;
      const prev = keptAt.get(id);
      const size = f.color[id]!.png.length;
      if (last || ((prev === undefined || f.vt - prev >= gap) && used + size <= maxBytes)) {
        keptAt.set(id, f.vt);
        used += size;
      } else delete f.color[id];
    }
    if (!Object.keys(f.color).length) delete f.color;
  });
  return frames;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Buffer): Buffer {
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (let i = 0; i < td.length; i++) c = CRC_TABLE[(c ^ td[i]!) & 0xff]! ^ (c >>> 8);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}
