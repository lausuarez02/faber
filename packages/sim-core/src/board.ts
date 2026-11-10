import type { PropValue } from "@jumper/project-format";
import { GROUND, type CircuitBuilder, type ElementId, type RegulatorParams, type SolveResultView } from "./circuit.ts";
import type { Diagnostic, PartContext, PartModel, PartSpec, VisualState } from "./part.ts";

export const GPIO_R_OUT = 25;
export const PULLUP_OHMS = 35_000;
/** USB VBUS from a computer or charger (V); the cable and port are taken as stiff (USB_R_OUT, as the round-5 rails). */
export const USB_VOLTS = 5;
export const USB_R_OUT = 0.05;

// round 6 power
/**
 * How a board is powered (decision 0004, R2). USB lands on `usbPin` when the project says a cable is
 * plugged in (jumper.json power.usb, default true); everything else is the board's own supply chain
 * (regulators, diodes) between its real supply pins, so a battery wired to VBUS / VSYS / VIN powers it
 * through the same circuit the solver uses for everything else. The MCU runs while `logicPin` is at or
 * above `minLogicV`.
 */
export interface BoardSupply {
  /** Pin the USB 5 V reaches ("VBUS" / "5V"). */
  usbPin: string;
  /** On-board regulators, from pin → to pin (an id is the element id). */
  regulators: { id: string; from: string; to: string; params: RegulatorParams; /** Pin that switches it off when pulled LOW (Pico 3V3_EN, pulled up to `from` by 100 kΩ). */ enable?: string }[];
  /** On-board diodes (the Pico's VBUS → VSYS Schottky). */
  diodes?: { id: string; from: string; to: string; vf: number; rOn: number }[];
  /** Pins tied together on the board (Uno IOREF = 5V). */
  ties?: { id: string; a: string; b: string; ohms: number }[];
  /** The rail the MCU runs from (its vcc). */
  logicPin: string;
  /** The MCU runs (and holds its program) while logicPin ≥ this (V). */
  minLogicV: number;
  /** Supply current of the board itself (MCU, LEDs) at its vcc, mA. */
  selfmA: number;
}

/** What a board's supply did in the last solve (Simulation.boardSupply, set_power). */
export interface BoardSupplyState {
  usb: boolean;
  powered: boolean;
  /** Voltage of the logic rail (V). */
  logicV: number;
  /** Current the USB cable delivers (mA, negative = flowing back into the computer). */
  usbmA: number;
}

/**
 * The supply a board with plain `rails` gets (Uno, Nano, test boards): USB on the ~5 V rail, every
 * lower rail from it through an LDO, equal rails tied, VIN through a 5 V regulator (NCP1117-class,
 * ~1.1 V dropout). Undefined when the rails have no ~5 V pin (then the rails stay ideal sources).
 */
