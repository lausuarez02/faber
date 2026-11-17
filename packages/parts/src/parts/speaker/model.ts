// Small 8 Ω speaker (round 7, voice). The coil is a resistor between + and -; amplifiers such as
// the DFPlayer Mini drive it with an RMS level, so the solved current is the RMS current and the
// power is I² · R. Deterministic: no time dependence.
import type { Diagnostic, PartModel, PartModelFactory } from "@faber/sim-core";
import { num, round } from "../../lib/props.ts";

export const create: PartModelFactory = (ctx): PartModel => {
  let ohms = num(ctx.props.ohms, 8);
  let rated = num(ctx.props.rated_w, 0.5);
  let amps = 0;
  let volts = 0;
  let peakW = 0;
  let coil: string | undefined;
  return {
    stamp(c) {
      coil = c.resistor(ctx.node("+"), ctx.node("-"), ohms, { id: "coil" });
    },
    onSolved(r) {
      amps = coil ? r.current(coil) : 0;
      volts = r.voltage(ctx.node("+")) - r.voltage(ctx.node("-"));
      peakW = Math.max(peakW, amps * amps * ohms);
    },
    visualState() {
      const w = amps * amps * ohms;
      return {
        sounding: w > 0.001,
        volume: round(Math.min(1, Math.sqrt(w / rated)), 2),
        powerW: round(w, 3),
        currentmA: round(Math.abs(amps) * 1000, 1),
        volts: round(volts, 2),
      };
    },
    setProp(id, value) {
      if (id === "ohms") ohms = num(value, 8);
      if (id === "rated_w") rated = num(value, 0.5);
    },
    diagnostics(): Diagnostic[] {
      const out: Diagnostic[] = [];
      if (peakW > rated * 1.25) {
        out.push({
          severity: peakW > rated * 3 ? "error" : "warning",
          code: "speaker-overpower",
          message: `The speaker gets ${peakW.toFixed(2)} W but is rated ${rated} W. Why: more power than rated distorts it and can burn the coil. Fix: lower the volume (DFPlayer: volume 20 instead of 30; an I2S amplifier such as the MAX98357A: scale the samples down in the firmware or strap its GAIN lower), use a ${rated < 1 ? "1 W or bigger" : "bigger"} speaker, or never wire it straight to a supply or a board pin.`,
        });
      }
      return out;
    },
  };
};
