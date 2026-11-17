// ESP32-C3 SuperMini: ESP32-family board model (round 10, decision 0006). The pads, LEDs and supply chain
// are data for the shared ESP board model (packages/parts/src/lib/espBoard.ts).
import type { PartModel, PartModelFactory } from "@faber/sim-core";
import { createEspBoardModel, limit } from "../../lib/espBoard.ts";

export const create: PartModelFactory = (ctx): PartModel =>
  createEspBoardModel(ctx, {
    supply: {
      usbPin: "5V",
      regulators: [{ id: "ldo", from: "5V", to: "3V3", params: { volts: 3.3, dropout: limit(ctx, "ldoDropoutV", 0.3), rOut: 0.01, iq: 0.00005, minIn: 1 } }],
      logicPin: "3V3",
      minLogicV: limit(ctx, "min3v3V", 3.0),
      selfmA: ctx.spec.current_ma?.typ ?? 20,
    },
    leds: [
      { key: "led_user", pin: "GPIO8", activeLow: true }
    ],
  });
