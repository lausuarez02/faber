// Shared electrical + bus plumbing for I2C breakout modules (OLED, LCD backpack, RTC, sensors).
// A module: VCC/GND pins, SDA/SCL pins (protocols "i2c-sda"/"i2c-scl" in part.json), optional
// on-board pull-ups (part.json bus.i2c.pullUpOhms), an address that may come from a prop, and a
// supply current. The module only answers on the bus while it is powered.
import type { PropValue } from "@faber/project-format";
import { GROUND, type CircuitBuilder, type Diagnostic, type PartContext, type SolveResultView } from "@faber/sim-core";

export interface I2cModuleOptions {
  /** Supply pin id (default "VCC") and ground pin id (default "GND"). */
  vccPin?: string;
  gndPin?: string;
  /** Equivalent supply current in mA at 5 V (stamped as a resistor VCC → GND). */
  supplymA: number;
  /** Minimum supply voltage the module works at (V). */
  minVolts: number;
  /** Maximum supply voltage before a damage warning (V). */
  maxVolts: number;
}

/** Parse an address prop: 60, "60", "0x3C", "3C" (hex without prefix only when it has a-f). */
export function parseI2cAddress(v: PropValue | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 128) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    const n = s.startsWith("0x") ? parseInt(s.slice(2), 16) : /[a-f]/.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    if (Number.isInteger(n) && n >= 0 && n < 128) return n;
  }
  return fallback;
}

export function hex2(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
}

export interface I2cModule {
  /** Stamp the supply load and on-board pull-ups. */
  stamp(c: CircuitBuilder): void;
  onSolved(r: SolveResultView): void;
  /** Supply voltage seen at the last solve. */
  readonly volts: number;
  /** True while the supply is inside the working range. Before the first solve: false. */
  readonly powered: boolean;
  /** The 7-bit address right now. */
  address(): number;
  setAddressProp(v: PropValue): void;
  /** Power diagnostics (not powered, over-voltage). */
  diagnostics(): Diagnostic[];
}

export function createI2cModule(ctx: PartContext, opts: I2cModuleOptions): I2cModule {
  const vccPin = opts.vccPin ?? "VCC";
  const gndPin = opts.gndPin ?? "GND";
  const i2c = ctx.spec.bus?.i2c;
  if (!i2c) throw new Error(`${ctx.spec.id}: part.json needs bus.i2c (addresses) to use createI2cModule`);
  const defaultAddr = i2c.addresses[0]!;
  const addrProp = i2c.addressProp;
  let addr = addrProp ? parseI2cAddress(ctx.props[addrProp], defaultAddr) : defaultAddr;
  const loadOhms = 5 / (opts.supplymA / 1000);
  const sdaPin = ctx.spec.pins.find((p) => p.protocols?.includes("i2c-sda"))!.id;
  const sclPin = ctx.spec.pins.find((p) => p.protocols?.includes("i2c-scl"))!.id;
  let volts = 0;
  let solved = false;

  return {
    stamp(c) {
      const vcc = ctx.node(vccPin);
      const gnd = ctx.node(gndPin);
      c.resistor(vcc, gnd, loadOhms, { id: "supply" });
      if (i2c.pullUpOhms) {
        c.resistor(ctx.node(sdaPin), vcc, i2c.pullUpOhms, { id: "pullup-sda" });
        c.resistor(ctx.node(sclPin), vcc, i2c.pullUpOhms, { id: "pullup-scl" });
      }
      void GROUND;
    },
    onSolved(r) {
      solved = true;
      volts = r.voltage(ctx.node(vccPin)) - r.voltage(ctx.node(gndPin));
    },
    get volts() {
      return volts;
    },
    get powered() {
      return solved && volts >= opts.minVolts;
    },
    address: () => addr,
    setAddressProp(v) {
      addr = parseI2cAddress(v, defaultAddr);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      if (!solved) return out;
      if (volts < opts.minVolts) {
        out.push({
          severity: "error",
          code: "i2c-module-unpowered",
          pin: vccPin,
          message: `${ctx.id} has ${volts.toFixed(2)} V between ${vccPin} and ${gndPin} (it needs at least ${opts.minVolts} V), so it is off and does not answer on I2C (Wire.endTransmission() returns 2). Wire ${ctx.id}:${vccPin} to the board's 5V and ${ctx.id}:${gndPin} to GND.`,
        });
      } else if (volts > opts.maxVolts) {
        out.push({
          severity: "error",
          code: "i2c-module-overvoltage",
          pin: vccPin,
          message: `${ctx.id} gets ${volts.toFixed(2)} V on ${vccPin}, above its ${opts.maxVolts} V maximum, which damages a real module. Power it from 5V or 3.3V.`,
        });
      }
      return out;
    },
  };
}
