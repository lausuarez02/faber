import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import { createRp2040BoardModel } from "./rp2040-board.ts";

/**
 * Raspberry Pi Pico: RP2040 pads (50 Ω drive, 50 kΩ pull-ups, inputs fed back to the CPU after every
 * solve), VBUS (USB 5 V), VSYS (VBUS through the Schottky diode, ~4.7 V) and the 3.3 V regulator
 * output as rails, ADC_VREF as 3.3 V through the board's 200 Ω filter, and the green LED on GP25.
 * GPIO pin ids are the McuBackend pin ids "GP0".."GP28".
 */
export const RAILS: Record<string, number> = { VBUS: 5, VSYS: 4.7, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createRp2040BoardModel(ctx, {
    rails: RAILS,
    leds: [{ key: "led", pin: "GP25", activeLow: false }],
    filtered: [{ pin: "ADC_VREF", volts: 3.3, ohms: 200 }],
  });
