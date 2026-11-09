import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import { createRp2040BoardModel } from "../raspberry-pi-pico/rp2040-board.ts";

/**
 * Seeed XIAO RP2040: RP2040 pads (shared RP2040 board model), the 5V (USB VBUS) and 3V3 rails, and
 * the RGB user LED: red GP17 (LED_BUILTIN), green GP16, blue GP25, each lit when its pin is LOW.
 * The WS2812 on GP12 is not drawn.
 */
export const RAILS: Record<string, number> = { VBUS: 5, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createRp2040BoardModel(ctx, {
    rails: RAILS,
    leds: [
      { key: "led_r", pin: "GP17", activeLow: true },
      { key: "led_g", pin: "GP16", activeLow: true },
      { key: "led_b", pin: "GP25", activeLow: true },
    ],
  });
