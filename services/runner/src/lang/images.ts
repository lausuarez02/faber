// Firmware image formats and the conversions between them. Each emulator backend loads one format:
//   avr8js, rp2040js   Intel HEX text (the RP2040 hex covers the 2 MB flash window at 0x10000000)
//   qemu-esp           a merged flash image padded to the flash size (2/4/8/16 MB)
//   renode             ELF (or Intel HEX, which Renode's LoadHEX takes too)
// Nothing here knows a language; languages produce bytes at addresses and pick an output.

export class ImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const UF2_MAGIC0 = 0x0a324655;
const UF2_MAGIC1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const UF2_FLAG_NOT_MAIN_FLASH = 0x1;

export function isUf2(bytes: Uint8Array): boolean {
  if (bytes.length < 512 || bytes.length % 512 !== 0) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, 512);
  return v.getUint32(0, true) === UF2_MAGIC0 && v.getUint32(4, true) === UF2_MAGIC1 && v.getUint32(508, true) === UF2_MAGIC_END;
}

/**
 * Write a UF2 file's payloads into a flash image of `size` bytes that starts at `base`
 * (0x10000000 for the RP2040). Blocks for other memories (flag NOT_MAIN_FLASH) are skipped.
 */
export function uf2ToFlash(uf2: Uint8Array, base: number, size: number): Uint8Array {
  if (!isUf2(uf2)) throw new ImageError("not-uf2", "the firmware file is not UF2 (wrong magic numbers). Fix: download the .uf2 build for this board again.");
  const image = new Uint8Array(size).fill(0xff);
  for (let o = 0; o < uf2.length; o += 512) {
    const v = new DataView(uf2.buffer, uf2.byteOffset + o, 512);
    if (v.getUint32(0, true) !== UF2_MAGIC0 || v.getUint32(508, true) !== UF2_MAGIC_END) throw new ImageError("bad-uf2", `UF2 block ${o / 512} is damaged. Fix: download the firmware again.`);
    if (v.getUint32(8, true) & UF2_FLAG_NOT_MAIN_FLASH) continue;
    const addr = v.getUint32(12, true);
    const n = v.getUint32(16, true);
    const off = addr - base;
    if (off < 0 || off + n > size || n > 476) throw new ImageError("uf2-range", `UF2 block ${o / 512} writes 0x${addr.toString(16)}, outside the flash (0x${base.toString(16)}, ${size} bytes). Why: the file is for another chip or a larger flash.`);
    image.set(uf2.subarray(o + 32, o + 32 + n), off);
  }
  return image;
}

/**
 * Intel HEX for the bytes of `image` (placed at `base`) that are not erased (0xFF). Rows of 32
 * bytes; runs of 0xFF longer than a row are skipped, so a mostly empty flash stays small.
 */
export function flashToIntelHex(image: Uint8Array, base: number): string {
  const lines: string[] = [];
  const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  const record = (type: number, addr: number, data: ArrayLike<number>) => {
    let sum = data.length + ((addr >> 8) & 0xff) + (addr & 0xff) + type;
    let s = `:${hex2(data.length)}${hex2((addr >> 8) & 0xff)}${hex2(addr & 0xff)}${hex2(type)}`;
    for (let i = 0; i < data.length; i++) {
      s += hex2(data[i]!);
      sum += data[i]!;
    }
    lines.push(s + hex2((0x100 - (sum & 0xff)) & 0xff));
  };
  let upper = -1;
  const ROW = 32;
  for (let off = 0; off < image.length; off += ROW) {
    const row = image.subarray(off, Math.min(off + ROW, image.length));
    if (row.every((b) => b === 0xff)) continue;
    const abs = base + off;
    const hi = abs >>> 16;
    if (hi !== upper) {
      record(0x04, 0, [(hi >> 8) & 0xff, hi & 0xff]);
      upper = hi;
    }
    record(0x00, abs & 0xffff, row);
  }
  record(0x01, 0, []);
  return lines.join("\n") + "\n";
}

/** One entry of an ESP-IDF partition table (32 bytes each at flash 0x8000). */
export interface EspPartition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

/** Read the ESP-IDF partition table from a flash image (flash offset 0x8000). */
export function espPartitions(flash: Uint8Array, tableOffset = 0x8000): EspPartition[] {
  const out: EspPartition[] = [];
  for (let o = tableOffset; o + 32 <= flash.length && o < tableOffset + 0xc00; o += 32) {
    const v = new DataView(flash.buffer, flash.byteOffset + o, 32);
    if (v.getUint16(0, true) !== 0x50aa) break;
    const labelBytes = flash.subarray(o + 12, o + 28);
    const end = labelBytes.indexOf(0);
    out.push({
      type: flash[o + 2]!,
      subtype: flash[o + 3]!,
      offset: v.getUint32(4, true),
      size: v.getUint32(8, true),
      label: new TextDecoder().decode(labelBytes.subarray(0, end < 0 ? 16 : end)),
    });
  }
  return out;
}

/** Place `bytes` at `offset` in an erased flash of `sizeMB` (2, 4, 8 or 16) MB, the image QEMU loads. */
export function padFlash(bytes: Uint8Array, offset: number, sizeMB: number): Uint8Array {
  const size = sizeMB << 20;
  if (offset + bytes.length > size) throw new ImageError("too-large", `the firmware (${bytes.length} bytes at 0x${offset.toString(16)}) does not fit a ${sizeMB} MB flash. Fix: pick a board with more flash or make the firmware smaller.`);
  const img = new Uint8Array(size).fill(0xff);
  img.set(bytes, offset);
  return img;
}
