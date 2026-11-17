import type { PartModel, PartModelFactory } from "@fabwright/sim-core";
import { createRenodeBoardModel, limitOf, STM32_GPIO } from "../../lib/renodeBoard.ts";

/**
 * ST Nucleo-F401RE: STM32 pads (lib/renodeBoard.ts), LD2 on PA5 (lit when HIGH). The ST-LINK USB
 * (power.usb) gives 5 V, VIN (7 to 12 V) reaches 5V through the LD1117S50 (about 1.1 V dropout),
 * the LD39050 LDO makes 3.3 V. B1 on PC13 is pressed = LOW through an external pull-up on the real
 * board: wire a pushbutton to PC13 and GND, with INPUT_PULLUP.
 */
export const RAILS: Record<string, number> = { "5V": 5, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createRenodeBoardModel(ctx, {
    rails: RAILS,
    ...STM32_GPIO,
    supply: {
      usbPin: "5V",
      regulators: [
        { id: "ldo", from: "5V", to: "3V3", params: { volts: 3.3, dropout: limitOf(ctx, "ldoDropoutV", 0.2), rOut: 0.01, iq: 0.005, minIn: 1 } },
        { id: "vin", from: "VIN", to: "5V", params: { volts: 5, dropout: 1.1, rOut: 0.01, minIn: 1 } },
      ],
      logicPin: "3V3",
      minLogicV: limitOf(ctx, "min3v3V", 1.7),
      selfmA: ctx.spec.current_ma?.typ ?? 60,
    },
    leds: [{ key: "led", pin: "PA5", activeLow: false }],
  });
