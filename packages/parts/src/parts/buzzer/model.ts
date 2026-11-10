import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@jumper/sim-core";
import { clamp, round } from "../../lib/props.ts";

/** Equivalent DC load of a 5 V active buzzer (≈ 25 mA at 5 V including the blocking diode). */
export const BUZZER_OHMS = 180;
/** Below this the oscillator does not start. */
export const BUZZER_MIN_V = 3;
export const BUZZER_RATED_V = 5;

export const create: PartModelFactory = (ctx): PartModel => {
  let el: ElementId = "";
  let volts = 0;
  let amps = 0;
  /** Frequency of a tone() / PWM signal seen on + (Hz), 0 for plain DC. */
  let toneHz = 0;
  const maxV = ctx.spec.limits?.maxVoltage ?? 7;
  return {
    stamp(c) {
      // + → blocking diode → 180 Ω → −. Reverse polarity draws (almost) nothing and stays silent.
      const mid = ctx.internalNode("k");
      el = c.diode(ctx.node("POS"), mid, { vf: 0.3, rOn: 1 }, { id: "d" });
      c.resistor(mid, ctx.node("NEG"), BUZZER_OHMS, { id: "load" });
    },
    onSolved(r) {
      volts = r.voltage(ctx.node("POS")) - r.voltage(ctx.node("NEG"));
      amps = Math.max(0, r.current(el));
      const pw = ctx.pwm?.("POS");
      if (pw && pw.freqHz >= 20 && pw.freqHz <= 20_000 && pw.duty > 0.02 && pw.duty < 0.98 && pw.sinceEdgeUs <= 2 * pw.periodUs + 50) toneHz = pw.freqHz;
    },
    visualState() {
      const volume = volts < BUZZER_MIN_V ? 0 : round(clamp(0.3 + (0.7 * (volts - BUZZER_MIN_V)) / (BUZZER_RATED_V - BUZZER_MIN_V), 0, 1));
      return { sounding: volume > 0, volume, volts: round(volts), currentmA: round(amps * 1000) };
    },
    setProp() {},
    diagnostics() {
      const out: Diagnostic[] = [];
      if (volts < -1) {
        out.push({
          severity: "warning",
          code: "buzzer-reversed",
          message: `Buzzer is wired backwards (${volts.toFixed(1)} V across it), so it stays silent. Swap the legs: + to the signal, − to GND.`,
          pin: "POS",
        });
      } else if (volts > 0.5 && volts < BUZZER_MIN_V) {
        out.push({
          severity: "info",
          code: "buzzer-undervoltage",
          message: `Buzzer gets ${volts.toFixed(1)} V, below the ${BUZZER_MIN_V} V it needs to start, so it is silent. Drive it from 5 V or through a transistor.`,
          pin: "POS",
        });
      } else if (volts > maxV) {
        out.push({
          severity: "warning",
          code: "buzzer-overvoltage",
          message: `Buzzer gets ${volts.toFixed(1)} V, above its ${maxV} V maximum. Use a 5 V supply.`,
          pin: "POS",
        });
      }
      if (toneHz > 0) {
        out.push({
          severity: "info",
          code: "buzzer-tone",
          pin: "POS",
          message: `${ctx.id} is an ACTIVE buzzer driven with tone() / PWM (${Math.round(toneHz)} Hz): it has its own ~2.3 kHz oscillator, so it does not play the pitch you ask for (it sounds rough or stutters). Use digitalWrite(pin, HIGH/LOW) for beeps, or swap it for a "passive-buzzer" to play notes and melodies.`,
        });
      }
      return out;
    },
  };
};
