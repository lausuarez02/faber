import type { PartModel, PartModelFactory } from "@fabwright/sim-core";
import { createRp2040BoardModel, limit } from "./rp2040-board.ts";

/**
 * Raspberry Pi Pico: RP2040 pads (50 Ω drive, 50 kΩ pull-ups, inputs fed back to the CPU after every
 * solve), ADC_VREF as 3.3 V through the board's 200 Ω filter, and the green LED on GP25.
 * GPIO pin ids are the McuBackend pin ids "GP0".."GP28".
 *
 * Power (round 6): USB (fabwright.json power.usb, default plugged) puts 5 V on VBUS; VBUS reaches VSYS
 * through the on-board Schottky (MBR120-class, ~0.3 V). VSYS (1.8 to 5.5 V) feeds the RT6150
 * buck-boost that makes 3V3 (about 90 % efficient), so a LiPo or 2 × AA on VSYS powers it with USB
 * unplugged. 3V3_EN pulled LOW switches the 3.3 V regulator off (it is pulled up to VSYS by 100 kΩ).
 */
export const RAILS: Record<string, number> = { VBUS: 5, VSYS: 4.7, "3V3": 3.3 };

export const create: PartModelFactory = (ctx): PartModel =>
  createRp2040BoardModel(ctx, {
    rails: RAILS,
    supply: {
      usbPin: "VBUS",
      diodes: [{ id: "vsys-diode", from: "VBUS", to: "VSYS", vf: 0.28, rOn: 0.3 }],
      regulators: [
        {
          id: "buckboost",
          from: "VSYS",
          to: "3V3",
          enable: "3V3_EN",
          params: { volts: 3.3, kind: "switching", passThrough: false, rOut: 0.01, efficiency: limit(ctx, "regEfficiency", 0.9), iq: 0.00005, minIn: limit(ctx, "minVsysV", 1.8) },
        },
      ],
      logicPin: "3V3",
      minLogicV: limit(ctx, "min3v3V", 2.7),
      selfmA: ctx.spec.current_ma?.typ ?? 25,
    },
    leds: [{ key: "led", pin: "GP25", activeLow: false }],
    filtered: [{ pin: "ADC_VREF", volts: 3.3, ohms: 200 }],
  });
