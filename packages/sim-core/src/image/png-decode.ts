// PNG decoder (8- and 16-bit gray, gray + alpha, RGB, RGBA and palette; Adam7 interlacing), for
// camera test images and dropped-in stills. Output: RGBA.
import { unzlibSync } from "fflate";
import { ImageFormatError, type DecodedImage } from "./jpeg-decode.ts";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (b: Uint8Array) => SIG.every((v, i) => b[i] === v);

export function decodePng(bytes: Uint8Array): DecodedImage {
  if (!isPng(bytes)) throw new ImageFormatError("not a PNG file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let W = 0, H = 0, depth = 8, ctype = 6, interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const data = bytes.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IHDR") {
      W = dv.getUint32(p - 12 - len + 8);
      H = dv.getUint32(p - 12 - len + 12);
      depth = data[8]!;
      ctype = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!W || !H || !idat.length) throw new ImageFormatError("the PNG has no image data");
  if (depth !== 8 && depth !== 16 && !(ctype === 3 || ctype === 0)) throw new ImageFormatError(`${depth}-bit PNG of colour type ${ctype} is not supported`);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(z);
  } catch (err) {
    throw new ImageFormatError(`the PNG data is corrupt (${(err as Error).message})`);
  }
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0 | 2 | 3 | 4 | 6];
  if (!chans) throw new ImageFormatError(`PNG colour type ${ctype} is not supported`);
  const bpp = Math.max(1, (chans * depth) / 8);
  const rgba = new Uint8Array(W * H * 4);
  let rp = 0;
  const pass = (x0: number, y0: number, dx: number, dy: number) => {
    const pw = Math.ceil((W - x0) / dx), ph = Math.ceil((H - y0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const stride = Math.ceil((pw * chans * depth) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const f = raw[rp++]!;
      const line = raw.slice(rp, rp + stride);
      rp += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - Math.ceil(bpp)]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - Math.ceil(bpp)]! : 0;
        let v = line[i]!;
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        line[i] = v & 0xff;
      }
      prev = line;
      for (let x = 0; x < pw; x++) {
        const s = (k: number): number => {
          if (depth === 16) return line[(x * chans + k) * 2]!;
          if (depth === 8) return line[x * chans + k]!;
          const per = 8 / depth;
          const byte = line[Math.floor(x / per)]!;
          const v = (byte >> (8 - depth * ((x % per) + 1))) & ((1 << depth) - 1);
          return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
        };
        const d = 4 * ((y0 + y * dy) * W + x0 + x * dx);
        if (ctype === 3) {
          const i = s(0);
          rgba[d] = palette?.[3 * i] ?? 0;
          rgba[d + 1] = palette?.[3 * i + 1] ?? 0;
          rgba[d + 2] = palette?.[3 * i + 2] ?? 0;
          rgba[d + 3] = trns && i < trns.length ? trns[i]! : 255;
        } else if (chans <= 2) {
          rgba[d] = rgba[d + 1] = rgba[d + 2] = s(0);
          rgba[d + 3] = chans === 2 ? s(1) : 255;
        } else {
          rgba[d] = s(0);
          rgba[d + 1] = s(1);
          rgba[d + 2] = s(2);
          rgba[d + 3] = chans === 4 ? s(3) : 255;
        }
      }
    }
  };
  if (interlace) for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const) pass(x0, y0, dx, dy);
  else pass(0, 0, 1, 1);
  return { width: W, height: H, rgba };
}
