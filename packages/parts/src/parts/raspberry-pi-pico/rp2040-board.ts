// Shared model for the RP2040 boards (raspberry-pi-pico, seeed-xiao-rp2040, waveshare-rp2040-zero).
import { createMcuBoardModel, GROUND, type BoardSupply, type PartContext, type PartModel, type VisualState } from "@fabwright/sim-core";

export interface Rp2040BoardModelOptions {
  /** Power pins → volts. */
  rails: Record<string, number>;
  /** On-board LEDs: visual key → GPIO pin id, active low or high. */
  leds?: readonly { key: string; pin: string; activeLow: boolean }[];
  /** Pins tied to a rail through a resistor (the Pico's ADC_VREF: 3.3 V through 200 Ω). */
  filtered?: readonly { pin: string; volts: number; ohms: number }[];
  /** Round 6 (power): the board's supply chain (USB → VBUS, regulators, diodes). */
  supply?: BoardSupply;
}

/** Numbers from the part's `limits` (round 6), with defaults. */
export function limit(ctx: PartContext, key: string, dflt: number): number {
  const v = (ctx.spec.limits as Record<string, number | undefined> | undefined)?.[key];
  return typeof v === "number" ? v : dflt;
}

/**
 * RP2040 pads at the default 4 mA drive: about 50 Ω output resistance at 3.3 V (VOH ≥ 2.62 V at
 * 4 mA in the datasheet, typically much better), internal pull-ups ~50 kΩ (datasheet 50-80 kΩ).
 */
export const RP2040_GPIO_R_OUT = 50;
export const RP2040_PULLUP_OHMS = 50_000;

export function createRp2040BoardModel(ctx: PartContext, opts: Rp2040BoardModelOptions): PartModel {
  const base = createMcuBoardModel(ctx, {
    rails: opts.rails,
    ...(opts.supply ? { supply: opts.supply } : {}),
    gpioROut: RP2040_GPIO_R_OUT,
    pullupOhms: RP2040_PULLUP_OHMS,
    visual: (): VisualState => {
      const v: VisualState = {};
      for (const led of opts.leds ?? []) {
        const s = ctx.mcu?.readPin(led.pin);
        const lit = !!s && s.mode === "output" && (led.activeLow ? s.value === 0 : s.value === 1);
        v[led.key] = lit ? 1 : 0;
      }
      return v;
    },
  });
  const specPins = new Set(ctx.spec.pins.map((p) => p.id));
  return {
    ...base,
    stamp(c) {
      base.stamp(c);
      // ADC_VREF follows the 3.3 V rail: only while the board has power.
      if (base.powered?.() === false) return;
      for (const f of opts.filtered ?? []) {
        if (specPins.has(f.pin)) c.voltageSource(ctx.node(f.pin), GROUND, f.volts, f.ohms, { id: `filtered:${f.pin}` });
      }
    },
  };
}
