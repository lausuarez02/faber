// Round 15: the deep-sleep record the FabwrightSleep shim (toolchains/arduino-esp32/libraries/FabwrightSleep)
// writes into the last 8 KB of flash before it sleeps. Fabwright fills in why and how long the board
// slept, then reboots it; the shim reads it back at boot (RTC memory, the clock, the wake cause).
// Offsets mirror jslp_header_t in fabwright_sim_sleep.c.
import type { WakeInfo } from "@fabwright/sim-core";

export const SLEEP_RECORD_BYTES = 8192;
const MAGIC = 0x504c534a; // "JSLP" little-endian
const VERSION = 1;
const WOKEN = 2;
/** ESP-IDF esp_sleep_source_t. */
export const WAKE_CAUSE_CODE: Record<WakeInfo["cause"], number> = { ext0: 2, ext1: 3, timer: 4, gpio: 7, manual: 0 };

/**
 * Patch the record at the end of `flash` in place. Returns what happened in words: "patched", or why
 * not ("no record": the firmware did not go through the shim, so it boots as after a power-on).
 */
export function patchSleepRecord(flash: Uint8Array, info: WakeInfo): "patched" | "no record" | "other version" {
  if (flash.length < 2 * SLEEP_RECORD_BYTES) return "no record";
  const at = flash.length - SLEEP_RECORD_BYTES;
  const v = new DataView(flash.buffer, flash.byteOffset + at, 64);
  if (v.getUint32(0, true) !== MAGIC) return "no record";
  if (v.getUint32(4, true) !== VERSION) return "other version";
  const gpio = info.pin ? Number(/(\d+)$/.exec(info.pin)?.[1] ?? -1) : -1;
  v.setUint32(8, WOKEN, true);
  v.setUint32(12, WAKE_CAUSE_CODE[info.cause], true);
  v.setInt32(16, gpio, true);
  v.setBigUint64(24, BigInt(Math.max(0, Math.round(info.slept_ms * 1000))), true);
  return "patched";
}

/** The record's header as Fabwright sees it (tests, diagnostics). */
export function readSleepRecord(flash: Uint8Array): { state: number; cause: number; wake_gpio: number; slept_us: bigint; tv_sec: bigint; lens: number[] } | undefined {
  if (flash.length < 2 * SLEEP_RECORD_BYTES) return undefined;
  const v = new DataView(flash.buffer, flash.byteOffset + flash.length - SLEEP_RECORD_BYTES, 64);
  if (v.getUint32(0, true) !== MAGIC) return undefined;
  return { state: v.getUint32(8, true), cause: v.getUint32(12, true), wake_gpio: v.getInt32(16, true), slept_us: v.getBigUint64(24, true), tv_sec: v.getBigInt64(32, true), lens: [0, 1, 2, 3].map((i) => v.getUint32(48 + 4 * i, true)) };
}
