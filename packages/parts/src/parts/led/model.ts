import type { Diagnostic, ElementId, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { LED_ABS_MAX_mA, LED_COLORS, LED_RATED_mA, ledBrightness, ledColor, type LedColor } from "../../lib/led.ts";
import { round, str } from "../../lib/props.ts";

/** Reverse voltage above which the LED may break down (typical datasheet VR = 5 V). */
export const LED_MAX_REVERSE_V = 5;

export const create: PartModelFactory = (ctx): PartModel => {
  let color: LedColor = ledColor(str(ctx.props.color, "red"));
  let el: ElementId = "";
  let mA = 0;
  let vReverse = 0;
  const rated = ctx.spec.limits?.maxCurrentmA ?? LED_RATED_mA;
  const absMax = ctx.spec.limits?.absMaxCurrentmA ?? LED_ABS_MAX_mA;

  return {
    stamp(c) {
      const { vf, rOn } = LED_COLORS[color];
      el = c.led(ctx.node("A"), ctx.node("C"), { vf, rOn }, { id: "d" });
    },
    onSolved(r) {
      mA = Math.max(0, r.current(el) * 1000);
      vReverse = r.voltage(ctx.node("C")) - r.voltage(ctx.node("A"));
    },
    visualState() {
      const brightness = ledBrightness(mA);
      return {
        brightness,
        color: LED_COLORS[color].glow,
        lens: LED_COLORS[color].lens,
        on: brightness > 0,
        currentmA: round(mA),
      };
    },
    setProp(id, v) {
      if (id === "color") color = ledColor(str(v, color));
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      if (mA > absMax) {
        out.push({
          severity: "error",
          code: "led-overcurrent",
          message: `LED will burn out, add a resistor: ${mA.toFixed(0)} mA flows through it (absolute max ${absMax} mA). Put about 220 Ω in series at 5 V or 100 Ω at 3.3 V.`,
        });
      } else if (mA > rated) {
        out.push({
          severity: "warning",
          code: "led-overcurrent",
          message: `LED runs at ${mA.toFixed(0)} mA, above its ${rated} mA rating, which shortens its life. Use a larger series resistor.`,
        });
      }
      if (vReverse > LED_MAX_REVERSE_V) {
        out.push({
          severity: "warning",
          code: "led-reverse-voltage",
          message: `LED is reverse-biased by ${vReverse.toFixed(1)} V (max ${LED_MAX_REVERSE_V} V) and may break down. Check that the long leg (A) goes towards +.`,
          pin: "C",
        });
      }
      return out;
    },
  };
};
