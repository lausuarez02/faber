import type { PropValue } from "@jumper/project-format";
import { GROUND, type CircuitBuilder, type ElementId, type SolveResultView } from "./circuit.ts";
import type { Diagnostic, PartContext, PartModel, VisualState } from "./part.ts";

export const GPIO_R_OUT = 25;
export const PULLUP_OHMS = 35_000;

export interface McuBoardOptions {
  /** Power pins → volts, e.g. { "5V": 5, "3V3": 3.3 }. Stamped as sources with 0.05 Ω to ground. */
  rails?: Record<string, number>;
  /** GPIO pin ids to wire to the MCU. Default: every spec pin whose id is in mcu.pinIds. */
  gpio?: readonly string[];
  /** GPIO output resistance (Ω). Default 25. */
  gpioROut?: number;
  /** INPUT_PULLUP resistance (Ω). Default 35 kΩ. */
  pullupOhms?: number;
  /** Per-pin current that triggers an error diagnostic (mA). Default spec.limits.maxCurrentmA ?? 40. */
  maxPinCurrentmA?: number;
  /** Extra visual state, merged over the defaults. Gets the latest solve (or undefined before the first). */
  visual?: (r: SolveResultView | undefined) => VisualState;
}

/**
 * Generic model for an MCU board part. Board parts' model.ts can just do
 * `export const create = (ctx) => createMcuBoardModel(ctx, { rails: { "5V": 5, "3V3": 3.3 } })`.
 *
 * Electrical behavior per GPIO (when ctx.mcu is set):
 *   output        → voltageSource(pin, GND, high ? vcc : 0, 25 Ω)        element id "gpio:<pin>"
 *   input_pullup  → voltageSource(pin, GND, vcc, 35 kΩ)                   element id "pullup:<pin>"
 *   input/analog  → nothing (high impedance); after each solve the net voltage is fed back with setPinInput().
 *
 * visualState: { powered: true, running: boolean, "pin_<id>": 0|1 for every GPIO }.
 *
 * A wired input with nothing driving it (no pull-up, no resistor, an open button) has no DC
 * path in the circuit. The solver ties such nodes to ground through GMIN, so it reads a steady
 * LOW, whereas a real pin floats and picks up noise. diagnostics() warns ("floating-input")
 * about every such pin so the sketch is not mistaken for one that works on hardware.
 */
export function createMcuBoardModel(ctx: PartContext, opts: McuBoardOptions = {}): PartModel {
  const mcu = ctx.mcu;
  const vcc = mcu?.vcc ?? ctx.spec.mcu?.vcc ?? 5;
  const rOut = opts.gpioROut ?? GPIO_R_OUT;
  const pullup = opts.pullupOhms ?? PULLUP_OHMS;
  const maxmA = opts.maxPinCurrentmA ?? ctx.spec.limits?.maxCurrentmA ?? 40;
  const specPins = new Set(ctx.spec.pins.map((p) => p.id));
  const gpio = (opts.gpio ?? mcu?.pinIds ?? []).filter((p) => specPins.has(p));
  let drivers = new Map<string, ElementId>();
  let last: SolveResultView | undefined;
  let lastCurrents = new Map<string, number>();

  return {
    stamp(c: CircuitBuilder) {
      drivers = new Map();
      for (const [pin, volts] of Object.entries(opts.rails ?? {})) {
        if (specPins.has(pin)) c.voltageSource(ctx.node(pin), GROUND, volts, 0.05, { id: `rail:${pin}` });
      }
      if (!mcu) return;
      for (const pin of gpio) {
        const s = mcu.readPin(pin);
        const node = ctx.node(pin);
        if (s.mode === "output") {
          drivers.set(pin, c.voltageSource(node, GROUND, s.value ? vcc : 0, rOut, { id: `gpio:${pin}` }));
        } else if (s.mode === "input_pullup") {
          drivers.set(pin, c.voltageSource(node, GROUND, vcc, pullup, { id: `pullup:${pin}` }));
        }
      }
    },
    onSolved(r) {
      last = r;
      lastCurrents = new Map();
      for (const [pin, id] of drivers) lastCurrents.set(pin, r.current(id));
      if (!mcu) return;
      for (const pin of gpio) {
        if (mcu.readPin(pin).mode !== "output") mcu.setPinInput(pin, r.voltage(ctx.node(pin)));
      }
    },
    visualState() {
      const v: VisualState = { powered: true, running: !!mcu };
      if (mcu) for (const pin of gpio) v[`pin_${pin}`] = mcu.readPin(pin).value;
      return opts.visual ? { ...v, ...opts.visual(last) } : v;
    },
    setProp(_id: string, _value: PropValue) {},
    diagnostics() {
      const out: Diagnostic[] = [];
      for (const [pin, a] of lastCurrents) {
        const mA = Math.abs(a) * 1000;
        if (mA > maxmA) {
          out.push({
            severity: "error",
            code: "gpio-overcurrent",
            pin,
            message: `${pin} is sourcing/sinking ${mA.toFixed(0)} mA; the limit is ${maxmA} mA. Add a series resistor.`,
          });
        }
      }
      // Before the firmware's first instruction every pin is an input; that is not a finding.
      // Only nodes some part stamps are in the circuit, so an unwired pin is never "floating".
      const floatingInputs =
        mcu && last && ctx.now() > 0
          ? gpio.filter((pin) => mcu.readPin(pin).mode === "input" && last!.isFloating(ctx.node(pin)))
          : [];
      for (const pin of floatingInputs) {
        out.push({
          severity: "warning",
          code: "floating-input",
          pin,
          message: `${pin} is an input with nothing driving it, so on real hardware it reads random values (the simulator reads LOW). Use INPUT_PULLUP or add a pull-up/pull-down resistor.`,
        });
      }
      return out;
    },
  };
}
