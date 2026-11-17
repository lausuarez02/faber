// Seeed XIAO ESP32-C3: ESP32-family board model (round 10, decision 0006). The pads, LEDs and supply chain
// are data for the shared ESP board model (packages/parts/src/lib/espBoard.ts).
import type { PartModel, PartModelFactory } from "@fabwright/sim-core";
import { createEspBoardModel, limit } from "../../lib/espBoard.ts";

/** ETA4054S2F (Seeed schematic / wiki): 380 mA fast charge, 40 mA trickle, CV 4.2 V. */
export const CHARGE_A = 0.38;
export const TRICKLE_A = 0.04;

export const create: PartModelFactory = (ctx): PartModel =>
  createEspBoardModel(ctx, {
    supply: {
      usbPin: "5V",
      // Power path: USB (5V) and the battery pad (BAT) each feed the LDO input through a diode-like
      // switch, so USB never back-feeds the cell and the cell takes over when USB is unplugged.
      diodes: [
        { id: "vbus-path", from: "5V", to: "@sys", vf: 0.3, rOn: 0.05 },
        { id: "bat-path", from: "BAT", to: "@sys", vf: 0.05, rOn: 0.1 },
      ],
      regulators: [{ id: "ldo", from: "@sys", to: "3V3", params: { volts: 3.3, dropout: limit(ctx, "ldoDropoutV", 0.25), rOut: 0.01, iq: 0.00005, minIn: 1 } }],
      logicPin: "3V3",
      minLogicV: limit(ctx, "min3v3V", 3.0),
      selfmA: ctx.spec.current_ma?.typ ?? 20,
    },
    charger: { input: "5V", bat: "BAT", chargeA: CHARGE_A, trickleA: TRICKLE_A },
  });
