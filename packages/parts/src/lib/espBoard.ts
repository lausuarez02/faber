// Shared model for the ESP32-family boards (round 10, decision 0006): ESP32 DevKitC, ESP32-S3
// DevKitC-1, Seeed XIAO ESP32-S3 / ESP32-C3, ESP32-C3 SuperMini. The pads, LEDs, supply chain and
// (XIAO) the on-board Li-ion charger are data the board's model.ts passes in.
import { createMcuBoardModel, GROUND, type BoardSupply, type PartContext, type PartModel, type VisualState } from "@fabwright/sim-core";
import { createLinearCharger, type LinearChargerSpec } from "./linearCharger.ts";

/**
 * ESP32 pads at the default drive strength (GPIO_DRIVE_CAP_2, ~20 mA): VOH ≥ 0.8 × VDD at 20 mA in
 * the datasheets, about 30 Ω. Internal pull-ups / pull-downs: 45 kΩ typical (ESP32 datasheet,
 * "RPU / RPD 45 kΩ").
 */
export const ESP_GPIO_R_OUT = 30;
export const ESP_PULL_OHMS = 45_000;

export interface EspBoardOptions {
  /** On-board LEDs driven by a GPIO (active low or high). */
  leds?: readonly { key: string; pin: string; activeLow: boolean }[];
  supply: BoardSupply;
  /** A Li-ion charger on the board: from `input` (a pin, e.g. "5V") into `bat` (the BAT pad). */
  charger?: LinearChargerSpec & { input: string; bat: string };
}

export function limit(ctx: PartContext, key: string, dflt: number): number {
  const v = (ctx.spec.limits as Record<string, number | undefined> | undefined)?.[key];
  return typeof v === "number" ? v : dflt;
}

export function createEspBoardModel(ctx: PartContext, opts: EspBoardOptions): PartModel {
  const charger = opts.charger ? createLinearCharger(opts.charger) : undefined;
  const base = createMcuBoardModel(ctx, {
    supply: opts.supply,
    gpioROut: ESP_GPIO_R_OUT,
    pullupOhms: ESP_PULL_OHMS,
    pulldownOhms: ESP_PULL_OHMS,
    visual: (): VisualState => {
      const v: VisualState = {};
      for (const led of opts.leds ?? []) {
        const s = ctx.mcu?.readPin(led.pin);
        const lit = !!s && s.mode === "output" && (led.activeLow ? s.value === 0 : s.value === 1);
        v[led.key] = lit ? 1 : 0;
      }
      if (charger) {
        v.charging = charger.charging;
        v.chargemA = charger.chargemA;
        v.chargeMode = charger.mode;
      }
      return v;
    },
  });
  if (!charger || !opts.charger) return base;
  const spec = opts.charger;
  const input = () => ctx.node(spec.input);
  const bat = () => ctx.node(spec.bat);
  return {
    ...base,
    stamp(c) {
      base.stamp(c);
      // A tiny leak keeps an empty BAT pad defined (the charger sees "no battery" and stays off).
      c.resistor(bat(), GROUND, 1e6, { id: "bat-leak" });
      charger.stamp(c, input(), bat(), ctx.internalNode("charge-ref"));
    },
    onSolved(r, tMs) {
      base.onSolved?.(r, tMs);
      if (charger.onSolved(r, input(), bat(), tMs)) ctx.requestSolve();
    },
    tick(tMs, dtMs) {
      base.tick?.(tMs, dtMs);
      if (charger.wantsRestart(tMs)) ctx.requestSolve();
    },
  };
}
