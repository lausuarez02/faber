// FC-51 class IR obstacle sensor: IR LED, photodiode, LM393 comparator with a trimmer. OUT has a
// 10 kΩ pull-up and is pulled LOW when the reflected IR beats the threshold. Behavioural: an
// object is detected when distance ≤ threshold × the surface's reflectivity.
import type { Diagnostic, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { GROUND } from "@fabwright/sim-core";
import { clamp, num, round, str, truthy } from "../../lib/props.ts";

export const REFLECTIVITY: Record<string, number> = { white: 1, grey: 0.6, black: 0.2 };
const MIN_VCC = 3.0;
/** IR LED (~20 mA) + power LED. */
const SUPPLY_MA = 23;

export const create: PartModelFactory = (ctx): PartModel => {
  let distance = clamp(num(ctx.props.distance, 0), 0, 500);
  let threshold = clamp(num(ctx.props.threshold, 10), 2, 30);
  let surface = str(ctx.props.surface, "white");
  let vcc = 0;
  let powered = false;

  const range = () => threshold * (REFLECTIVITY[surface] ?? 1);
  const sees = () => distance > 0 && distance <= range();
  const obstacle = () => powered && sees();

  return {
    stamp(c) {
      const v = ctx.node("VCC");
      c.resistor(v, GROUND, 5 / (SUPPLY_MA / 1000), { id: "supply" });
      c.resistor(ctx.node("OUT"), v, 10_000, { id: "pullup" });
      if (obstacle()) {
        c.voltageSource(ctx.node("OUT"), GROUND, 0, 20, { id: "comparator" });
        c.resistor(v, GROUND, Math.max(vcc, 1) / 0.003, { id: "obstacle-led" });
      }
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const p = vcc >= MIN_VCC;
      if (p !== powered) {
        powered = p;
        ctx.requestSolve();
      }
    },
    visualState() {
      const o = obstacle();
      return {
        obstacle: o,
        distance: round(distance, 2),
        label: !powered ? "no power" : o ? `obstacle ${Math.round(distance)} cm` : "clear",
        powered,
      };
    },
    setProp(id, v) {
      if (id === "distance") distance = clamp(num(v, distance), 0, 500);
      if (id === "threshold") threshold = clamp(num(v, threshold), 2, 30);
      if (id === "surface") surface = str(v, "white");
    },
    interact(e) {
      // press = an object appears at half the trigger distance; release = gone.
      if (e.kind === "press") distance = range() / 2;
      else if (e.kind === "release") distance = 0;
      else if (e.kind === "set") {
        if (e.key === "obstacle") distance = truthy(e.value) ? range() / 2 : 0;
        else if (e.key === undefined || e.key === "distance" || e.key === "distance_cm") {
          const v = Number(e.value);
          distance = Number.isFinite(v) ? clamp(v, 0, 500) : 0;
        }
      }
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      if (vcc > 5.6) out.push({ severity: "error", code: "ir-overvoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V, above 5.5 V. Wire VCC to 5V or 3V3.` });
      else if (!powered && vcc > 0.3) out.push({ severity: "warning", code: "ir-undervoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V (needs 3.3 to 5 V), so OUT never goes LOW. Wire VCC to 3V3 or 5V.` });
      return out;
    },
  };
};
