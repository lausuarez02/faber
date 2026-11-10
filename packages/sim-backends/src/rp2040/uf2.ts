// Intel HEX → UF2, the file an RP2040 board in BOOTSEL mode accepts by drag and drop (its RPI-RP2
// drive). Format: https://github.com/microsoft/uf2 (MIT); RP2040 family id 0xE48BFF56, 256-byte
// payloads, the same layout the pico-sdk's elf2uf2 writes.
import { FLASH_BASE, parseRp2040Hex } from "./hex.ts";

const MAGIC_START0 = 0x0a324655;
const MAGIC_START1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
const FLAG_FAMILY_ID = 0x00002000;
export const RP2040_FAMILY_ID = 0xe48bff56;
const PAGE = 256;

export function hexToUf2(hexText: string): Uint8Array {
  const { image, used } = parseRp2040Hex(hexText);
  const pages: number[] = [];
  for (let off = 0; off < used; off += PAGE) {
    // Pages that are all 0xFF are erased flash; skipping them is what elf2uf2 does for gaps.
    let blank = true;
    for (let i = off; i < off + PAGE; i++) if (image[i] !== 0xff) blank = false;
    if (!blank) pages.push(off);
  }
  const out = new Uint8Array(pages.length * 512);
  const view = new DataView(out.buffer);
  pages.forEach((off, n) => {
    const b = n * 512;
    view.setUint32(b + 0, MAGIC_START0, true);
    view.setUint32(b + 4, MAGIC_START1, true);
    view.setUint32(b + 8, FLAG_FAMILY_ID, true);
    view.setUint32(b + 12, FLASH_BASE + off, true);
    view.setUint32(b + 16, PAGE, true);
    view.setUint32(b + 20, n, true);
    view.setUint32(b + 24, pages.length, true);
    view.setUint32(b + 28, RP2040_FAMILY_ID, true);
    // Bytes past the end of the image are zero, as in the core's uf2conv output.
    out.set(image.subarray(off, Math.min(off + PAGE, used)), b + 32);
    view.setUint32(b + 508, MAGIC_END, true);
  });
  return out;
}
