import type { Diagnostic, DiodeParams, ElementId, PartModel, PartModelFactory } from "@faber/sim-core";
import { LED_ABS_MAX_mA, LED_RATED_mA, ledBrightness } from "../../lib/led.ts";

/** Per-die parameters: AlGaInP red, InGaN green and blue (typical Vf 2.1 / 3.1 / 3.1 V at 20 mA). */
export const RGB_DIES = {
  R: { vf: 2.0, rOn: 5 },
  G: { vf: 2.9, rOn: 10 },
  B: { vf: 2.9, rOn: 10 },
} as const satisfies Record<string, DiodeParams>;
type Channel = keyof typeof RGB_DIES;
const CHANNELS: Channel[] = ["R", "G", "B"];
const NAMES: Record<Channel, string> = { R: "red", G: "green", B: "blue" };

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();

export const create: PartModelFactory = (ctx): PartModel => {
  const els: Record<Channel, ElementId> = { R: "", G: "", B: "" };
  const mA: Record<Channel, number> = { R: 0, G: 0, B: 0 };
  const rated = ctx.spec.limits?.maxCurrentmA ?? LED_RATED_mA;
  const absMax = ctx.spec.limits?.absMaxCurrentmA ?? LED_ABS_MAX_mA;

  return {
    stamp(c) {
      const k = ctx.node("COM");
      for (const ch of CHANNELS) els[ch] = c.led(ctx.node(ch), k, RGB_DIES[ch], { id: ch });
    },
    onSolved(r) {
      for (const ch of CHANNELS) mA[ch] = Math.max(0, r.current(els[ch]) * 1000);
    },
    visualState() {
      const r = ledBrightness(mA.R);
      const g = ledBrightness(mA.G);
      const b = ledBrightness(mA.B);
      const brightness = Math.max(r, g, b);
      // Normalise the mix so the colour stays saturated; intensity goes through `brightness`.
      const n = brightness || 1;
      return { r, g, b, brightness, color: `#${hex2(r / n)}${hex2(g / n)}${hex2(b / n)}`, on: brightness > 0 };
    },
    setProp() {},
    diagnostics() {
      const out: Diagnostic[] = [];
      for (const ch of CHANNELS) {
        const i = mA[ch];
        if (i > absMax) {
          out.push({
            severity: "error",
            code: "led-overcurrent",
            pin: ch,
            message: `LED will burn out, add a resistor: the ${NAMES[ch]} channel carries ${i.toFixed(0)} mA (absolute max ${absMax} mA). Put about 220 Ω in series with ${ch}.`,
          });
        } else if (i > rated) {
          out.push({
            severity: "warning",
            code: "led-overcurrent",
            pin: ch,
            message: `The ${NAMES[ch]} channel runs at ${i.toFixed(0)} mA, above its ${rated} mA rating. Use a larger resistor on ${ch}.`,
          });
        }
      }
      return out;
    },
  };
};