export function defaultBoardSupply(spec: PartSpec, rails: Record<string, number>, vcc: number): BoardSupply | undefined {
  const pins = new Set(spec.pins.map((p) => p.id));
  const entries = Object.entries(rails).filter(([pin]) => pins.has(pin));
  const usb = entries.find(([pin, v]) => v >= 4.5 && v <= 5.5 && /^(5V|VBUS)$/i.test(pin)) ?? entries.find(([, v]) => v >= 4.5 && v <= 5.5);
  if (!usb) return undefined;
  const [usbPin, usbV] = usb;
  const regulators: BoardSupply["regulators"] = [];
  const ties: NonNullable<BoardSupply["ties"]> = [];
  for (const [pin, v] of entries) {
    if (pin === usbPin) continue;
    if (Math.abs(v - usbV) < 0.01) ties.push({ id: `tie:${pin}`, a: usbPin, b: pin, ohms: 0.05 });
    else if (v < usbV) regulators.push({ id: `ldo:${pin}`, from: usbPin, to: pin, params: { volts: v, dropout: 0.3, rOut: 0.01 } });
  }
  const vin = spec.pins.find((p) => p.type === "power" && /^VIN$/i.test(p.id));
  if (vin) regulators.push({ id: "ldo:VIN", from: vin.id, to: usbPin, params: { volts: usbV, dropout: 1.1, rOut: 0.01, minIn: 1 } });
  const logic = entries.reduce((best, e) => (Math.abs(e[1] - vcc) < Math.abs(best[1] - vcc) ? e : best), usb);
  return { usbPin, regulators, ties, logicPin: logic[0], minLogicV: round2(logic[1] * 0.8), selfmA: spec.current_ma?.typ ?? 0 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  // round 6 power
  /** The board's supply chain (round 6). Default: defaultBoardSupply(spec, rails); `false` keeps the rails as ideal sources (always powered). */
  supply?: BoardSupply | false;
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
  const supply = opts.supply === false ? undefined : (opts.supply ?? defaultBoardSupply(ctx.spec, opts.rails ?? {}, vcc));
  const usbOn = () => ctx.power?.usb !== false;
  let drivers = new Map<string, ElementId>();
  let last: SolveResultView | undefined;
  let lastCurrents = new Map<string, number>();
  /** Logic rail voltage of the last solve; undefined before the first. */
  let logicV: number | undefined;
  let usbA = 0;
  let usbEl: ElementId | undefined;
  /** Regulators switched off by their enable pin (from the last solve). */
  const disabled = new Set<string>();

  const isPowered = (): boolean => {
    if (!supply) return true;
    if (logicV === undefined) return usbOn();
    return logicV >= supply.minLogicV;
  };

  return {
    stamp(c: CircuitBuilder) {
      drivers = new Map();
      if (!supply) {
        for (const [pin, volts] of Object.entries(opts.rails ?? {})) {
          if (specPins.has(pin)) c.voltageSource(ctx.node(pin), GROUND, volts, 0.05, { id: `rail:${pin}` });
        }
      } else {
        usbEl = usbOn() && specPins.has(supply.usbPin) ? c.voltageSource(ctx.node(supply.usbPin), GROUND, USB_VOLTS, USB_R_OUT, { id: "usb" }) : undefined;
        for (const d of supply.diodes ?? []) c.diode(ctx.node(d.from), ctx.node(d.to), { vf: d.vf, rOn: d.rOn }, { id: d.id });
        for (const t of supply.ties ?? []) c.resistor(ctx.node(t.a), ctx.node(t.b), t.ohms, { id: t.id });
        for (const r of supply.regulators) {
          if (r.enable) c.resistor(ctx.node(r.from), ctx.node(r.enable), 100_000, { id: `${r.id}:en` });
          if (disabled.has(r.id)) continue;
          if (!c.regulator) throw new Error("the circuit builder has no regulator(); boards with a supply need sim-core round 6");
          c.regulator(ctx.node(r.from), ctx.node(r.to), r.params, { id: r.id });
        }
        // The board's own current. On USB with the logic rail being the USB pin (Uno, Nano) the cable
        // supplies it directly, so it does not sag the rail the round-5 projects were tuned on.
        if (supply.selfmA > 0 && !(usbEl && supply.logicPin === supply.usbPin)) c.resistor(ctx.node(supply.logicPin), GROUND, vcc / (supply.selfmA / 1000), { id: "self" });
      }
      if (!mcu || !isPowered()) return;
      // GPIO HIGH follows a sagging logic rail (a LiPo in dropout), never above the MCU's vcc.
      const high = supply && logicV !== undefined ? Math.min(vcc, logicV) : vcc;
      for (const pin of gpio) {
        const s = mcu.readPin(pin);
        const node = ctx.node(pin);
        if (s.mode === "output") {
          drivers.set(pin, c.voltageSource(node, GROUND, s.value ? high : 0, rOut, { id: `gpio:${pin}` }));
        } else if (s.mode === "input_pullup") {
          drivers.set(pin, c.voltageSource(node, GROUND, high, pullup, { id: `pullup:${pin}` }));
        }
      }
    },
    onSolved(r) {
      last = r;
      lastCurrents = new Map();
      for (const [pin, id] of drivers) lastCurrents.set(pin, r.current(id));
      if (supply) {
        const before = isPowered();
        const prevV = logicV;
        logicV = r.voltage(ctx.node(supply.logicPin));
        usbA = usbEl ? r.current(usbEl) : 0;
        let enChanged = false;
        for (const reg of supply.regulators) {
          if (!reg.enable) continue;
          const off = r.voltage(ctx.node(reg.enable)) < 0.8 && !r.isFloating(ctx.node(reg.enable));
          if (off !== disabled.has(reg.id)) {
            enChanged = true;
            if (off) disabled.add(reg.id);
            else disabled.delete(reg.id);
          }
        }
        // Power state (or the rail the GPIOs drive at) changed: stamp again with it.
        if (before !== isPowered() || enChanged || (prevV !== undefined && Math.abs(prevV - logicV) > 0.05 && logicV < vcc)) ctx.requestSolve();
      }
      if (!mcu || !isPowered()) return;
      for (const pin of gpio) {
        if (mcu.readPin(pin).mode !== "output") mcu.setPinInput(pin, r.voltage(ctx.node(pin)));
      }
    },
    powered: isPowered,
    visualState() {
      const powered = isPowered();
      const v: VisualState = { powered, running: !!mcu && powered };
      if (supply) {
        v.usb = usbOn();
        v.supplyV = Math.round((logicV ?? 0) * 100) / 100;
      }
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
      if (supply && !isPowered()) {
        out.push({
          severity: usbOn() ? "error" : "warning",
          code: "board-unpowered",
          pin: supply.logicPin,
          message: `${ctx.id} has no power: its ${supply.logicPin} rail is at ${(logicV ?? 0).toFixed(2)} V, below the ${supply.minLogicV} V it needs, so the firmware is held in reset. ${usbOn() ? "Something pulls the supply down (a short or a heavy load)." : `USB is unplugged (power.usb false) and nothing powers ${supply.usbPin}.`} Fix: ${usbOn() ? "remove the short / heavy load from the supply pins" : `wire the battery path to ${ctx.id}.${supply.usbPin} (cell → charger OUT → switch → Schottky diode → ${supply.usbPin}), or set_power {"usb": true}`}.`,
        });
      }
      if (supply && usbA < -0.01) {
        out.push({
          severity: "error",
          code: "usb-backfeed",
          pin: supply.usbPin,
          message: `${(-usbA * 1000).toFixed(0)} mA flows back into the USB port through ${ctx.id}.${supply.usbPin}: something on that pin is above the cable's 5 V. That can damage the computer's port or the charger. Fix: put a Schottky diode (schottky-diode, stripe towards ${supply.usbPin}) between the external supply and ${ctx.id}.${supply.usbPin}.`,
        });
      }
      // Before the firmware's first instruction every pin is an input; that is not a finding.
      // Only nodes some part stamps are in the circuit, so an unwired pin is never "floating".
      const floatingInputs =
        mcu && last && ctx.now() > 0 && isPowered()
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
