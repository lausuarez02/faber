// TP4056 linear Li-ion charger + DW01/FS8205 protection, as the common USB-C module.
// Charging: a current source from VIN into BAT (trickle at 10 % below 2.9 V, then the set
// current), clamped at 4.2 V by a diode into a 4.2 V reference, which gives CC then CV with a
// tapering current. Ends when the cell takes less than 10 % of the set current; restarts below
// 4.05 V. Protection: OUT is connected to BAT through a switch that opens below 2.4 V and closes
// again above 3.0 V or while charging.
import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@faber/sim-core";
import { GROUND } from "@faber/sim-core";
import { clamp, num, round, truthy } from "../../lib/props.ts";

export const V_CHARGE = 4.2;
export const V_RECHARGE = 4.05;
export const V_TRICKLE = 2.9;
export const V_UVLO = 4.0;
export const V_PROTECT = 2.4;
export const V_RELEASE = 3.0;
/** A finished charge is not restarted for this long (the chip's recharge comparator filter; also stops a no-battery blink loop from re-solving every step). */
const RESTART_MS = 1000;

type Mode = "off" | "trickle" | "CC" | "CV" | "full";

export const create: PartModelFactory = (ctx): PartModel => {
  let usb = truthy(ctx.props.usb);
  let iSet = clamp(num(ctx.props.chargeCurrentmA, 1000), 10, 1000) / 1000;
  let mode: Mode = "off";
  let vin = 0;
  let vbat = 0;
  let chargeA = 0;
  let fullAt = -Infinity;
  let protectedOut = false;
  let srcEl: ElementId = "";
  let clampEl: ElementId = "";
  let outEl: ElementId = "";
  let outA = 0;
  let sawNoBattery = false;

  const charging = () => mode === "trickle" || mode === "CC" || mode === "CV";

  return {
    stamp(c) {
      const vinN = ctx.node("VIN");
      const bat = ctx.node("BAT");
      if (usb) c.voltageSource(vinN, GROUND, 5, 0.05, { id: "usb" });
      c.resistor(vinN, GROUND, 5 / 0.002, { id: "quiescent" }); // chip + LED ≈ 2 mA
      c.resistor(bat, GROUND, 1e6, { id: "leak" });
      if (charging()) {
        const i = mode === "trickle" ? iSet / 10 : iSet;
        srcEl = c.currentSource(vinN, bat, i, { id: "charge" });
        const ref = ctx.internalNode("ref");
        c.voltageSource(ref, GROUND, V_CHARGE - 0.005, 0.001, { id: "ref" });
        clampEl = c.diode(bat, ref, { vf: 0.005, rOn: 0.001 }, { id: "cv" });
      } else {
        srcEl = "";
        clampEl = "";
      }
      outEl = c.switch(bat, ctx.node("OUT"), !protectedOut, { id: "protect" });
    },
    onSolved(r, tMs) {
      vin = r.voltage(ctx.node("VIN")) - r.voltage(ctx.node("GND.1"));
      vbat = r.voltage(ctx.node("BAT"));
      const iSrc = srcEl ? r.current(srcEl) : 0;
      const iClamp = clampEl ? Math.max(0, r.current(clampEl)) : 0;
      chargeA = Math.max(0, iSrc - iClamp);
      outA = protectedOut ? 0 : r.current(outEl);
      const t = tMs ?? ctx.now();

      let next: Mode = mode;
      if (vin < V_UVLO || vin < vbat + 0.05) next = "off";
      else if (mode === "off") next = vbat < V_TRICKLE ? "trickle" : "CC";
      else if (mode === "trickle" && vbat >= V_TRICKLE) next = "CC";
      else if (mode === "CC" && iClamp > 0.001) next = "CV";
      else if (mode === "CV" && chargeA < iSet / 10) {
        next = "full";
        fullAt = t;
        sawNoBattery = vbat >= V_CHARGE - 0.05 && chargeA < 0.001;
      } else if (mode === "full" && vbat < V_RECHARGE && t - fullAt >= RESTART_MS) next = vbat < V_TRICKLE ? "trickle" : "CC";

      let changed = next !== mode;
      mode = next;
      const prot = protectedOut ? !(vbat > V_RELEASE || charging()) : vbat < V_PROTECT && !charging();
      if (prot !== protectedOut) {
        protectedOut = prot;
        changed = true;
      }
      if (changed) ctx.requestSolve();
    },
    tick(tMs) {
      // A finished charge may need to restart once the cell has dropped below 4.05 V.
      if (mode === "full" && tMs - fullAt >= RESTART_MS && vbat < V_RECHARGE) ctx.requestSolve();
    },
    visualState() {
      const ma = round(chargeA * 1000, 1);
      return {
        usb,
        mode,
        charging: charging(),
        full: mode === "full",
        chargemA: ma,
        protected: protectedOut,
        label: mode === "off" ? (usb || vin > 1 ? "no charge" : "no input") : mode === "full" ? "full" : `${mode} ${Math.round(ma)} mA`,
      };
    },
    setProp(id, v) {
      if (id === "usb") usb = truthy(v);
      if (id === "chargeCurrentmA") iSet = clamp(num(v, iSet * 1000), 10, 1000) / 1000;
    },
    interact(e) {
      if (e.kind === "press") usb = !usb;
      else if (e.kind === "set" && (e.key === undefined || e.key === "usb")) usb = truthy(e.value);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (vin > 8.2) out.push({ severity: "error", code: "tp4056-overvoltage", pin: "VIN", message: `${id} input is ${vin.toFixed(1)} V, above the TP4056's 8 V absolute maximum. Feed it 5 V (USB).` });
      else if (vin > 6) out.push({ severity: "warning", code: "tp4056-input-high", pin: "VIN", message: `${id} input is ${vin.toFixed(1)} V; it is a linear charger, so (VIN − battery) × current turns into heat (${((vin - Math.max(vbat, 3)) * iSet).toFixed(1)} W). Use 5 V.` });
      if (sawNoBattery && mode === "full") out.push({ severity: "info", code: "tp4056-no-battery", pin: "BAT", message: `${id} sees no battery on BAT / GND.2: with no cell its LEDs flicker and OUT is not a stable supply. Wire a LiPo: + to BAT (B+), − to GND.2 (B−).` });
      if (protectedOut) out.push({ severity: "warning", code: "tp4056-protected", pin: "OUT", message: `${id} has cut OUT off because the cell on BAT is below ${V_PROTECT} V or missing (over-discharge protection). Plug USB in to charge it; OUT comes back above ${V_RELEASE} V.` });
      if (outA > 3) out.push({ severity: "warning", code: "tp4056-overcurrent", pin: "OUT", message: `${id} OUT delivers ${outA.toFixed(1)} A; the protection trips at about 3 A on real modules. Reduce the load.` });
      return out;
    },
  };
};
