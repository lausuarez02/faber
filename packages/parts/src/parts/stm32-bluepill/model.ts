import type { PartModel, PartModelFactory } from "@fabwright/sim-core";
import { createRenodeBoardModel, limitOf, STM32_GPIO } from "../../lib/renodeBoard.ts";

/**
 * STM32 Blue Pill (STM32F103C8T6): STM32 pads (lib/renodeBoard.ts), the LED on PC13 (lit when LOW)
 * and the power LED. USB (power.usb) puts 5 V on the 5V pin, the on-board LDO (AMS1117-class,
 * about 1 V dropout) makes 3.3 V from it; the chip runs from 2.0 V.
 */
export const RAILS: Record<string, number> = { "5V": 5, "3V3.1": 3.3, "3V3.2": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createRenodeBoardModel(ctx, {
    rails: RAILS,
    ...STM32_GPIO,
    supply: {
      usbPin: "5V",
      regulators: [{ id: "ldo", from: "5V", to: "3V3.1", params: { volts: 3.3, dropout: limitOf(ctx, "ldoDropoutV", 1.0), rOut: 0.01, iq: 0.005, minIn: 1 } }],
      ties: [{ id: "tie:3v3", a: "3V3.1", b: "3V3.2", ohms: 0.02 }],
      logicPin: "3V3.1",
      minLogicV: limitOf(ctx, "min3v3V", 2.0),
      selfmA: ctx.spec.current_ma?.typ ?? 30,
    },
    leds: [{ key: "led", pin: "PC13", activeLow: true }],
  });
