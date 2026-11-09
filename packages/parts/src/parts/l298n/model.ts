import type { CircuitBuilder, Diagnostic, ElementId, PartModel, PartModelFactory, SolveResultView } from "@jumper/sim-core";
import { GROUND } from "@jumper/sim-core";
import { round, truthy } from "../../lib/props.ts";

/** L298 datasheet input thresholds (V). */
export const VIL = 1.5;
export const VIH = 2.3;
/** Output stage as piecewise-linear drops (datasheet VCEsat: ~1.8 V total at 1 A typ, 3.2 V max). */
export const HIGH_SIDE = { vf: 0.9, rOn: 0.35 } as const;
export const LOW_SIDE = { vf: 0.8, rOn: 0.35 } as const;
const FLYBACK = { vf: 0.7, rOn: 0.1 } as const;

type BridgeState = "fwd" | "rev" | "brake" | "off";
interface Bridge {
  name: "A" | "B";
  en: "ENA" | "ENB";
  in1: "IN1" | "IN3";
  in2: "IN2" | "IN4";
  out1: "OUT1" | "OUT3";
  out2: "OUT2" | "OUT4";
  jumperProp: "enaJumper" | "enbJumper";
  state: BridgeState;
  /** Drive fraction 0..1 (EN duty × direction-input duty). */
  duty: number;
  freqHz: number;
  /** Brake to the high rail (both IN HIGH) instead of GND. */
  brakeHigh: boolean;
  /** Element ids from the last stamp, for current readout. */
  hi: ElementId[];
  amps: number;
}

