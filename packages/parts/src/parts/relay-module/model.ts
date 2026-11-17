// 1-channel 5 V relay module. Control side: an optocoupler (or transistor) input on IN, the coil
// (~71 Ω) on VCC. The coil pulls in after ~10 ms when the input current flows and VCC ≥ 3.75 V,
// and releases ~5 ms after it stops. Load side: COM–NO / COM–NC contacts as switches.
import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { GROUND } from "@fabwright/sim-core";
import { round, str } from "../../lib/props.ts";

export const COIL_OHMS = 70;
export const PULL_IN_V = 3.75;
/** Below this the energized coil drops out (datasheet: release voltage ≥ 10 % of 5 V). */
export const DROP_OUT_V = 0.5;
export const OPERATE_MS = 10;
export const RELEASE_MS = 5;
/** Input current that turns the optocoupler / transistor on. */
export const ON_MA = 0.8;
const CONTACT_MAX_A = 10;

export const create: PartModelFactory = (ctx): PartModel => {
  let activeLow = str(ctx.props.trigger, "low") !== "high";
  let energized = false;
  let target = false;
  let cancel: (() => void) | undefined;
  let vcc = 0;
  let vin = 0;
  let inputMa = 0;
  let inEl: ElementId = "";
  let contactEl: ElementId = "";
  let loadA = 0;
  let clicks = 0;
  let wantedButLow = false;

  const apply = (on: boolean) => {
    if (on && !energized) clicks++;
    energized = on;
    ctx.requestSolve();
  };

  return {
    stamp(c) {
      const v = ctx.node("VCC");
      const m = ctx.internalNode("in");
      // Power LED (~2 mA) and, when energized, the coil.
      c.resistor(v, GROUND, 2500, { id: "power-led" });
      if (energized) c.resistor(v, GROUND, COIL_OHMS, { id: "coil" });
      if (activeLow) {
        // VCC → 1 kΩ → optocoupler LED → IN: current flows while IN is pulled low.
        c.resistor(v, m, 1000, { id: "in-r" });
        inEl = c.diode(m, ctx.node("IN"), { vf: 1.15, rOn: 10 }, { id: "opto" });
      } else {
        // IN → 1 kΩ → transistor base → GND.
        c.resistor(ctx.node("IN"), m, 1000, { id: "in-r" });
        inEl = c.diode(m, GROUND, { vf: 0.7, rOn: 10 }, { id: "base" });
      }
      contactEl = c.switch(ctx.node("COM"), ctx.node("NO"), energized, { id: "no" });
      const nc = c.switch(ctx.node("COM"), ctx.node("NC"), !energized, { id: "nc" });
      if (!energized) contactEl = nc;
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      vin = r.voltage(ctx.node("IN"));
      inputMa = Math.max(0, r.current(inEl)) * 1000;
      loadA = Math.abs(r.current(contactEl));
      const drive = inputMa > ON_MA;
      wantedButLow = drive && !energized && vcc < PULL_IN_V;
      const want = drive && (energized ? vcc >= DROP_OUT_V : vcc >= PULL_IN_V);
      if (want === target) return;
      target = want;
      cancel?.();
      cancel = undefined;
      if (!ctx.schedule) {
        if (want !== energized) apply(want);
        return;
      }
      if (want === energized) return;
      cancel = ctx.schedule(want ? OPERATE_MS : RELEASE_MS, () => {
        cancel = undefined;
        apply(target);
      });
    },
    visualState() {
      const loadmA = round(loadA * 1000, 1);
      return {
        energized,
        contact: energized ? "NO" : "NC",
        armTransform: energized ? "rotate(-28 118 55)" : "rotate(28 118 55)",
        coilmA: energized ? round((vcc / COIL_OHMS) * 1000, 1) : 0,
        loadmA,
        clicks,
        label: `${energized ? "ON" : "OFF"}${loadmA >= 0.5 ? ` · ${Math.round(loadmA)} mA` : ""}`,
      };
    },
    setProp(id, v) {
      if (id === "trigger") activeLow = str(v, "low") !== "high";
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (wantedButLow || (inputMa > ON_MA && !energized && vcc < PULL_IN_V)) {
        out.push({
          severity: "error",
          code: "relay-undervoltage",
          pin: "VCC",
          message: `${id} is told to switch on but its VCC is ${vcc.toFixed(2)} V; the 5 V coil needs at least ${PULL_IN_V} V to pull in, so it never clicks. Wire ${id}.VCC to 5V (VBUS / VSYS on a 3.3 V board) and share GND; IN can stay on the GPIO.`,
        });
      }
      if (activeLow && vcc >= 4.5 && vin > 2.0 && vin < 4.2 && inputMa <= ON_MA) {
        out.push({
          severity: "warning",
          code: "relay-3v3-input",
          pin: "IN",
          message: `${id} is active-low on 5 V but its IN only goes up to ${vin.toFixed(1)} V (a 3.3 V GPIO). About ${(((vcc - vin - 1.15) / 1000) * 1000).toFixed(2)} mA still flows through the optocoupler, so on many modules the relay never fully turns off. Use an active-high module, power the optocoupler side from 3.3 V (JD-VCC jumper removed), or add an NPN transistor.`,
        });
      }
      if (loadA > CONTACT_MAX_A) {
        out.push({
          severity: "error",
          code: "relay-contact-overcurrent",
          message: `${id}'s contacts carry ${loadA.toFixed(1)} A, above their 10 A rating: they weld or burn. Use a bigger relay or a contactor, or reduce the load.`,
        });
      }
      if (vcc > 5.6) {
        out.push({ severity: "warning", code: "relay-overvoltage", pin: "VCC", message: `${id} VCC is ${vcc.toFixed(1)} V; the 5 V coil overheats above ~6 V. Wire VCC to the board's 5V.` });
      }
      return out;
    },
    dispose() {
      cancel?.();
      cancel = undefined;
    },
  };
};
