// Shared model for the boards that run on the Renode backend (round 10: STM32 Blue Pill, Black Pill
// F411, Nucleo-F401RE, Arduino Nano 33 BLE, Seeed XIAO nRF52840). The pins are the generic MCU board
// model's (outputs as sources, pull-ups, inputs fed back to the emulator after every solve); the
// board adds its on-board LEDs and, where it has one, its power path.
import { createMcuBoardModel, type BoardSupply, type PartContext, type PartModel, type VisualState } from "@jumper/sim-core";

export interface RenodeBoardModelOptions {
  rails: Record<string, number>;
  supply?: BoardSupply;
  /** On-board LEDs: visual key → McuBackend pin id, active low or high. */
  leds?: readonly { key: string; pin: string; activeLow: boolean }[];
  /** Output resistance of a GPIO driving its pin (Ω). */
  gpioROut: number;
  /** INPUT_PULLUP resistance (Ω). */
  pullupOhms: number;
}

/** STM32F1 / F4 pins: VOH ≥ VDD - 0.4 V at 8 mA (about 50 Ω), pull-ups 30 to 50 kΩ (datasheet typ. 40 kΩ). */
export const STM32_GPIO = { gpioROut: 50, pullupOhms: 40_000 } as const;
/** nRF52840 pins at standard drive: VOH ≥ VDD - 0.4 V at 0.5 mA (a few hundred Ω), pull-ups 13 kΩ typ. */
export const NRF52_GPIO = { gpioROut: 300, pullupOhms: 13_000 } as const;

export function limitOf(ctx: PartContext, key: string, dflt: number): number {
  const v = (ctx.spec.limits as Record<string, number | undefined> | undefined)?.[key];
  return typeof v === "number" ? v : dflt;
}

export function createRenodeBoardModel(ctx: PartContext, opts: RenodeBoardModelOptions): PartModel {
  return createMcuBoardModel(ctx, {
    rails: opts.rails,
    ...(opts.supply ? { supply: opts.supply } : {}),
    gpioROut: opts.gpioROut,
    pullupOhms: opts.pullupOhms,
    visual: (): VisualState => {
      const v: VisualState = {};
      for (const led of opts.leds ?? []) {
        const s = ctx.mcu?.readPin(led.pin);
        v[led.key] = s && s.mode === "output" && (led.activeLow ? s.value === 0 : s.value === 1) ? 1 : 0;
      }
      return v;
    },
  });
}
