import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@jumper/sim-core";
import { GROUND } from "@jumper/sim-core";
import { num, round, str } from "../../lib/props.ts";

export interface BatteryPreset {
  label: string;
  /** Open-circuit voltage when fresh (V). */
  volts: number;
  /** Internal resistance of the whole pack (Ω). */
  ohms: number;
  /** Practical continuous current (A). */
  maxA: number;
}

export const BATTERY_PRESETS: Record<string, BatteryPreset> = {
  "4xAA": { label: "4×AA", volts: 6.0, ohms: 0.6, maxA: 2 },
  "4xNiMH": { label: "4×NiMH", volts: 5.2, ohms: 0.12, maxA: 5 },
  "2S-LiPo": { label: "2S LiPo", volts: 8.4, ohms: 0.04, maxA: 20 },
  "9V": { label: "9 V", volts: 9.0, ohms: 1.7, maxA: 0.5 },
  custom: { label: "Battery", volts: 6.0, ohms: 0.1, maxA: 5 },
};

export const create: PartModelFactory = (ctx): PartModel => {
  const cfg = () => {
    const preset = BATTERY_PRESETS[str(ctx.props.preset, "4xAA")] ?? BATTERY_PRESETS["4xAA"]!;
    const v = num(ctx.props.voltage, 0);
    const r = num(ctx.props.internalResistance, 0);
    return { preset, volts: v > 0 ? v : preset.volts, ohms: Math.max(0.005, r > 0 ? r : preset.ohms) };
  };
  let c = cfg();
  let src: ElementId | undefined;
  let amps = 0;
  let volts = c.volts;

  return {
    stamp(b) {
      src = b.voltageSource(ctx.node("POS"), GROUND, c.volts, c.ohms, { id: "cell" });
    },
    onSolved(r) {
      amps = src ? r.current(src) : 0;
      volts = r.voltage(ctx.node("POS"));
    },
    visualState() {
      return {
        volts: round(volts, 3),
        currentmA: round(amps * 1000, 1),
        label: `${volts.toFixed(1)} V · ${Math.round(amps * 1000)} mA`,
        presetLabel: c.preset.label,
      };
    },
    setProp() {
      c = cfg();
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      if (amps > c.preset.maxA) {
        out.push({
          severity: "warning",
          code: "battery-overcurrent",
          message: `${ctx.id} (${c.preset.label}) delivers ${(amps * 1000).toFixed(0)} mA, more than it can sustain (${c.preset.maxA * 1000} mA): it sags to ${volts.toFixed(2)} V and drains fast. Use a pack with lower internal resistance (2S LiPo or NiMH) or smaller motors.`,
        });
      }
      if (amps < -0.01) {
        out.push({
          severity: "error",
          code: "battery-reverse-current",
          message: `${ctx.id} is being charged with ${(-amps * 1000).toFixed(0)} mA: another source with a higher voltage is wired to its POS. Never connect two supplies in parallel; give each its own load and share only GND.`,
        });
      }
      return out;
    },
  };
};
