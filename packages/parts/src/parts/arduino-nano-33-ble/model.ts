import type { PartModel, PartModelFactory } from "@fabwright/sim-core";
import { createRenodeBoardModel, limitOf, NRF52_GPIO } from "../../lib/renodeBoard.ts";

/**
 * Arduino Nano 33 BLE (nRF52840): nRF52 pads (lib/renodeBoard.ts), the orange LED on D13 (lit when
 * HIGH) and the RGB LED (P0.24 / P0.16 / P0.06, lit when LOW). USB (power.usb) is 5 V on VUSB (as if
 * the VUSB jumper is closed) and reaches VIN through a Schottky; the MPM3610 buck makes 3.3 V from
 * VIN (4.5 to 21 V, about 90 % efficient).
 */
export const RAILS: Record<string, number> = { VUSB: 5, VIN: 4.7, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createRenodeBoardModel(ctx, {
    rails: RAILS,
    ...NRF52_GPIO,
    supply: {
      usbPin: "VUSB",
      diodes: [{ id: "usb-diode", from: "VUSB", to: "VIN", vf: 0.3, rOn: 0.3 }],
      regulators: [{ id: "buck", from: "VIN", to: "3V3", params: { volts: 3.3, kind: "switching", passThrough: false, rOut: 0.01, efficiency: 0.9, iq: 0.00005, minIn: limitOf(ctx, "vinMinV", 4.5) - 0.3 } }],
      logicPin: "3V3",
      minLogicV: limitOf(ctx, "min3v3V", 1.7),
      selfmA: ctx.spec.current_ma?.typ ?? 15,
    },
    leds: [
      { key: "led", pin: "D13", activeLow: false },
      { key: "led_r", pin: "LEDR", activeLow: true },
      { key: "led_g", pin: "LEDG", activeLow: true },
      { key: "led_b", pin: "LEDB", activeLow: true },
    ],
  });
