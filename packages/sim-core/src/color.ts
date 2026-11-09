// Colour framebuffers (RGB565 TFT panels such as the ILI9341 and ST7735) for renderers, tests,
// screenshots and agents. A 320x240 frame is 150 KB, far too big for visualState() every frame,
// so display parts expose it through PartModel.framebuffer() and Simulation.framebuffer(partId).
// No DOM, no Buffer, no zlib: the same code runs in Node and the browser.

/** A rectangle of changed pixels, inclusive-exclusive: x0 <= x < x1, y0 <= y < y1. */
export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * What a colour display part shows, in viewer orientation (the way a person looks at the module
 * on the canvas), one RGB565 word per pixel, row-major. `data` is the part's live buffer: read it,
 * never write it.
 */
export interface ColorFrame {
  width: number;
  height: number;
  data: Uint16Array;
  /** Bumped on every visible change (pixels, display on/off, inversion). */
  version: number;
  /** Panel lit (powered, sleep out, display on). A dark panel shows black whatever is in RAM. */
  on: boolean;
  /** Inversion mode (INVON): the glass shows every pixel inverted. */
  inverted: boolean;
}

/**
 * Accumulates dirty rectangles between two renderer reads. Renderers keep one per display and
 * call take() each frame to repaint only what changed.
 */
export class DirtyTracker {
  private r: DirtyRect | null = null;
  add(x0: number, y0: number, x1: number, y1: number): void {
    const r = this.r;
    if (!r) this.r = { x0, y0, x1, y1 };
    else {
      if (x0 < r.x0) r.x0 = x0;
      if (y0 < r.y0) r.y0 = y0;
      if (x1 > r.x1) r.x1 = x1;
      if (y1 > r.y1) r.y1 = y1;
    }
  }
  /** The union of everything added since the last take(), or null. */
  take(): DirtyRect | null {
    const r = this.r;
    this.r = null;
    return r;
  }
}

/** Expand a 5-6-5 word to 8-bit R, G, B (bit replication, as most panels' DACs do). */
export function rgb565ToRgb(c: number): [number, number, number] {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/** The Adafruit_GFX color565(r, g, b) packing. */
export function rgbToRgb565(r: number, g: number, b: number): number {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

/** 32-entry and 64-entry expansion tables, shared by toRgba (hot path in renderers). */
const X5 = new Uint8Array(32).map((_, i) => (i << 3) | (i >> 2));
const X6 = new Uint8Array(64).map((_, i) => (i << 2) | (i >> 4));

/**
 * Write the RGBA bytes of a region of the frame into `out` (row stride `outWidth` pixels), as the
 * glass shows it: black when off, inverted when INVON. Used by the canvas renderer for the dirty
 * rect only, and by screenshots for the whole frame.
 */
export function colorFrameToRgba(
  f: ColorFrame,
  out: Uint8ClampedArray | Uint8Array,
  rect: DirtyRect = { x0: 0, y0: 0, x1: f.width, y1: f.height },
  outWidth = rect.x1 - rect.x0,
): void {
  const inv = f.inverted ? 0xffff : 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    let o = ((y - rect.y0) * outWidth) * 4;
    let i = y * f.width + rect.x0;
    for (let x = rect.x0; x < rect.x1; x++, i++, o += 4) {
      const c = f.on ? (f.data[i]! ^ inv) : 0;
      out[o] = X5[(c >> 11) & 0x1f]!;
      out[o + 1] = X6[(c >> 5) & 0x3f]!;
      out[o + 2] = X5[c & 0x1f]!;
      out[o + 3] = 255;
    }
  }
}

/** Counts for tests and scenario checks: pixels that are not black, and near-white pixels (text boxes, speech bubbles). */
export function colorFrameStats(f: ColorFrame): { lit: number; bright: number } {
  if (!f.on) return { lit: 0, bright: 0 };
  const inv = f.inverted ? 0xffff : 0;
  let lit = 0;
  let bright = 0;
  for (let i = 0; i < f.data.length; i++) {
    const c = f.data[i]! ^ inv;
    if (c !== 0) lit++;
    // R >= 28/31, G >= 56/63, B >= 28/31: near white.
    if (((c >> 11) & 0x1f) >= 28 && ((c >> 5) & 0x3f) >= 56 && (c & 0x1f) >= 28) bright++;
  }
  return { lit, bright };
}

/** Average colour of a region as #RRGGBB (for agents: "what colour is the pet's face?"). */
export function colorFrameAverage(f: ColorFrame, x0: number, y0: number, w: number, h: number): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const inv = f.inverted ? 0xffff : 0;
  for (let y = Math.max(0, y0); y < Math.min(f.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(f.width, x0 + w); x++) {
      const [cr, cg, cb] = rgb565ToRgb(f.on ? f.data[y * f.width + x]! ^ inv : 0);
      r += cr;
      g += cg;
      b += cb;
      n++;
    }
  }
  if (n === 0) return "#000000";
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

// ------------------------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Encode RGBA pixels as a PNG (stored deflate blocks, no compression: about 4 bytes per pixel,
 * plenty for a 320x240 screenshot, and no zlib needed). Deterministic: same pixels, same bytes.
 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  // zlib stream of stored blocks (max 65535 bytes each) + adler32
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  z[o++] = 0x78;
  z[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, raw.length - start);
    z[o++] = i === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff;
    z[o++] = len >> 8;
    z[o++] = ~len & 0xff;
    z[o++] = (~len >> 8) & 0xff;
    z.set(raw.subarray(start, start + len), o);
    o += len;
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]!) % 65521;
    b = (b + a) % 65521;
  }
  z[o++] = (b >> 8) & 0xff;
  z[o++] = b & 0xff;
  z[o++] = (a >> 8) & 0xff;
  z[o++] = a & 0xff;

  const chunks: Uint8Array[] = [];
  const chunk = (type: string, data: Uint8Array) => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
    chunks.push(c);
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  chunk("IHDR", ihdr);
  chunk("IDAT", z.subarray(0, o));
  chunk("IEND", new Uint8Array(0));
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const total = sig.length + chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total);
  png.set(sig, 0);
  let p = sig.length;
  for (const c of chunks) {
    png.set(c, p);
    p += c.length;
  }
  return png;
}

/** The whole frame as a PNG, scaled up by an integer factor (nearest neighbour) for crisp screenshots. */
export function colorFrameToPng(f: ColorFrame, scale = 1): Uint8Array {
  const s = Math.max(1, Math.floor(scale));
  const base = new Uint8Array(f.width * f.height * 4);
  colorFrameToRgba(f, base);
  if (s === 1) return encodePng(base, f.width, f.height);
  const w = f.width * s;
  const h = f.height * s;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / s);
    for (let x = 0; x < w; x++) {
      const si = (sy * f.width + Math.floor(x / s)) * 4;
      const oi = (y * w + x) * 4;
      out[oi] = base[si]!;
      out[oi + 1] = base[si + 1]!;
      out[oi + 2] = base[si + 2]!;
      out[oi + 3] = 255;
    }
  }
  return encodePng(out, w, h);
}
