// Baseline JPEG encoder (JFIF, Huffman, the standard tables of ITU-T T.81 Annex K), written for
// Jumper's camera frames. Colour images are 4:2:2 (Y sampled 2 x 1, like the OV2640's own JPEG
// output), grayscale images one component. Deterministic: same pixels and quality, same bytes.
// Quality 1..100 scales the Annex K tables the way the IJG library does.

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23,
  30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);
export { ZIGZAG as JPEG_ZIGZAG };

const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55,
  64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

// Annex K.3 Huffman tables: code counts per length 1..16, then the symbols.
const DC_L_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_L_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_C_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_C_VALS = DC_L_VALS;
const AC_L_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_L_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1,
  0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
  0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_C_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09,
  0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
  0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
  0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

interface Huff {
  code: Uint16Array;
  len: Uint8Array;
}

function buildHuff(bits: number[], vals: number[]): Huff {
  const code = new Uint16Array(256);
  const len = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]!; i++) {
      code[vals[k]!] = c;
      len[vals[k]!] = l;
      c++;
      k++;
    }
    c <<= 1;
  }
  return { code, len };
}

const H_DC_L = buildHuff(DC_L_BITS, DC_L_VALS);
const H_DC_C = buildHuff(DC_C_BITS, DC_C_VALS);
const H_AC_L = buildHuff(AC_L_BITS, AC_L_VALS);
const H_AC_C = buildHuff(AC_C_BITS, AC_C_VALS);

/** IJG quality scaling of a base table (natural order), clamped to 1..255. */
export function scaledQuantTable(base: readonly number[], quality: number): Uint8Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = Math.max(1, Math.min(255, Math.floor((base[i]! * scale + 50) / 100)));
  return out;
}

const COS = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1);
  return t;
})();

/** Forward 8x8 DCT (separable, exact) of level-shifted samples, then quantization; result in zigzag order. */
function fdctQuant(block: Float64Array, q: Uint8Array, out: Int32Array, tmp: Float64Array): void {
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x]! * COS[x * 8 + u]!;
      tmp[y * 8 + u] = s / 2;
    }
  for (let u = 0; u < 8; u++)
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u]! * COS[y * 8 + v]!;
      const nat = v * 8 + u;
      out[nat] = Math.round(s / 2 / q[nat]!);
    }
}

class BitWriter {
  private buf: Uint8Array;
  private n = 0;
  private acc = 0;
  private bits = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(1024, size));
  }
  private byte(b: number): void {
    if (this.n + 2 > this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = b;
  }
  raw(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.byte(bytes[i]!);
  }
  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.bits === 8) {
        this.byte(this.acc);
        if (this.acc === 0xff) this.byte(0);
        this.acc = 0;
        this.bits = 0;
      }
    }
  }
  flush(): void {
    if (this.bits > 0) this.put((1 << (8 - this.bits)) - 1, 8 - this.bits);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

function category(v: number): number {
  let a = v < 0 ? -v : v;
  let n = 0;
  while (a) {
    n++;
    a >>= 1;
  }
  return n;
}

function writeBlock(w: BitWriter, coef: Int32Array, prevDc: number, dc: Huff, ac: Huff): number {
  const d = coef[0]! - prevDc;
  const c = category(d);
  w.put(dc.code[c]!, dc.len[c]!);
  if (c) w.put(d < 0 ? d + (1 << c) - 1 : d, c);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = coef[ZIGZAG[k]!]!;
    if (v === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      w.put(ac.code[0xf0]!, ac.len[0xf0]!);
      run -= 16;
    }
    const s = category(v);
    const sym = (run << 4) | s;
    w.put(ac.code[sym]!, ac.len[sym]!);
    w.put(v < 0 ? v + (1 << s) - 1 : v, s);
    run = 0;
  }
  if (run > 0) w.put(ac.code[0]!, ac.len[0]!);
  return coef[0]!;
}

export interface JpegInput {
  width: number;
  height: number;
  /** RGBA (4 bytes a pixel) or, with gray, 1 byte a pixel. */
  pixels: Uint8Array;
  gray?: boolean;
}

