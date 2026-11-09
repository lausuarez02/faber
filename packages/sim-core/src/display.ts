// Compact frame formats that display parts put in visualState(), plus decoders for renderers,
// tests and agents. No DOM, no Buffer: works the same in Node and the browser.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INDEX[clean.charCodeAt(i) & 127] ?? -1;
    if (v < 0) throw new Error(`base64ToBytes: invalid character '${clean[i]}' at ${i}; expected standard base64 (A-Z a-z 0-9 + /)`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/**
 * A monochrome frame, 1 bit per pixel, row-major, MSB = leftmost pixel, rows padded to whole
 * bytes. This is the `pixels` format of display parts (base64 in visualState).
 */
export interface MonoFrame {
  width: number;
  height: number;
  /** ceil(width / 8) * height bytes. */
  data: Uint8Array;
}

export function monoStride(width: number): number {
  return (width + 7) >> 3;
}

export function decodeMonoFrame(b64: string, width: number, height: number): MonoFrame {
  const data = base64ToBytes(b64);
  const need = monoStride(width) * height;
  if (data.length < need) {
    throw new Error(`decodeMonoFrame: got ${data.length} bytes, a ${width}x${height} 1-bit frame needs ${need}. Pass the width/height the display part reports (visualState width/height).`);
  }
  return { width, height, data };
}

export function monoPixel(f: MonoFrame, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= f.width || y >= f.height) return false;
  return ((f.data[y * monoStride(f.width) + (x >> 3)]! >> (7 - (x & 7))) & 1) === 1;
}

/** Count of lit pixels (a cheap "is anything on screen" check for tests). */
export function monoLitCount(f: MonoFrame): number {
  let n = 0;
  for (const b of f.data) {
    let v = b;
    while (v) {
      n += v & 1;
      v >>= 1;
    }
  }
  return n;
}

/**
 * ASCII art of a frame, for agents and test logs. Each character covers `scale` x `scale`
 * pixels (`#` when any is lit, `.` otherwise). scale 1 = exact; 2 halves a 128x64 OLED to 64x32.
 */
export function monoToAscii(f: MonoFrame, scale = 1): string {
  const s = Math.max(1, Math.floor(scale));
  const lines: string[] = [];
  for (let y = 0; y < f.height; y += s) {
    let line = "";
    for (let x = 0; x < f.width; x += s) {
      let on = false;
      for (let dy = 0; dy < s && !on; dy++) for (let dx = 0; dx < s && !on; dx++) on = monoPixel(f, x + dx, y + dy);
      line += on ? "#" : ".";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
