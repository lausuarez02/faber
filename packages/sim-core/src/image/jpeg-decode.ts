// Baseline JPEG decoder (Huffman, 8-bit, any sampling factors, restart markers), so a camera test
// image or a dropped-in photo can be a .jpg. Progressive and arithmetic-coded files are refused
// with what to do instead. Output: RGBA.
import { JPEG_ZIGZAG as ZIGZAG } from "./jpeg-encode.ts";

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel. */
  rgba: Uint8Array;
}

interface HuffTable {
  /** (length << 16 | code) → symbol */
  map: Map<number, number>;
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  pred: number;
  bw: number;
  bh: number;
  /** Decoded samples, bw*8 × bh*8. */
  data: Uint8Array;
}

const IDCT_COS = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1);
  return t;
})();

export class ImageFormatError extends Error {}

export function decodeJpeg(bytes: Uint8Array): DecodedImage {
  let p = 0;
  const u16 = () => {
    const v = (bytes[p]! << 8) | bytes[p + 1]!;
    p += 2;
    return v;
  };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImageFormatError("not a JPEG file (no FFD8 start marker)");
  p = 2;
  const qt: Uint16Array[] = [];
  const hts = new Map<number, HuffTable>();
  let comps: Component[] = [];
  let W = 0, H = 0, hmax = 1, vmax = 1, restart = 0;
  let adobeTransform = -1;
  for (;;) {
    if (p >= bytes.length) throw new ImageFormatError("the JPEG file ends before its image data");
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    const m = bytes[p + 1]!;
    p += 2;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) {
      if (m === 0xff) p--;
      continue;
    }
    if (m === 0xd9) break;
    const len = u16();
    const end = p + len - 2;
    switch (m) {
      case 0xdb: {
        while (p < end) {
          const pq = bytes[p]! >> 4, tq = bytes[p]! & 15;
          p++;
          const t = new Uint16Array(64);
          for (let k = 0; k < 64; k++) {
            t[ZIGZAG[k]!] = pq ? u16() : bytes[p++]!;
          }
          qt[tq] = t;
        }
        break;
      }
      case 0xc4: {
        while (p < end) {
          const tc = bytes[p]! >> 4, th = bytes[p]! & 15;
          p++;
          const counts = bytes.subarray(p, p + 16);
          p += 16;
          const map = new Map<number, number>();
          let code = 0;
          for (let l = 1; l <= 16; l++) {
            for (let i = 0; i < counts[l - 1]!; i++) map.set((l << 16) | code++, bytes[p++]!);
            code <<= 1;
          }
          hts.set(tc * 16 + th, { map });
        }
        break;
      }
      case 0xc0:
      case 0xc1: {
        if (bytes[p] !== 8) throw new ImageFormatError(`${bytes[p]}-bit JPEG samples are not supported (8-bit only)`);
        H = (bytes[p + 1]! << 8) | bytes[p + 2]!;
        W = (bytes[p + 3]! << 8) | bytes[p + 4]!;
        const n = bytes[p + 5]!;
        comps = [];
        for (let i = 0; i < n; i++) {
          const o = p + 6 + 3 * i;
          comps.push({ id: bytes[o]!, h: bytes[o + 1]! >> 4, v: bytes[o + 1]! & 15, tq: bytes[o + 2]!, td: 0, ta: 0, pred: 0, bw: 0, bh: 0, data: new Uint8Array(0) });
        }
        break;
      }
      case 0xc2:
      case 0xc6:
      case 0xca:
        throw new ImageFormatError("progressive JPEG is not supported. Fix: save the image as a baseline JPEG or a PNG (most editors: Export, JPEG, uncheck progressive)");
      case 0xc3:
      case 0xc5:
      case 0xc7:
      case 0xc9:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        throw new ImageFormatError("this JPEG uses lossless or arithmetic coding, which is not supported. Fix: save it as a baseline JPEG or a PNG");
      case 0xdd:
        restart = (bytes[p]! << 8) | bytes[p + 1]!;
        break;
      case 0xee:
        if (len >= 12 && String.fromCharCode(...bytes.subarray(p, p + 5)) === "Adobe") adobeTransform = bytes[p + 11]!;
        break;
      case 0xda: {
        if (!W || !H || !comps.length) throw new ImageFormatError("the JPEG has image data before its frame header");
        const ns = bytes[p]!;
        const scomps: Component[] = [];
        for (let i = 0; i < ns; i++) {
          const c = comps.find((x) => x.id === bytes[p + 1 + 2 * i]);
          if (!c) throw new ImageFormatError("the JPEG scan names an unknown component");
          c.td = bytes[p + 2 + 2 * i]! >> 4;
          c.ta = bytes[p + 2 + 2 * i]! & 15;
          scomps.push(c);
        }
        p = end;
        hmax = Math.max(...comps.map((c) => c.h));
        vmax = Math.max(...comps.map((c) => c.v));
        const mcux = Math.ceil(W / (8 * hmax));
        const mcuy = Math.ceil(H / (8 * vmax));
        for (const c of comps) {
          c.bw = mcux * c.h;
          c.bh = mcuy * c.v;
          c.data = new Uint8Array(c.bw * 8 * c.bh * 8);
          c.pred = 0;
        }
        p = decodeScan(bytes, p, scomps, mcux, mcuy, qt, hts, restart, W, H, hmax, vmax);
        continue;
      }
      default:
        break;
    }
    p = end;
  }
  if (!W || !H || !comps.length || !comps[0]!.data.length) throw new ImageFormatError("the JPEG has no image data");
  const rgba = new Uint8Array(W * H * 4);
  const sample = (c: Component, x: number, y: number) => {
    const sx = Math.min(c.bw * 8 - 1, Math.floor((x * c.h) / hmax));
    const sy = Math.min(c.bh * 8 - 1, Math.floor((y * c.v) / vmax));
    return c.data[sy * c.bw * 8 + sx]!;
  };
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = 4 * (y * W + x);
      if (comps.length === 1) {
        const v = sample(comps[0]!, x, y);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      } else {
        const Y = sample(comps[0]!, x, y), cb = sample(comps[1]!, x, y) - 128, cr = sample(comps[2]!, x, y) - 128;
        if (adobeTransform === 0) {
          rgba[o] = Y;
          rgba[o + 1] = cb + 128;
          rgba[o + 2] = cr + 128;
        } else {
          rgba[o] = clamp(Y + 1.402 * cr);
          rgba[o + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr);
          rgba[o + 2] = clamp(Y + 1.772 * cb);
        }
      }
      rgba[o + 3] = 255;
    }
  return { width: W, height: H, rgba };
}

