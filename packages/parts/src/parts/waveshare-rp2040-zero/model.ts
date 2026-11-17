import type { PartModel, PartModelFactory } from "@faber/sim-core";
import { createRp2040BoardModel, limit } from "../raspberry-pi-pico/rp2040-board.ts";

/**
 * Waveshare RP2040-Zero: RP2040 pads (shared RP2040 board model). Its only LED is a WS2812 on GP16,
 * which is not drawn.
 *
 * Power (round 6): the "5V" pin is VBUS. USB (faber.json power.usb, default plugged) puts 5 V on it;
 * without USB the board runs from what is wired to it. The on-board 3.3 V LDO (ME6217-class) feeds
 * 3V3; the MCU runs while 3V3 ≥ min3v3V.
 */
export const RAILS: Record<string, number> = { VBUS: 5, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createRp2040BoardModel(ctx, {
    rails: RAILS,
    supply: {
      usbPin: "VBUS",
      regulators: [{ id: "ldo", from: "VBUS", to: "3V3", params: { volts: 3.3, dropout: limit(ctx, "ldoDropoutV", 0.25), rOut: 0.01, iq: 0.00005, minIn: 1 } }],
      logicPin: "3V3",
      minLogicV: limit(ctx, "min3v3V", 2.7),
      selfmA: ctx.spec.current_ma?.typ ?? 25,
    },
  });
