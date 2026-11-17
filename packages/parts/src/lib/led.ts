import type { DiodeParams } from "@faber/sim-core";
import { clamp, round } from "./props.ts";

/**
 * Piecewise-linear LED parameters per colour. `vf` is the knee of the model, `rOn` the dynamic
 * resistance above it, so the forward voltage at 20 mA is vf + 0.02·rOn (typical datasheet Vf):
 *   red 2.0 V → 2.1 V @ 20 mA, yellow 2.1 → 2.2 V, green (GaP) 2.2 → 2.3 V,
 *   blue / white (InGaN) 2.9 → 3.1 V.
 */
export const LED_COLORS = {
  red: { vf: 2.0, rOn: 5, glow: "#FF3B2F", lens: "#5A1712" },
  yellow: { vf: 2.1, rOn: 5, glow: "#FFD23F", lens: "#5A4A12" },
  green: { vf: 2.2, rOn: 5, glow: "#5CF2A1", lens: "#14422B" },
  blue: { vf: 2.9, rOn: 10, glow: "#4DA3FF", lens: "#12305A" },
  white: { vf: 2.9, rOn: 10, glow: "#F4F7FF", lens: "#4A4F58" },
} as const satisfies Record<string, DiodeParams & { glow: string; lens: string }>;
export type LedColor = keyof typeof LED_COLORS;

export function ledColor(name: string): LedColor {
  return (name in LED_COLORS ? name : "red") as LedColor;
}

/** Below this current an indicator LED is not visibly lit. */
export const LED_VISIBLE_mA = 0.1;
/** Typical rated current; brightness saturates here. */
export const LED_RATED_mA = 20;
/** Above this the LED is being destroyed (typical absolute max 30 mA continuous). */
export const LED_ABS_MAX_mA = 30;

/**
 * Perceived brightness 0..1 from forward current. 0 below 0.1 mA, 1 at 20 mA and above,
 * with a square-root curve in between (eyes are roughly logarithmic; LEDs roughly linear in
 * luminous intensity vs current), e.g. 1 mA → 0.21, 5 mA → 0.50, 13 mA → 0.80.
 */
export function ledBrightness(mA: number): number {
  if (!(mA > LED_VISIBLE_mA)) return 0;
  return round(clamp(Math.sqrt((mA - LED_VISIBLE_mA) / (LED_RATED_mA - LED_VISIBLE_mA)), 0, 1));
}
