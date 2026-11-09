// 1S LiPo cell: open-circuit voltage from a state-of-charge table, internal resistance that grows
// as the cell empties, coulomb counting every 1 ms tick (discharge and charge), and the DW01-style
// protection board that cuts the cell off below 2.5 V and reconnects when a charger lifts it.
import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@jumper/sim-core";
import { GROUND } from "@jumper/sim-core";
import { clamp, num, round, truthy } from "../../lib/props.ts";

/** Resting voltage vs state of charge for a LiPo / Li-ion polymer cell at 25 °C (typical curve). */
export const OCV_TABLE: readonly (readonly [number, number])[] = [
  [0, 3.27], [5, 3.61], [10, 3.69], [15, 3.71], [20, 3.73], [25, 3.75], [30, 3.77], [35, 3.79],
  [40, 3.8], [45, 3.82], [50, 3.84], [55, 3.85], [60, 3.87], [65, 3.91], [70, 3.95], [75, 3.98],
  [80, 4.02], [85, 4.08], [90, 4.11], [95, 4.15], [100, 4.2],
];

export function ocv(soc: number): number {
  const s = clamp(soc, 0, 100);
  for (let i = 1; i < OCV_TABLE.length; i++) {
    const [s1, v1] = OCV_TABLE[i]!;
    if (s <= s1) {
      const [s0, v0] = OCV_TABLE[i - 1]!;
      return v0 + ((v1 - v0) * (s - s0)) / (s1 - s0);
    }
  }
  return 4.2;
}

/** Internal resistance (Ω): ~0.15 Ω for 500 mAh, inversely with capacity, up to 2× when nearly empty. */
export function internalOhms(capacityMah: number, soc: number): number {
  const base = clamp(75 / capacityMah, 0.02, 2);
  return base * (soc < 20 ? 1 + (20 - soc) / 20 : 1);
}

export const CUTOFF_V = 2.5;

export const create: PartModelFactory = (ctx): PartModel => {
  let cap = clamp(num(ctx.props.capacity, 500), 10, 100_000);
  let soc = clamp(num(ctx.props.soc, 100), 0, 100);
  let protection = ctx.props.protection === undefined ? true : truthy(ctx.props.protection);
  let speedup = clamp(num(ctx.props.speedup, 1), 1, 100_000);
  let src: ElementId | undefined;
  let amps = 0;
  let volts = ocv(soc);
  let stampedOcv = ocv(soc);
  let usedMah = 0;
  let cutoff = false;
  let maxDischargeA = 0;
  let maxChargeA = 0;
  let lastT: number | undefined;

  return {
    stamp(c) {
      if (cutoff) {
        // Disconnected by the protection FETs: only a high-value path, so a charger can be seen.
        src = undefined;
        c.resistor(ctx.node("POS"), GROUND, 1e6, { id: "cut" });
        return;
      }
      stampedOcv = ocv(soc);
      src = c.voltageSource(ctx.node("POS"), GROUND, stampedOcv, internalOhms(cap, soc), { id: "cell" });
    },
    onSolved(r) {
      volts = r.voltage(ctx.node("POS"));
      amps = src ? r.current(src) : 0;
      if (amps > maxDischargeA) maxDischargeA = amps;
      if (-amps > maxChargeA) maxChargeA = -amps;
      if (protection) {
        if (!cutoff && amps > 0 && volts < CUTOFF_V) {
          cutoff = true;
          ctx.requestSolve();
        } else if (cutoff && volts > ocv(soc) + 0.1) {
          // A charger pulls the pack above the cell: the protection board reconnects.
          cutoff = false;
          ctx.requestSolve();
        }
      }
    },
    tick(tMs, dtMs) {
      const dt = (lastT === undefined ? dtMs : Math.max(0, tMs - lastT)) / 1000;
      lastT = tMs;
      if (dt <= 0 || amps === 0) return;
      const mah = ((amps * 1000 * dt) / 3600) * speedup;
      usedMah += mah;
      soc = clamp(soc - (mah / cap) * 100, 0, 100);
      if (Math.abs(ocv(soc) - stampedOcv) > 0.002) ctx.requestSolve();
    },
    visualState() {
      const fill = soc > 40 ? "#5CF2A1" : soc > 15 ? "#FFB23F" : "#FF3B2F";
      const fast = speedup > 1 ? ` · ×${Math.round(speedup)}` : "";
      return {
        volts: round(volts, 3),
        soc: round(soc, 2),
        currentmA: round(amps * 1000, 1),
        usedmAh: round(usedMah, 3),
        charging: amps < -0.0005,
        cutoff,
        label: cutoff ? `cut off · ${Math.round(soc)} %` : `${volts.toFixed(2)} V · ${Math.round(soc)} %${fast}`,
        fillWidth: round((84 * soc) / 100, 1),
        fillColor: fill,
      };
    },
    setProp(id, v) {
      if (id === "capacity") cap = clamp(num(v, cap), 10, 100_000);
      if (id === "soc") soc = clamp(num(v, soc), 0, 100);
      if (id === "protection") {
        protection = truthy(v);
        if (!protection) cutoff = false;
      }
      if (id === "speedup") speedup = clamp(num(v, speedup), 1, 100_000);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (cutoff) {
        out.push({ severity: "warning", code: "lipo-cutoff", message: `${id} is empty: its protection board disconnected it below ${CUTOFF_V} V, so everything on it is off. Recharge it (TP4056), and make the firmware shut down at about 3.3 V so it never gets this low.` });
      } else if (!protection && volts < CUTOFF_V && amps > 0) {
        out.push({ severity: "error", code: "lipo-overdischarge", message: `${id} is at ${volts.toFixed(2)} V with no protection board: below 2.5 V a LiPo is damaged and can swell or catch fire when recharged. Use a protected cell and shut down at 3.3 V.` });
      } else if (volts < 3.0 && amps > 0) {
        out.push({ severity: "warning", code: "lipo-low", message: `${id} is at ${volts.toFixed(2)} V (${Math.round(soc)} %), below 3.0 V under load. Stop drawing current: shut down in firmware at about 3.3 V (read the battery voltage through a divider on an analog pin).` });
      }
      if (maxDischargeA * 1000 > 2 * cap) {
        out.push({ severity: "warning", code: "lipo-overcurrent", message: `${id} (${cap} mAh) delivered ${(maxDischargeA * 1000).toFixed(0)} mA, more than 2C (${2 * cap} mA) for a small pouch cell: it sags and heats up. Use a bigger cell or reduce the load (motors, LEDs at full white).` });
      }
      if (maxChargeA * 1000 > 1.05 * cap) {
        out.push({ severity: "warning", code: "lipo-fast-charge", message: `${id} (${cap} mAh) was charged at ${(maxChargeA * 1000).toFixed(0)} mA, above 1C (${cap} mA). Lower the charger's current: on a TP4056 set chargeCurrentmA to ${cap} or less (R_PROG ${cap >= 1000 ? "1.2" : cap >= 580 ? "2" : cap >= 400 ? "3" : cap >= 250 ? "5" : "10"} kΩ).` });
      }
      if (volts > 4.25 && amps < 0) {
        out.push({ severity: "error", code: "lipo-overcharge", message: `${id} is being charged to ${volts.toFixed(2)} V, above 4.2 V: that damages a LiPo. Charge it only through a LiPo charger (TP4056), never from 5 V directly.` });
      }
      return out;
    },
  };
};