function decodeScan(bytes: Uint8Array, start: number, comps: Component[], mcux: number, mcuy: number, qt: Uint16Array[], hts: Map<number, HuffTable>, restart: number, imgW: number, imgH: number, hmax: number, vmax: number): number {
  let p = start;
  let acc = 0;
  let nbits = 0;
  let hitMarker = false;
  const bit = (): number => {
    if (nbits === 0) {
      if (hitMarker || p >= bytes.length) return 0;
      const b = bytes[p]!;
      if (b === 0xff) {
        const nx = bytes[p + 1]!;
        if (nx === 0) p += 2;
        else {
          hitMarker = true;
          return 0;
        }
      } else p++;
      acc = b;
      nbits = 8;
    }
    nbits--;
    return (acc >> nbits) & 1;
  };
  const bits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bit();
    return v;
  };
  const decodeHuff = (t: HuffTable | undefined): number => {
    if (!t) throw new ImageFormatError("the JPEG uses a Huffman table it never defines");
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | bit();
      const s = t.map.get((l << 16) | code);
      if (s !== undefined) return s;
    }
    throw new ImageFormatError("the JPEG data is corrupt (bad Huffman code)");
  };
  const extend = (v: number, n: number) => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const coef = new Float64Array(64);
  const tmp = new Float64Array(64);
  const decodeBlock = (c: Component, bx: number, by: number) => {
    coef.fill(0);
    const q = qt[c.tq];
    if (!q) throw new ImageFormatError("the JPEG uses a quantization table it never defines");
    const t = decodeHuff(hts.get(c.td));
    c.pred += t ? extend(bits(t), t) : 0;
    coef[0] = c.pred * q[0]!;
    for (let k = 1; k < 64; ) {
      const rs = decodeHuff(hts.get(16 + c.ta));
      const r = rs >> 4, s = rs & 15;
      if (s === 0) {
        if (r === 15) {
          k += 16;
          continue;
        }
        break;
      }
      k += r;
      if (k > 63) break;
      const nat = ZIGZAG[k]!;
      coef[nat] = extend(bits(s), s) * q[nat]!;
      k++;
    }
    // inverse DCT
    for (let v = 0; v < 8; v++)
      for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let u = 0; u < 8; u++) s += coef[v * 8 + u]! * IDCT_COS[x * 8 + u]!;
        tmp[v * 8 + x] = s / 2;
      }
    const stride = c.bw * 8;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let v = 0; v < 8; v++) s += tmp[v * 8 + x]! * IDCT_COS[y * 8 + v]!;
        const val = Math.round(s / 2 + 128);
        c.data[(by * 8 + y) * stride + bx * 8 + x] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
  };
  const single = comps.length === 1;
  let n = 0;
  const resync = () => {
    nbits = 0;
    hitMarker = false;
    // skip to and past the RSTn marker
    while (p < bytes.length - 1 && !(bytes[p] === 0xff && bytes[p + 1]! >= 0xd0 && bytes[p + 1]! <= 0xd7)) p++;
    if (p < bytes.length - 1) p += 2;
    for (const c of comps) c.pred = 0;
  };
  if (single) {
    // A non-interleaved scan walks the component's own blocks (only the ones inside the image).
    const c = comps[0]!;
    const blocksX = Math.ceil((imgW * c.h) / hmax / 8);
    const blocksY = Math.ceil((imgH * c.v) / vmax / 8);
    for (let by = 0; by < blocksY; by++)
      for (let bx = 0; bx < blocksX; bx++) {
        if (restart && n > 0 && n % restart === 0) resync();
        decodeBlock(c, bx, by);
        n++;
      }
  } else {
    for (let my = 0; my < mcuy; my++)
      for (let mx = 0; mx < mcux; mx++) {
        if (restart && n > 0 && n % restart === 0) resync();
        for (const c of comps) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, mx * c.h + h, my * c.v + v);
        n++;
      }
  }
  // Leave p at the next marker.
  while (p < bytes.length - 1 && !(bytes[p] === 0xff && bytes[p + 1] !== 0 && !(bytes[p + 1]! >= 0xd0 && bytes[p + 1]! <= 0xd7))) p++;
  return p;
}
