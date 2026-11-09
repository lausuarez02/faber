import type { Usage } from "./hints.ts";

/**
 * Round 5, track "parts" (owner): get_part usage hints for the new parts (gc9a01-round-tft,
 * lipo-battery, tp4056-charger, passive-buzzer, vibration-motor, ttp223-touch,
 * capacitive-soil-moisture, relay-module, water-pump, ir-proximity, bump-switch, dht22, pir-motion,
 * ws2812-strip). Merged over the core table in hints.ts. Decision 0003, C7.
 */
export const PARTS_R5_HINTS: Record<string, Usage> = {};
