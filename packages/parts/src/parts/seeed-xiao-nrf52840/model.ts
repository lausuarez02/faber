import { GROUND, type Diagnostic, type ElementId, type PartModel, type PartModelFactory } from "@fabwright/sim-core";
import { createRenodeBoardModel, limitOf, NRF52_GPIO } from "../../lib/renodeBoard.ts";

/**
 * Seeed XIAO nRF52840: nRF52 pads (lib/renodeBoard.ts), the RGB LED (P0.26 / P0.30 / P0.06, lit when
 * LOW) and the board's power: USB (power.usb) is 5 V on the 5V pin, the LDO makes 3.3 V; a LiPo on
 * BAT+ / BAT- runs the board when USB is unplugged (an ideal power path into the 5V node) and is
 * charged by the on-board BQ25101 while USB is plugged:
 *   CC  50 mA (HICHG P0.13 floating or HIGH) or 100 mA (P0.13 driven LOW), 10 % below 3.0 V
 *   CV  4.2 V, done when the current tapers under 10 % of the set current (recharge below 4.1 V)
 *   ~CHG (P0.17) is LOW while charging, the charge LED follows it
 * The battery divider (1 MΩ / 510 kΩ) puts VBAT x 510 / 1510 on P0.31 (AIN7) while P0.14 is LOW.
 */
export const RAILS: Record<string, number> = { "5V": 5, "3V3": 3.3 };

export const V_CHARGE = 4.2;
export const V_RECHARGE = 4.1;
export const V_PRECHARGE = 3.0;
export const DIVIDER = 510 / 1510;

/** "none": USB is in but nothing is on BAT+ (a real BQ25101 then blinks ~CHG; here it stays off). */
type Mode = "off" | "none" | "pre" | "CC" | "CV" | "full";

export const create: PartModelFactory = (ctx): PartModel => {
  const base = createRenodeBoardModel(ctx, {
    rails: RAILS,
    ...NRF52_GPIO,
    supply: {
      usbPin: "5V",
      diodes: [{ id: "power-path", from: "BAT+", to: "5V", vf: 0.05, rOn: 0.1 }],
      regulators: [{ id: "ldo", from: "5V", to: "3V3", params: { volts: 3.3, dropout: limitOf(ctx, "ldoDropoutV", 0.25), rOut: 0.01, iq: 0.00005, minIn: 1 } }],
      logicPin: "3V3",
      minLogicV: limitOf(ctx, "min3v3V", 1.7),
      selfmA: ctx.spec.current_ma?.typ ?? 10,
    },
    leds: [
      { key: "led_r", pin: "LED_RED", activeLow: true },
      { key: "led_g", pin: "LED_GREEN", activeLow: true },
      { key: "led_b", pin: "LED_BLUE", activeLow: true },
    ],
  });
  let mode: Mode = "off";
  let vbat = 0;
  let v5 = 0;
  let chargeA = 0;
  let srcEl: ElementId = "";
  let clampEl: ElementId = "";
  let noBattery = false;
  const usbOn = () => ctx.power?.usb !== false;
  const charging = () => mode === "pre" || mode === "CC" || mode === "CV";
  const iSet = (): number => {
    const hichg = ctx.mcu?.readPin("HICHG");
    const high = hichg?.mode === "output" && hichg.value === 0;
    return (high ? limitOf(ctx, "chargeHighmA", 100) : limitOf(ctx, "chargeLowmA", 50)) / 1000;
  };

  return {
    ...base,
    stamp(c) {
      base.stamp(c);
      const bat = ctx.node("BAT+");
      c.resistor(bat, GROUND, 1e7, { id: "bat-leak" });
      if (charging()) {
        srcEl = c.currentSource(ctx.node("5V"), bat, mode === "pre" ? iSet() / 10 : iSet(), { id: "charge" });
        const ref = ctx.internalNode("vref");
        c.voltageSource(ref, GROUND, V_CHARGE - 0.005, 0.001, { id: "cv-ref" });
        clampEl = c.diode(bat, ref, { vf: 0.005, rOn: 0.001 }, { id: "cv" });
      } else {
        srcEl = "";
        clampEl = "";
      }
    },
    onSolved(r, tMs) {
      base.onSolved?.(r, tMs);
      v5 = r.voltage(ctx.node("5V"));
      vbat = r.voltage(ctx.node("BAT+")) - r.voltage(ctx.node("BAT-"));
      const iSrc = srcEl ? r.current(srcEl) : 0;
      const iClamp = clampEl ? Math.max(0, r.current(clampEl)) : 0;
      chargeA = Math.max(0, iSrc - iClamp);
      let next: Mode = mode;
      const usb = usbOn() && v5 > 4.3;
      if (!usb) next = "off";
      else if (vbat < 1 && !charging()) next = "none";
      else if (mode === "off" || mode === "none") next = vbat < V_PRECHARGE ? "pre" : vbat < V_RECHARGE ? "CC" : "full";
      else if (mode === "pre" && vbat >= V_PRECHARGE) next = "CC";
      else if (mode === "CC" && iClamp > 0.0005) next = "CV";
      else if (mode === "CV" && chargeA < iSet() / 10) next = "full";
      else if (charging() && chargeA < 0.0001 && iClamp > iSet() * 0.99) next = "none"; // all of it into the clamp: no cell
      else if (mode === "full" && vbat < V_RECHARGE - 0.05) next = "CC";
      noBattery = next === "none" || (!usb && vbat < 1);
      // The charger's status and the battery divider reach the MCU's own pins (not on the headers).
      const mcu = ctx.mcu;
      if (mcu) {
        mcu.setPinInput("CHG", charging() ? 0 : 3.3);
        const en = mcu.readPin("VBAT_ENABLE");
        mcu.setPinInput("VBAT", en.mode === "output" && en.value === 0 ? Math.max(0, vbat) * DIVIDER : 0);
      }
      if (next !== mode) {
        mode = next;
        ctx.requestSolve();
      }
    },
    visualState() {
      const ma = Math.round(chargeA * 10000) / 10;
      const battery = noBattery ? "no battery" : charging() ? `charging ${Math.round(ma)} mA` : mode === "full" ? "full" : vbat > 2 ? `on battery ${vbat.toFixed(2)} V` : "no battery";
      return { ...base.visualState(), charging: charging() ? 1 : 0, chargemA: ma, battery };
    },
    diagnostics() {
      const out: Diagnostic[] = [...(base.diagnostics?.() ?? [])];
      if (vbat > 4.35) out.push({ severity: "error", code: "xiao-battery-overvoltage", pin: "BAT+", message: `${ctx.id} BAT+ is at ${vbat.toFixed(2)} V, above a LiPo's 4.2 V full charge. Why: something other than a single 3.7 V LiPo cell is on the BAT pads. Fix: wire one 1S LiPo (+ to BAT+, - to BAT-) and nothing else.` });
      return out;
    },
  };
};
