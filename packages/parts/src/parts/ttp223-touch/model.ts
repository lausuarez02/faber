// TTP223 one-key capacitive touch module. Output is CMOS push-pull at VCC (no pull-up needed).
// Jumper A: active high / low. Jumper B: momentary / toggle. A finger is press / release / set.
import type { Diagnostic, PartModel, PartModelFactory } from "@jumper/sim-core";
import { GROUND } from "@jumper/sim-core";
import { str, truthy } from "../../lib/props.ts";

const MIN_VCC = 2.0;
const MAX_VCC = 5.5;
/** Output resistance of the CMOS output (it sources ~4 mA, sinks ~8 mA). */
const R_OUT = 150;
/** Supply current: 1.5 µA standby (low-power mode), the module's LED ~2 mA while active. */
const LED_MA = 2;

export const create: PartModelFactory = (ctx): PartModel => {
  let activeLow = str(ctx.props.output, "active-high") === "active-low";
  let toggle = str(ctx.props.mode, "momentary") === "toggle";
  let touched = false;
  let latched = false;
  let vcc = 0;
  let powered = false;

  const active = () => (toggle ? latched : touched);
  const high = () => active() !== activeLow;

  const touch = (on: boolean) => {
    if (on && !touched && toggle) latched = !latched;
    touched = on;
  };

  return {
    stamp(c) {
      const v = ctx.node("VCC");
      c.resistor(v, GROUND, 5 / 0.0000015, { id: "chip" });
      if (powered && active()) c.resistor(v, GROUND, Math.max(vcc, 1) / (LED_MA / 1000), { id: "led" });
      if (powered) c.voltageSource(ctx.node("IO"), GROUND, high() ? vcc : 0, R_OUT, { id: "out" });
    },
    onSolved(r) {
      const v = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const now = v >= MIN_VCC;
      const changed = now !== powered || (now && Math.abs(v - vcc) > 0.05);
      vcc = v;
      if (now !== powered) {
        powered = now;
        if (!powered) latched = false;
      }
      if (changed) ctx.requestSolve();
    },
    visualState() {
      return { touched, active: powered && active(), out: powered && high(), padOpacity: touched ? 1 : 0 };
    },
    setProp(id, v) {
      if (id === "output") activeLow = str(v, "active-high") === "active-low";
      if (id === "mode") {
        toggle = str(v, "momentary") === "toggle";
        latched = false;
      }
    },
    interact(e) {
      if (e.kind === "press") touch(true);
      else if (e.kind === "release") touch(false);
      else if (e.kind === "set" && (e.key === undefined || e.key === "touched" || e.key === "touch")) touch(truthy(e.value));
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      if (vcc > MAX_VCC + 0.1) {
        out.push({ severity: "error", code: "ttp223-overvoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V, above the TTP223's 5.5 V maximum, which destroys the chip. Wire VCC to the board's 5V or 3V3 pin.` });
      } else if (!powered && vcc > 0.3) {
        out.push({ severity: "warning", code: "ttp223-undervoltage", pin: "VCC", message: `${ctx.id} VCC is only ${vcc.toFixed(1)} V (needs 2.0 to 5.5 V), so I/O never changes. Wire VCC to 5V or 3V3 and GND to GND.` });
      } else if (!powered && touched) {
        out.push({ severity: "info", code: "ttp223-unpowered", pin: "VCC", message: `${ctx.id} was touched but has no supply, so I/O stays LOW. Wire VCC to 5V or 3V3 and GND to GND.` });
      }
      return out;
    },
  };
};
