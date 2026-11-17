// IP5306-class LiPo charger + 5 V boost on one module (round 8, parts-advice). The charger is the
// TP4056 model's scheme (a current source VIN → BAT clamped at 4.2 V: trickle, CC, CV, full); the
// output is sim-core's switching regulator from BAT to OUT (5 V, 90 %). OUT turns off below a 3.0 V
// cell (low-battery cut-off) and, as on the real chip, after 32 s with less than 45 mA drawn
// (light-load auto-off); a KEY press or plugging USB turns it back on. Deterministic: time is
// the simulation's virtual time.
import type { Diagnostic, ElementId, PartModel, PartModelFactory, RegulatorState } from "@fabwright/sim-core";
import { GROUND } from "@fabwright/sim-core";
import { clamp, num, round, truthy } from "../../lib/props.ts";
import { V_CHARGE, V_RECHARGE, V_TRICKLE, V_UVLO } from "../tp4056-charger/model.ts";

type Mode = "off" | "trickle" | "CC" | "CV" | "full";
type Off = "" | "low battery" | "auto-off";
const RESTART_MS = 1000;
/** Back on after a low-battery cut-off once the cell recovers above this (or USB is plugged). */
const V_RESUME = 3.3;

export const create: PartModelFactory = (ctx): PartModel => {
  const lim = (ctx.spec.limits ?? {}) as Record<string, number>;
  const vOut = lim.outputVoltage ?? 5;
  const eff = lim.efficiency ?? 0.9;
  const vCut = lim.cutoffVoltage ?? 3.0;
  const autoOffA = (lim.autoOffmA ?? 45) / 1000;
  const autoOffMs = lim.autoOffMs ?? 32000;
  let usb = truthy(ctx.props.usb);
  let autoOff = truthy(ctx.props.auto_off ?? true);
  let iSet = clamp(num(ctx.props.chargeCurrentmA, 2000), 10, 2400) / 1000;
  let mode: Mode = "off";
  let off: Off = "";
  let vin = 0;
  let vbat = 0;
  let chargeA = 0;
  let outA = 0;
  let vo = 0;
  let fullAt = -Infinity;
  let lightSince: number | undefined;
  let srcEl: ElementId = "";
  let clampEl: ElementId = "";
  let regEl: ElementId = "";
  let regState: RegulatorState = "off";
  let autoOffs = 0;
  let cutoffs = 0;

  const charging = () => mode === "trickle" || mode === "CC" || mode === "CV";

  return {
    stamp(c) {
      const vinN = ctx.node("VIN");
      const bat = ctx.node("BAT");
      if (usb) c.voltageSource(vinN, GROUND, 5, 0.05, { id: "usb" });
      c.resistor(vinN, GROUND, 5 / 0.002, { id: "quiescent" });
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
      regEl = "";
      if (!off && c.regulator) regEl = c.regulator(bat, ctx.node("OUT"), { volts: vOut, kind: "switching", efficiency: eff, iq: (lim.noLoadmA ?? 1) / 1000, minIn: 2.5, dropout: 0.4, rOut: 0.05 }, { id: "boost" });
    },
    onSolved(r, tMs) {
      const t = tMs ?? ctx.now();
      vin = r.voltage(ctx.node("VIN")) - r.voltage(ctx.node("GND.1"));
      vbat = r.voltage(ctx.node("BAT"));
      vo = r.voltage(ctx.node("OUT"));
      const iSrc = srcEl ? r.current(srcEl) : 0;
      const iClamp = clampEl ? Math.max(0, r.current(clampEl)) : 0;
      chargeA = Math.max(0, iSrc - iClamp);
      regState = regEl ? (r.regulatorState?.(regEl) ?? "off") : "off";
      outA = regEl ? Math.max(0, r.current(regEl)) : 0;

      let next: Mode = mode;
      if (vin < V_UVLO || vin < vbat + 0.05) next = "off";
      else if (mode === "off") next = vbat < V_TRICKLE ? "trickle" : "CC";
      else if (mode === "trickle" && vbat >= V_TRICKLE) next = "CC";
      else if (mode === "CC" && iClamp > 0.001) next = "CV";
      else if (mode === "CV" && chargeA < iSet / 10) {
        next = "full";
        fullAt = t;
      } else if (mode === "full" && vbat < V_RECHARGE && t - fullAt >= RESTART_MS) next = vbat < V_TRICKLE ? "trickle" : "CC";
      let changed = next !== mode;
      mode = next;

      const powered = vin >= V_UVLO;
      let nextOff: Off = off;
      if (powered) nextOff = ""; // USB in: the output runs and every off state clears
      else if (!off && vbat < vCut) nextOff = "low battery";
      else if (off === "low battery" && vbat > V_RESUME) nextOff = "";
      // light-load auto-off (battery only)
      if (!powered && !nextOff && autoOff && outA < autoOffA) {
        lightSince ??= t;
        if (t - lightSince >= autoOffMs) nextOff = "auto-off";
      } else lightSince = undefined;
      if (nextOff !== off) {
        if (nextOff === "auto-off") autoOffs++;
        if (nextOff === "low battery") cutoffs++;
        off = nextOff;
        if (off) lightSince = undefined;
        changed = true;
      }
      if (changed) ctx.requestSolve();
    },
    tick(tMs) {
      if (mode === "full" && tMs - fullAt >= RESTART_MS && vbat < V_RECHARGE) ctx.requestSolve();
      // the auto-off timer runs on virtual time even when nothing else changes
      if (lightSince !== undefined && !off && tMs - lightSince >= autoOffMs) ctx.requestSolve();
    },
    visualState() {
      const on = !off && regState !== "off";
      return {
        usb,
        mode,
        charging: charging(),
        full: mode === "full",
        chargemA: round(chargeA * 1000, 1),
        outOn: on,
        off,
        outmA: round(outA * 1000, 1),
        label: on ? `${vo.toFixed(2)} V · ${Math.round(outA * 1000)} mA` : off ? `off (${off})` : "off",
      };
    },
    setProp(id, v) {
      if (id === "usb") usb = truthy(v);
      if (id === "chargeCurrentmA") iSet = clamp(num(v, iSet * 1000), 10, 2400) / 1000;
      if (id === "auto_off") {
        autoOff = truthy(v);
        if (!autoOff && off === "auto-off") off = "";
      }
    },
    interact(e) {
      // press = the KEY button (a short press wakes the output); set usb plugs the cable
      if (e.kind === "press") {
        if (off === "auto-off" || (off === "low battery" && vbat > vCut)) off = "";
        lightSince = undefined;
      } else if (e.kind === "set" && (e.key === undefined || e.key === "usb")) usb = truthy(e.value);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (vin > 6) out.push({ severity: "error", code: "charge-boost-overvoltage", pin: "VIN", message: `${id} input is ${vin.toFixed(1)} V. Why: the IP5306 takes 4.5 to 5.5 V on IN+; more damages it. Fix: feed it 5 V (USB).` });
      if (autoOffs) out.push({ severity: "warning", code: "charge-boost-auto-off", pin: "OUT", message: `${id} switched its 5 V output off (${autoOffs}×): the load stayed under about ${Math.round(autoOffA * 1000)} mA for ${autoOffMs / 1000} s. Why: the IP5306 is a power-bank chip and takes a light load for a full phone. Fix: press its KEY to wake it (interact press; a GPIO through 2 kΩ to KEY can pulse it every 20 s), use the I2C version with auto-off disabled (prop auto_off false), or use a TP4056 + boost (or no boost: 3.3 V boards run from the cell through a diode).` });
      if (cutoffs) out.push({ severity: "warning", code: "charge-boost-low-battery", pin: "OUT", message: `${id} cut its output at a ${vCut} V cell (low battery). Why: it protects the cell from over-discharge. Fix: charge it (plug USB); have the firmware warn before this.` });
      if (regState === "off" && !off && vbat > 0.5 && vbat < 2.5) out.push({ severity: "warning", code: "charge-boost-no-cell", pin: "BAT", message: `${id} has no usable cell on BAT (${vbat.toFixed(2)} V). Why: the boost runs from the cell. Fix: wire a LiPo: + to BAT, − to GND.2.` });
      if (outA > 2.1) out.push({ severity: "warning", code: "charge-boost-overcurrent", pin: "OUT", message: `${id} delivers ${outA.toFixed(2)} A on OUT. Why: the IP5306's 5 V output is good for about 2 A; above that it current-limits and the 5 V sags. Fix: reduce the load or power the motors from their own supply.` });
      return out;
    },
  };
};