export const create: PartModelFactory = (ctx): PartModel => {
  const bridges: Bridge[] = [
    { name: "A", en: "ENA", in1: "IN1", in2: "IN2", out1: "OUT1", out2: "OUT2", jumperProp: "enaJumper", state: "off", duty: 0, freqHz: 0, brakeHigh: false, hi: [], amps: 0 },
    { name: "B", en: "ENB", in1: "IN3", in2: "IN4", out1: "OUT3", out2: "OUT4", jumperProp: "enbJumper", state: "off", duty: 0, freqHz: 0, brakeHigh: false, hi: [], amps: 0 },
  ];
  const levels = new Map<string, 0 | 1>();
  let vs = 0;
  let v5 = 0;
  let vregStamped = -1;
  let logicOk = false;
  /** Bridges whose direction inputs ask for motion while EN is off (for the diagnostic). */
  const wantsButDisabled = new Set<string>();

  const regOn = () => truthy(ctx.props.regulatorJumper);
  const regulatorOut = (v: number) => (v >= 7 ? 5 : Math.max(0, v - 2));

  /** Fraction of time an input is HIGH: the PWM duty when a fast PWM drives it, else its logic level. */
  const input = (r: SolveResultView, pin: string): { frac: number; freqHz: number } => {
    const pw = ctx.pwm?.(pin);
    if (pw?.averaged) return { frac: pw.duty, freqHz: pw.freqHz };
    const v = r.voltage(ctx.node(pin));
    const prev = levels.get(pin) ?? 0;
    const lvl: 0 | 1 = v >= VIH ? 1 : v <= VIL ? 0 : prev;
    levels.set(pin, lvl);
    return { frac: lvl, freqHz: 0 };
  };

  const stampHigh = (c: CircuitBuilder, b: Bridge, out: string) => {
    b.hi.push(c.diode(ctx.node("12V"), ctx.node(out), HIGH_SIDE, { id: `hi:${out}` }));
  };
  const stampLow = (c: CircuitBuilder, out: string) => {
    c.diode(ctx.node(out), GROUND, LOW_SIDE, { id: `lo:${out}` });
  };

  return {
    stamp(c) {
      const vsNode = ctx.node("12V");
      c.resistor(vsNode, GROUND, 1000, { id: "quiescent" });
      if (regOn()) {
        vregStamped = regulatorOut(vs);
        c.voltageSource(ctx.node("5V"), GROUND, vregStamped, 1, { id: "reg5v" });
      } else {
        c.resistor(ctx.node("5V"), GROUND, 250, { id: "logic-load" });
      }
      for (const b of bridges) {
        b.hi = [];
        for (const out of [b.out1, b.out2]) {
          c.diode(ctx.node(out), vsNode, FLYBACK, { id: `fbh:${out}` });
          c.diode(GROUND, ctx.node(out), FLYBACK, { id: `fbl:${out}` });
        }
        if (b.state === "fwd") {
          stampHigh(c, b, b.out1);
          stampLow(c, b.out2);
        } else if (b.state === "rev") {
          stampHigh(c, b, b.out2);
          stampLow(c, b.out1);
        } else if (b.state === "brake") {
          if (b.brakeHigh) {
            stampHigh(c, b, b.out1);
            stampHigh(c, b, b.out2);
          } else {
            stampLow(c, b.out1);
            stampLow(c, b.out2);
          }
        }
      }
    },
    onSolved(r) {
      vs = r.voltage(ctx.node("12V"));
      v5 = r.voltage(ctx.node("5V"));
      const logicV = regOn() ? regulatorOut(vs) : v5;
      logicOk = logicV >= 4.0;
      let changed = regOn() && Math.abs(regulatorOut(vs) - vregStamped) > 0.05;
      wantsButDisabled.clear();
      for (const b of bridges) {
        b.amps = b.hi.reduce((s, id) => s + Math.abs(r.current(id)), 0);
        const en = truthy(ctx.props[b.jumperProp]) ? { frac: 1, freqHz: 0 } : input(r, b.en);
        const a = input(r, b.in1);
        const d = input(r, b.in2);
        let state: BridgeState = "off";
        let duty = 0;
        let brakeHigh = false;
        const diff = a.frac - d.frac;
        if (logicOk && en.frac > 0) {
          if (Math.abs(diff) < 1e-3) {
            state = "brake";
            duty = en.frac;
            brakeHigh = a.frac >= 0.5;
          } else {
            state = diff > 0 ? "fwd" : "rev";
            duty = en.frac * Math.abs(diff);
          }
        } else if (Math.abs(diff) >= 1e-3) {
          wantsButDisabled.add(b.name);
        }
        const freqHz = en.freqHz || a.freqHz || d.freqHz;
        if (state !== b.state || Math.abs(duty - b.duty) > 1e-4 || brakeHigh !== b.brakeHigh) {
          b.state = state;
          b.duty = duty;
          b.brakeHigh = brakeHigh;
          changed = true;
        }
        b.freqHz = freqHz;
        // Tell parts on the outputs (a DC motor) that the bridge is switched with this duty.
        const declared = state !== "off" && duty > 0 && duty < 1 ? { duty, freqHz } : undefined;
        ctx.setPwm?.(b.out1, declared);
        ctx.setPwm?.(b.out2, declared);
      }
      if (changed) ctx.requestSolve();
    },
    visualState() {
      const [a, b] = bridges as [Bridge, Bridge];
      const label = (x: Bridge) => (x.state === "off" ? `${x.name} off` : x.state === "brake" ? `${x.name} brake` : `${x.name} ${x.state} ${Math.round(x.duty * 100)}%`);
      return {
        powered: logicOk,
        aState: a.state,
        bState: b.state,
        aDuty: round(a.state === "off" ? 0 : a.duty),
        bDuty: round(b.state === "off" ? 0 : b.duty),
        aLabel: label(a),
        bLabel: label(b),
        vs: round(vs, 2),
      };
    },
    setProp() {},
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      const driving = bridges.some((b) => b.state === "fwd" || b.state === "rev") || wantsButDisabled.size > 0;
      if (driving && vs < 4.5) {
        out.push({
          severity: "error",
          code: "l298n-no-motor-supply",
          pin: "12V",
          message: `${id}: the motors get no power because the 12V terminal is at ${vs.toFixed(1)} V. Wire a battery pack: battery POS → ${id}:12V, battery NEG → ${id}:GND, and ${id}:GND → Arduino GND.`,
        });
      }
      if (!logicOk && (vs > 0.5 || v5 > 0.5)) {
        const how = regOn()
          ? `The on-board regulator makes ${regulatorOut(vs).toFixed(1)} V from ${vs.toFixed(1)} V (it needs ≥ 7 V on 12V). Use a bigger battery (e.g. 2S LiPo) or remove the 5V-EN jumper (regulatorJumper=false) and wire Arduino 5V → ${id}:5V.`
          : `The 5V pin has ${v5.toFixed(1)} V. Wire Arduino 5V → ${id}:5V, or fit the 5V-EN jumper (regulatorJumper=true) with ≥ 7 V on 12V.`;
        out.push({ severity: "error", code: "l298n-no-logic-supply", pin: "5V", message: `${id}: the driver logic is unpowered (needs ≥ 4.5 V), so both outputs stay off. ${how}` });
      }
      for (const name of wantsButDisabled) {
        const b = bridges.find((x) => x.name === name)!;
        if (!logicOk) continue;
        out.push({
          severity: "info",
          code: "l298n-enable-low",
          pin: b.en,
          message: `${id}: motor ${name} is told to turn (${b.in1}≠${b.in2}) but ${b.en} is LOW or unwired, so ${b.out1}/${b.out2} stay off. Wire ${b.en} to a PWM pin and analogWrite(pin, 0–255), or digitalWrite it HIGH, or set prop ${b.jumperProp}=true.`,
        });
      }
      for (const b of bridges) {
        const mA = b.amps * 1000;
        const max = ctx.spec.limits?.maxCurrentmA ?? 2000;
        if (mA > max) {
          out.push({
            severity: "error",
            code: "l298n-overcurrent",
            pin: b.out1,
            message: `${id}: motor ${b.name} draws ${mA.toFixed(0)} mA; the L298N handles ${max} mA per channel (${ctx.spec.limits?.peakCurrentmA ?? 3000} mA peak). Use smaller motors, lower the PWM duty, or a MOSFET driver (e.g. TB6612FNG for ≤ 1.2 A, BTS7960 for big motors).`,
          });
        }
      }
      if (regOn() && vs > 12.5) {
        out.push({
          severity: "warning",
          code: "l298n-regulator-overvoltage",
          pin: "12V",
          message: `${id}: ${vs.toFixed(1)} V on 12V with the 5V-EN jumper on overheats the on-board 78M05. Above 12 V remove the jumper (regulatorJumper=false) and feed 5 V to the 5V pin.`,
        });
      }
      const vmax = ctx.spec.limits?.maxVoltage ?? 46;
      if (vs > vmax) {
        out.push({ severity: "error", code: "l298n-overvoltage", pin: "12V", message: `${id}: ${vs.toFixed(1)} V on 12V exceeds the L298's ${vmax} V absolute maximum and destroys it. Use a supply ≤ 35 V.` });
      }
      return out;
    },
  };
};
