// Intel HEX → RP2040 flash image. sim-core's parseIntelHex returns a flat image from address 0,
// which for flash at 0x10000000 would be a 256 MB array; this one writes into the flash window only.

export const FLASH_BASE = 0x1000_0000;
/** 2 MB QSPI flash on all three boards (W25Q16JV / GD25Q16 class). */
export const FLASH_BYTES = 2 * 1024 * 1024;

export class FirmwareImageError extends Error {}

/**
 * Parse Intel HEX text (record types 00, 01, 02, 04; 03/05 ignored) into a flash image of
 * FLASH_BYTES (gaps 0xFF). Every data byte must land in 0x10000000…0x101FFFFF; anything else means
 * the file was built for another chip, and the error says so.
 */
export function parseRp2040Hex(text: string): { image: Uint8Array; used: number } {
  const image = new Uint8Array(FLASH_BYTES).fill(0xff);
  let base = 0;
  let used = 0;
  let minAddr = Infinity;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!.trim();
    if (!line) continue;
    if (line[0] !== ":") throw new FirmwareImageError(`firmware hex line ${ln + 1} does not start with ':'. Why: the file is not Intel HEX. Fix: build the sketch again (build) and load firmware/<sketch>.hex.`);
    const n = parseInt(line.slice(1, 3), 16);
    if (Number.isNaN(n) || line.length !== 11 + 2 * n) throw new FirmwareImageError(`firmware hex line ${ln + 1} has the wrong length. Why: the file is truncated or edited. Fix: build the sketch again.`);
    let sum = 0;
    for (let i = 1; i < line.length; i += 2) sum = (sum + parseInt(line.slice(i, i + 2), 16)) & 0xff;
    if (sum !== 0) throw new FirmwareImageError(`firmware hex line ${ln + 1} has a bad checksum. Why: the file is corrupted. Fix: build the sketch again.`);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0x00) {
      const abs = base + addr;
      minAddr = Math.min(minAddr, abs);
      const off = abs - FLASH_BASE;
      if (off < 0 || off + n > FLASH_BYTES) {
        // round 6 switch: the fix names the likely cause (an old or another project's hex), not only the FQBN.
        const avr = abs < 0x10000;
        throw new FirmwareImageError(
          `the firmware writes to address 0x${abs.toString(16).padStart(8, "0")}, outside the RP2040's flash (0x10000000 to 0x101FFFFF). ` +
            (avr
              ? "Why: this hex is an AVR image (Arduino Uno / Nano / Mega hexes start at 0x0000), not one built for this RP2040 board: usually an older build or another project's firmware. " +
                "Fix: build this project's sketch again (Build & Run, or ask the agent to build); only if that build still makes an AVR hex, set firmware.build.fqbn to the board's FQBN (e.g. rp2040:rp2040:seeed_xiao_rp2040)."
              : "Why: the image is larger than the 2 MB flash, or it is not a flash image. Fix: build the sketch for this RP2040 board (Build & Run) and load the .hex or .uf2 that build writes."),
        );
      }
      for (let i = 0; i < n; i++) image[off + i] = parseInt(line.slice(9 + 2 * i, 11 + 2 * i), 16);
      used = Math.max(used, off + n);
    } else if (type === 0x01) {
      break;
    } else if (type === 0x02) {
      base = parseInt(line.slice(9, 13), 16) << 4;
    } else if (type === 0x04) {
      base = parseInt(line.slice(9, 13), 16) * 0x10000;
    }
  }
  if (used === 0) throw new FirmwareImageError("the firmware hex has no data. Why: the build produced an empty file. Fix: build the sketch again.");
  if (minAddr !== FLASH_BASE) {
    // arduino-pico images start with the 256-byte boot2 stage at the start of flash.
    throw new FirmwareImageError(`the firmware does not start at 0x10000000 (lowest byte at 0x${minAddr.toString(16)}). Why: RP2040 firmware begins with the boot2 stage at the start of flash; this file is not a whole flash image. Fix: build with arduino-pico (rp2040:rp2040:<board>) and load the .hex Fabwright writes.`);
  }
  return { image, used };
}
