import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import { createRp2040BoardModel } from "../raspberry-pi-pico/rp2040-board.ts";

/**
 * Waveshare RP2040-Zero: RP2040 pads (shared RP2040 board model) and the 5V (USB VBUS) and 3V3
 * rails. Its only LED is a WS2812 on GP16, which is not drawn.
 */
export const RAILS: Record<string, number> = { VBUS: 5, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel => createRp2040BoardModel(ctx, { rails: RAILS });
