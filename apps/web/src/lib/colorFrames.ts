// Round 6, frames track (decision 0004, R7): colour TFT / round screens for views that have no
// simulation of their own (an agent's run followed live, a replay, the video `record` makes, the
// history). The session logs each changed screen as a PNG in the run's frames (`Frame.color`); this
// module decodes them (synchronously, so a frame's pixels and its part states land together) into
// ColorFrames the TFT renderers paint like a live one, and keeps the latest one per part.
//
// Cached frames belong to the open project: a project switch clears them (R8).
import { unzlibSync } from "fflate";
import type { ColorFrame } from "@fabwright/sim-core";
import { onProjectSwitch } from "./projectSwitch.ts";

/** A logged colour screen: native size, PNG as base64 without a data: prefix (ColorFrameImage in @fabwright/session). */
export interface ColorFrameImage {
  w: number;
  h: number;
  png: string;
}

const frames = new Map<string, ColorFrame>();
let version = 0;

/** The latest logged colour frame of a part, or undefined (then the screen shows dark). */
export function colorFrameOf(partId: string): ColorFrame | undefined {
  return frames.get(partId);
}

/** Store the colour images of one frame (part id → PNG). Images that do not decode are skipped. */
export function setColorFrames(color: Record<string, ColorFrameImage> | undefined): void {
  if (!color) return;
  for (const [id, img] of Object.entries(color)) {
    try {
      frames.set(id, { ...decodePngTo565(base64ToBytes(img.png)), version: ++version, on: true, inverted: false });
    } catch (e) {
      console.warn(`colour frame of ${id} could not be decoded`, e);
    }
  }
}

/** The latest colour image of each part over a run's frames (one decode per part), e.g. when a follower joins. */
export function setLastColorFrames(list: readonly { color?: Record<string, ColorFrameImage> }[] | undefined): void {
  let merged: Record<string, ColorFrameImage> | undefined;
  for (const f of list ?? []) if (f.color) merged = { ...merged, ...f.color };
  setColorFrames(merged);
}

/** Forget every cached frame (a new project, a restart of the replay). */
export function clearColorFrames(): void {
  frames.clear();
}

/** Whether a set of frames (VersionFrame, Frame) has a colour image for any part. */
export function hasColorFrames(f: object | undefined): boolean {
  const color = (f as { color?: unknown } | undefined)?.color;
  return !!color && typeof color === "object" && Object.keys(color).length > 0;
}

onProjectSwitch(() => clearColorFrames());

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decode an 8-bit RGB or RGBA, non-interlaced PNG (what the session writes, and what most encoders
 * write for a screen) into RGB565 words, row-major. Throws on anything else.
 */
export function decodePngTo565(png: Uint8Array): { width: number; height: number; data: Uint16Array } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      const depth = body[8];
      const ctype = body[9];
      if (depth !== 8 || (ctype !== 2 && ctype !== 6) || body[12] !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${ctype}, interlace ${body[12]})`);
      channels = ctype === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!width || !height || !idat.length) throw new Error("PNG without image data");
  const zlib = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) {
    zlib.set(c, o);
    o += c.length;
  }
  const raw = unzlibSync(zlib);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is short");
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  const data = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i]!;
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      row[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      data[y * width + x] = ((row[s]! & 0xf8) << 8) | ((row[s + 1]! & 0xfc) << 3) | (row[s + 2]! >> 3);
    }
    prev.set(row);
  }
  return { width, height, data };
}
