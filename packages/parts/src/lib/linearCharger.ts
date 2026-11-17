// A linear Li-ion charger built into a board (round 10): the SGM40567 on the XIAO ESP32-S3, the
// ETA4054 on the XIAO ESP32-C3. Same method as the TP4056 module model: a current source from the
// input into the cell (trickle below 2.9 V, then the set current), clamped at 4.2 V by a diode into
// a 4.2 V reference (CC, then CV with a tapering current); ends below a tenth of the set current
// and restarts below 4.05 V. Generic: any board names its own input / battery nodes and currents.
import type { CircuitBuilder, ElementId, NodeId, SolveResultView } from "@fabwright/sim-core";
import { GROUND } from "@fabwright/sim-core";

export interface LinearChargerSpec {
  /** Fast (constant-current) charge current, A. */
  chargeA: number;
  /** Pre-charge (trickle) current below `trickleBelowV`, A. */
  trickleA: number;
  trickleBelowV?: number;
  /** Charge voltage (CV), V. Default 4.2. */
  vFull?: number;
  /** Restart a finished charge below this, V. Default 4.05. */
  vRecharge?: number;
  /** The input must be this much above the cell to charge (UVLO / headroom), V. Default 4.0 absolute. */
  vInMin?: number;
}

export type ChargerMode = "off" | "trickle" | "CC" | "CV" | "full";

const RESTART_MS = 1000;

export interface LinearCharger {
  stamp(c: CircuitBuilder, input: NodeId, bat: NodeId, ref: NodeId): void;
  /** After a solve: returns true when the mode changed (the caller requests another solve). */
  onSolved(r: SolveResultView, input: NodeId, bat: NodeId, tMs: number): boolean;
  /** For tick(): true when a finished charge should restart now. */
  wantsRestart(tMs: number): boolean;
  readonly mode: ChargerMode;
  readonly chargemA: number;
  readonly charging: boolean;
}

export function createLinearCharger(spec: LinearChargerSpec): LinearCharger {
  const vFull = spec.vFull ?? 4.2;
  const vRecharge = spec.vRecharge ?? 4.05;
  const vTrickle = spec.trickleBelowV ?? 2.9;
  const vInMin = spec.vInMin ?? 4.0;
  let mode: ChargerMode = "off";
  let srcEl: ElementId = "";
  let clampEl: ElementId = "";
  let chargeA = 0;
  let vbat = 0;
  let fullAt = -Infinity;
  const charging = () => mode === "trickle" || mode === "CC" || mode === "CV";
  return {
    get mode() {
      return mode;
    },
    get chargemA() {
      return Math.round(chargeA * 10000) / 10;
    },
    get charging() {
      return charging();
    },
    stamp(c, input, bat, ref) {
      if (!charging()) {
        srcEl = "";
        clampEl = "";
        return;
      }
      srcEl = c.currentSource(input, bat, mode === "trickle" ? spec.trickleA : spec.chargeA, { id: "charger" });
      c.voltageSource(ref, GROUND, vFull - 0.005, 0.001, { id: "charger:ref" });
      clampEl = c.diode(bat, ref, { vf: 0.005, rOn: 0.001 }, { id: "charger:cv" });
    },
    onSolved(r, input, bat, tMs) {
      const vin = r.voltage(input);
      vbat = r.voltage(bat);
      const iSrc = srcEl ? r.current(srcEl) : 0;
      const iClamp = clampEl ? Math.max(0, r.current(clampEl)) : 0;
      chargeA = Math.max(0, iSrc - iClamp);
      let next = mode;
      if (vin < vInMin || vin < vbat + 0.05 || vbat < 0.5) next = "off";
      else if (mode === "off") next = vbat < vTrickle ? "trickle" : vbat >= vFull - 0.02 ? "full" : "CC";
      else if (mode === "trickle" && vbat >= vTrickle) next = "CC";
      else if (mode === "CC" && iClamp > spec.chargeA / 50) next = "CV";
      else if (mode === "CV" && chargeA < spec.chargeA / 10) {
        next = "full";
        fullAt = tMs;
      } else if (mode === "full" && vbat < vRecharge && tMs - fullAt >= RESTART_MS) next = vbat < vTrickle ? "trickle" : "CC";
      const changed = next !== mode;
      if (next === "full" && mode !== "full") fullAt = tMs;
      mode = next;
      return changed;
    },
    wantsRestart(tMs) {
      return mode === "full" && tMs - fullAt >= RESTART_MS && vbat < vRecharge;
    },
  };
}
