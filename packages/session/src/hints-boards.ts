import type { Usage } from "./hints.ts";

/**
 * Round 5, track "rp2040" (owner): get_part usage hints for the pocket boards
 * (raspberry-pi-pico, seeed-xiao-rp2040, waveshare-rp2040-zero). Merged over the core table in
 * hints.ts. Decision 0003, C7.
 */
export const BOARDS_R5_HINTS: Record<string, Usage> = {};
