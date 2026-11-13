// Round 15: deep sleep, for any board. A board in deep sleep runs no firmware (the Simulation stops
// stepping its MCU, so virtual time passes as fast as the parts' own events allow: hours in
// seconds), its pins keep the configuration they had (the RTC pull-ups that hold a wake pin), and
// it wakes on a timer or a pin level, then boots from the start with its flash kept, as the real
// chip does. The firmware side tells Jumper with one console line, printed by a sleep shim the
// simulation build links in (toolchains/arduino-esp32/libraries/JumperSleep for the ESP32 family):
//
//   [jumper:sleep] {"mode":"deep","us":3600000000,"pins":[{"gpio":4,"level":0}],"any":true}
//
// `us` is the timer (absent = no timer), `pins` the wake pins with the level that wakes the chip,
// `any` true = any listed pin wakes (ESP32 ext1 ANY_HIGH / ext0 / C3 GPIO wake), false = all of them
// must be at their level (ext1 ALL_LOW). No Date / timers here: everything is virtual time.

/** What the firmware asked for when it went to sleep. */
export interface SleepRequest {
  mode: "deep";
  /** Timer wake-up after this many virtual ms (undefined: no timer). */
  wakeAfterMs?: number;
  /** Wake pins (McuBackend pin ids, e.g. "GPIO4") and the level that wakes. */
  wakePins: { pin: string; level: 0 | 1 }[];
  /** true: any pin at its level wakes (default); false: all of them must be. */
  any: boolean;
  /** Which wake API armed the pins (ESP-IDF: ext0, ext1, gpio), reported back as the wake cause. */
  pinSource?: "ext0" | "ext1" | "gpio";
}

/** Why the board woke (ESP-IDF esp_sleep_source_t names, lower case). */
export type WakeCause = "timer" | "ext0" | "ext1" | "gpio" | "manual";

export interface SleepEvent {
  /** Virtual ms the board went to sleep. */
  t_ms: number;
  request: SleepRequest;
  /** Set when it woke. */
  woke?: { t_ms: number; cause: WakeCause; pin?: string; slept_ms: number };
}

/** What the backend is told before the wake reboot (the ESP32 shim reads it back from flash). */
export interface WakeInfo {
  cause: WakeCause;
  /** Wake pin (McuBackend id) when a pin woke it. */
  pin?: string;
  /** How long it slept (virtual ms). */
  slept_ms: number;
}

export const SLEEP_MARKER = "[jumper:sleep]";

/**
 * Parse one console line. Returns the request, an error that says what is wrong (a shim and a
 * Jumper of different versions), or undefined when the line is not a sleep marker.
 * `pinId` maps a GPIO number to the backend's pin id (ESP: "GPIO<n>").
 */
export function parseSleepMarker(line: string, pinId: (gpio: number) => string = (g) => `GPIO${g}`): SleepRequest | { error: string } | undefined {
  const at = line.indexOf(SLEEP_MARKER);
  if (at < 0) return undefined;
  const text = line.slice(at + SLEEP_MARKER.length).trim();
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return { error: `the sleep line "${line.trim().slice(0, 120)}" is not JSON after ${SLEEP_MARKER}. Why: the simulation build's sleep shim and this Jumper disagree on the format. Fix: rebuild the firmware (build) so the current shim is linked in.` };
  }
  const r = o as { mode?: unknown; us?: unknown; pins?: unknown; any?: unknown; src?: unknown };
  if (r.mode !== undefined && r.mode !== "deep") return { error: `sleep mode ${JSON.stringify(r.mode)} is not simulated (only "deep"). Fix: use esp_deep_sleep_start(); light sleep runs as normal execution.` };
  const pins: SleepRequest["wakePins"] = [];
  if (r.pins !== undefined) {
    if (!Array.isArray(r.pins)) return { error: `the sleep line's "pins" is not a list. Fix: rebuild the firmware (build) so the current shim is linked in.` };
    for (const p of r.pins as { gpio?: unknown; level?: unknown }[]) {
      if (typeof p?.gpio !== "number" || (p.level !== 0 && p.level !== 1)) return { error: `a wake pin in the sleep line is not {"gpio": n, "level": 0 | 1} (got ${JSON.stringify(p)}). Fix: rebuild the firmware (build).` };
      pins.push({ pin: pinId(p.gpio), level: p.level });
    }
  }
  const us = typeof r.us === "number" && r.us > 0 ? r.us : undefined;
  const src = r.src === "ext0" || r.src === "ext1" || r.src === "gpio" ? r.src : undefined;
  return { mode: "deep", ...(us !== undefined ? { wakeAfterMs: us / 1000 } : {}), wakePins: pins, any: r.any !== false, ...(src ? { pinSource: src } : {}) };
}

/** Plain words for a request, for logs and results. */
export function sleepText(r: SleepRequest): string {
  const parts: string[] = [];
  if (r.wakeAfterMs !== undefined) parts.push(`after ${fmtMs(r.wakeAfterMs)}`);
  if (r.wakePins.length) parts.push(`${r.any || r.wakePins.length === 1 ? "when" : "when all of"} ${r.wakePins.map((p) => `${p.pin} goes ${p.level ? "high" : "low"}`).join(r.any ? " or " : " and ")}`);
  return parts.length ? `deep sleep, wakes ${parts.join(" or ")}` : "deep sleep with no wake-up source (only a reset wakes it)";
}

export function fmtMs(ms: number): string {
  if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(2)} h`;
  if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1000) return `${+(ms / 1000).toFixed(1)} s`;
  return `${+ms.toFixed(1)} ms`;
}
