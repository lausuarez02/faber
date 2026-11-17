// Capacitive soil moisture probe v1.2: a 555 oscillator drives the probe's copper "plate"; the
// soil's permittivity loads it and an RC detector turns that into a voltage that falls as the soil
// gets wetter. Behavioural: AOUT is linear between a dry (air) and wet (water) voltage, scaled by
// the on-board 3.3 V regulator's output, behind ~10 kΩ.
import type { Diagnostic, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { GROUND } from "@fabwright/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

/** Fractions of the regulated 3.3 V seen in dry air and in water (≈ 2.9 V and ≈ 1.25 V). */
export const DRY_FRACTION = 0.88;
export const WET_FRACTION = 0.38;
export const R_OUT = 10_000;
const SUPPLY_MA = 5;
const MIN_VCC = 3.0;

/** Unloaded AOUT for a supply `vcc` and moisture `m` (0..100 %). */
export function soilVolts(vcc: number, m: number): number {
  if (vcc < MIN_VCC) return 0;
  const vreg = Math.min(3.3, vcc - 0.15); // 662K-class LDO, ~150 mV dropout
  const f = DRY_FRACTION - ((DRY_FRACTION - WET_FRACTION) * clamp(m, 0, 100)) / 100;
  return vreg * f;
}

export const create: PartModelFactory = (ctx): PartModel => {
  let moisture = clamp(num(ctx.props.moisture, 40), 0, 100);
  let vcc = 0;
  let stamped = -1;
  return {
    stamp(c) {
      c.resistor(ctx.node("VCC"), GROUND, 5 / (SUPPLY_MA / 1000), { id: "supply" });
      stamped = soilVolts(vcc, moisture);
      if (stamped > 0) c.voltageSource(ctx.node("AOUT"), GROUND, stamped, R_OUT, { id: "aout" });
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      if (Math.abs(soilVolts(vcc, moisture) - stamped) > 0.002) ctx.requestSolve();
    },
    visualState() {
      const v = soilVolts(vcc, moisture);
      return {
        moisture: round(moisture, 1),
        volts: round(v, 3),
        label: `${Math.round(moisture)} % · ${v.toFixed(2)} V`,
        wetOpacity: round((0.6 * moisture) / 100, 3),
        powered: vcc >= MIN_VCC,
      };
    },
    setProp(id, v) {
      if (id === "moisture") moisture = clamp(num(v, moisture), 0, 100);
    },
    interact(e) {
      if (e.kind === "set" && (e.key === undefined || e.key === "moisture")) {
        const v = Number(e.value);
        if (Number.isFinite(v)) moisture = clamp(v, 0, 100);
      }
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      if (vcc > 5.6) out.push({ severity: "error", code: "soil-overvoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V, above 5.5 V: the regulator and the 555 overheat. Wire VCC to 5V or 3V3.` });
      else if (vcc > 0.3 && vcc < MIN_VCC) out.push({ severity: "warning", code: "soil-undervoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V, too low for its oscillator (needs 3.3 to 5.5 V), so AOUT reads 0. Wire VCC to 3V3 or 5V.` });
      return out;
    },
  };
};