/** Encodes pixels as a baseline JPEG at `quality` 1..100. */
export function encodeJpeg(img: JpegInput, quality = 80): Uint8Array {
  const { width: W, height: H } = img;
  const gray = !!img.gray;
  const ql = scaledQuantTable(LUMA_Q, quality);
  const qc = scaledQuantTable(CHROMA_Q, quality);
  const w = new BitWriter(W * H);
  // SOI + JFIF APP0
  w.raw([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dqt = (id: number, t: Uint8Array) => {
    w.raw([0xff, 0xdb, 0, 67, id]);
    for (let k = 0; k < 64; k++) w.raw([t[ZIGZAG[k]!]!]);
  };
  dqt(0, ql);
  if (!gray) dqt(1, qc);
  // SOF0
  const nc = gray ? 1 : 3;
  w.raw([0xff, 0xc0, 0, 8 + 3 * nc, 8, H >> 8, H & 0xff, W >> 8, W & 0xff, nc]);
  if (gray) w.raw([1, 0x11, 0]);
  else w.raw([1, 0x21, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht = (cls: number, id: number, bits: number[], vals: number[]) => {
    w.raw([0xff, 0xc4, 0, 3 + 16 + vals.length, (cls << 4) | id, ...bits, ...vals]);
  };
  dht(0, 0, DC_L_BITS, DC_L_VALS);
  dht(1, 0, AC_L_BITS, AC_L_VALS);
  if (!gray) {
    dht(0, 1, DC_C_BITS, DC_C_VALS);
    dht(1, 1, AC_C_BITS, AC_C_VALS);
  }
  // SOS
  if (gray) w.raw([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
  else w.raw([0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);

  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coef = new Int32Array(64);
  const px = img.pixels;
  const clampX = (x: number) => (x < W ? x : W - 1);
  const clampY = (y: number) => (y < H ? y : H - 1);
  const lum = (x: number, y: number): number => {
    const i = clampY(y) * W + clampX(x);
    if (gray) return px[i]!;
    const r = px[4 * i]!, g = px[4 * i + 1]!, b = px[4 * i + 2]!;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  let dcY = 0, dcCb = 0, dcCr = 0;
  if (gray) {
    for (let by = 0; by < H; by += 8)
      for (let bx = 0; bx < W; bx += 8) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = lum(bx + x, by + y) - 128;
        fdctQuant(block, ql, coef, tmp);
        dcY = writeBlock(w, coef, dcY, H_DC_L, H_AC_L);
      }
  } else {
    for (let by = 0; by < H; by += 8)
      for (let bx = 0; bx < W; bx += 16) {
        for (let half = 0; half < 2; half++) {
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = lum(bx + half * 8 + x, by + y) - 128;
          fdctQuant(block, ql, coef, tmp);
          dcY = writeBlock(w, coef, dcY, H_DC_L, H_AC_L);
        }
        // chroma: the mean of each horizontal pair (16 x 8 → 8 x 8)
        const cb = new Float64Array(64);
        const cr = new Float64Array(64);
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            let sb = 0, sr = 0;
            for (let k = 0; k < 2; k++) {
              const i = clampY(by + y) * W + clampX(bx + 2 * x + k);
              const r = px[4 * i]!, g = px[4 * i + 1]!, b = px[4 * i + 2]!;
              sb += -0.168736 * r - 0.331264 * g + 0.5 * b;
              sr += 0.5 * r - 0.418688 * g - 0.081312 * b;
            }
            cb[y * 8 + x] = sb / 2;
            cr[y * 8 + x] = sr / 2;
          }
        fdctQuant(cb, qc, coef, tmp);
        dcCb = writeBlock(w, coef, dcCb, H_DC_C, H_AC_C);
        fdctQuant(cr, qc, coef, tmp);
        dcCr = writeBlock(w, coef, dcCr, H_DC_C, H_AC_C);
      }
  }
  w.flush();
  w.raw([0xff, 0xd9]);
  return w.bytes();
}
