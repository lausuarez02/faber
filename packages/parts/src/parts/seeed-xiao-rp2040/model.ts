import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import { createRp2040BoardModel, limit } from "../raspberry-pi-pico/rp2040-board.ts";

/**
 * Seeed XIAO RP2040: RP2040 pads (shared RP2040 board model) and the RGB user LED: red GP17
 * (LED_BUILTIN), green GP16, blue GP25, each lit when its pin is LOW. The WS2812 on GP12 is not drawn.
 *
 * Power (round 6): the "5V" pad is VBUS. USB (jumper.json power.usb, default plugged) puts 5 V on it;
 * without USB the board runs from whatever is wired to that pad (3.5 to 5.5 V, e.g. a LiPo through
 * a Schottky diode). The on-board 3.3 V LDO feeds 3V3 and the RP2040; in dropout 3V3 follows the
 * input minus the dropout. The MCU runs while 3V3 ≥ min3v3V (the flash chip's 2.7 V).
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
    leds: [
      { key: "led_r", pin: "GP17", activeLow: true },
      { key: "led_g", pin: "GP16", activeLow: true },
      { key: "led_b", pin: "GP25", activeLow: true },
    ],
  });
