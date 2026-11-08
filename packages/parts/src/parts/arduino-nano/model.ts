import { createMcuBoardModel, type PartModel, type PartModelFactory } from "@jumper/sim-core";

/**
 * Arduino Nano: the generic MCU board model from sim-core (GPIO = 25 Ω source, INPUT_PULLUP =
 * 35 kΩ, inputs fed back to the CPU after every solve) plus the board's power rails.
 * The on-board L LED sits behind a buffer on D13, so it is purely visual and never loads the pin.
 * GPIO pin ids in part.json are the McuBackend pin ids ("D0".."D13", "A0".."A5").
 */
export const RAILS: Record<string, number> = { "5V": 5, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createMcuBoardModel(ctx, {
    rails: RAILS,
    visual: () => {
      const d13 = ctx.mcu?.readPin("D13");
      return { led_l: d13 && d13.mode === "output" && d13.value ? 1 : 0 };
    },
  });
