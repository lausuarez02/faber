// Behaviour templates for agent-made parts (decision 0003, C4). Each turns the numbers in a
// part.json `behavior` block into a PartModel built from the same pieces as the built-in parts
// (resistors and sources in the circuit, the I2C bus interface, the bit-level soft UART). No code
// from the part file runs. Deterministic: virtual time only.
import type { PropValue } from "@jumper/project-format";
import type { Diagnostic, ElementId, I2cDevice, PartContext, PartModel, PartModelFactory, SolveResultView, VisualState } from "@jumper/sim-core";
import { createI2cModule, hex2 } from "../lib/i2cModule.ts";
import { clamp, num, round, truthy } from "../lib/props.ts";
import { UartReceiver, UartTransmitter } from "../lib/softUart.ts";
import type { CustomPart } from "./schema.ts";

type B<K extends CustomPart["behavior"]["kind"]> = Extract<CustomPart["behavior"], { kind: K }>;

/** GPIO pins source / sink about this much before the voltage sags (ATmega328P: 20 mA recommended, 40 mA absolute). */
const GPIO_MAX_MA = 40;

// ------------------------------------------------------------------ supply

export interface Supply {
  vcc?: string;
  gnd?: string;
  minV: number;
  maxV: number;
  /** Supply current at the typical operating point (mA). */
  typMa: number;
}

/** The part's supply pins and limits (power block, else its first power / ground pin). */
export function supplyOf(part: CustomPart): Supply {
  const vcc = part.power?.vcc ?? part.pins.find((p) => p.type === "power")?.id;
  const gnd = part.power?.gnd ?? part.pins.find((p) => p.type === "ground")?.id;
  const vpin = part.pins.find((p) => p.id === vcc);
  return {
    ...(vcc ? { vcc } : {}),
    ...(gnd ? { gnd } : {}),
    minV: part.power?.min_v ?? vpin?.voltage?.min ?? 2.7,
    maxV: part.power?.max_v ?? vpin?.voltage?.max ?? 5.5,
    typMa: part.current_ma?.typ ?? 0,
  };
}

class Power {
  volts = 0;
  solved = false;
  constructor(
    private readonly ctx: PartContext,
    readonly s: Supply,
  ) {}
  get hasPin(): boolean {
    return this.s.vcc !== undefined;
  }
  /** Powered after the last solve (parts without a supply pin are always on). */
  get on(): boolean {
    return !this.hasPin || (this.solved && this.volts >= this.s.minV);
  }
  /** Output-high voltage: the supply, or 5 V for parts without a supply pin. */
  get high(): number {
    return this.hasPin ? Math.max(0, this.volts) : 5;
  }
  /** Stamp the supply current as a resistor VCC → GND (scaled by `factor`, e.g. relay coil on). */
  stamp(c: Parameters<PartModel["stamp"]>[0], factor = 1): void {
    if (!this.s.vcc) return;
    const ma = this.s.typMa * factor;
    if (ma > 0) c.resistor(this.ctx.node(this.s.vcc), this.s.gnd ? this.ctx.node(this.s.gnd) : "0", 5 / (ma / 1000), { id: "supply" });
  }
  /** Read the supply; true when the on/off state changed. */
  read(r: SolveResultView): boolean {
    if (!this.s.vcc) return false;
    const was = this.on;
    this.solved = true;
    this.volts = r.voltage(this.ctx.node(this.s.vcc)) - (this.s.gnd ? r.voltage(this.ctx.node(this.s.gnd)) : 0);
    return was !== this.on;
  }
  diagnostics(what: string): Diagnostic[] {
    if (!this.s.vcc || !this.solved) return [];
    const id = this.ctx.id;
    if (this.volts > this.s.maxV + 0.05) {
      return [{ severity: "error", code: "custom-overvoltage", pin: this.s.vcc, message: `${id} gets ${this.volts.toFixed(2)} V on ${this.s.vcc}, above the ${this.s.maxV} V its part.json allows, which would damage the real module. Power it from a lower rail (3V3 for a 3.3 V part).` }];
    }
    if (this.volts < this.s.minV) {
      return [{ severity: this.volts > 0.3 ? "warning" : "info", code: "custom-unpowered", pin: this.s.vcc, message: `${id} has ${this.volts.toFixed(2)} V on ${this.s.vcc} (it needs ${this.s.minV} V or more), so it is off and ${what}. Wire ${id}:${this.s.vcc} to 5V or 3V3${this.s.gnd ? ` and ${id}:${this.s.gnd} to GND` : ""}.` }];
    }
    return [];
  }
}

/** Piecewise-linear lookup over points sorted by x (clamped at the ends). */
export function interpolate(points: { x: number; y: number }[], x: number): number {
  const pts = [...points].sort((a, b) => a.x - b.x);
  if (x <= pts[0]!.x) return pts[0]!.y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return pts[pts.length - 1]!.y;
}

const fmt = (v: number) => String(round(v, 2));

// ------------------------------------------------------------------ digital input

function digitalInput(part: CustomPart, b: B<"digital-input">): PartModelFactory {
  return (ctx) => {
    const power = new Power(ctx, supplyOf(part));
    let active = truthy(ctx.props[b.field] ?? b.default_active);
    const level = () => (active ? (b.active_level === "high" ? 1 : 0) : b.active_level === "high" ? 0 : 1);
    const set = (v: boolean) => {
      if (v === active) return;
      active = v;
      ctx.requestSolve();
    };
    return {
      stamp(c) {
        power.stamp(c);
        if (!power.on) return;
        const out = ctx.node(b.output);
        if (b.drive === "push-pull") c.voltageSource(out, "0", level() ? power.high : 0, 100, { id: "out" });
        else if (!level()) c.voltageSource(out, "0", 0, 50, { id: "out" });
      },
      onSolved(r) {
        if (power.read(r)) ctx.requestSolve();
      },
      visualState(): VisualState {
        return { [b.field]: active, level: level(), powered: power.on, label: power.on ? (active ? b.field : "idle") : "off", ledOpacity: power.on && active ? 1 : 0 };
      },
      setProp(id, v) {
        if (id === b.field) set(truthy(v));
      },
      interact(e) {
        if (e.kind === "press") set(true);
        else if (e.kind === "release") set(false);
        else if (e.kind === "set" && (!e.key || e.key === b.field)) set(truthy(e.value as PropValue));
      },
      diagnostics: () => power.diagnostics(`its ${b.output} pin is not driven`),
    };
  };
}

// ------------------------------------------------------------------ analog sensor

function analogSensor(part: CustomPart, b: B<"analog-sensor">): PartModelFactory {
  const q = b.quantity;
  const curve = b.curve.map((p) => ({ x: p.value, y: p.volts }));
  return (ctx) => {
    const power = new Power(ctx, supplyOf(part));
    let value = clamp(num(ctx.props[q.id], q.default), q.min, q.max);
    const volts = () => {
      const v = interpolate(curve, value) * (b.ratiometric && power.hasPin ? power.volts / 5 : 1);
      return clamp(v, 0, power.hasPin ? Math.max(0, power.volts) : 5);
    };
    const dActive = () => (b.digital ? (b.digital.when === "above" ? value > b.digital.threshold : value < b.digital.threshold) : false);
    const set = (v: number) => {
      const n = clamp(v, q.min, q.max);
      if (n === value) return;
      value = n;
      ctx.requestSolve();
    };
    return {
      stamp(c) {
        power.stamp(c);
        if (!power.on) return;
        c.voltageSource(ctx.node(b.output), "0", volts(), b.output_ohms, { id: "out" });
        if (b.digital) {
          const hi = dActive() ? b.digital.active_level === "high" : b.digital.active_level !== "high";
          c.voltageSource(ctx.node(b.digital.output), "0", hi ? power.high : 0, 100, { id: "dout" });
        }
      },
      onSolved(r) {
        if (power.read(r)) ctx.requestSolve();
      },
      visualState(): VisualState {
        return {
          [q.id]: value,
          volts: power.on ? round(volts()) : 0,
          powered: power.on,
          ...(b.digital ? { triggered: power.on && dActive() } : {}),
          label: power.on ? `${fmt(value)}${q.unit ? ` ${q.unit}` : ""}` : "off",
        };
      },
      setProp(id, v) {
        if (id === q.id) set(num(v, value));
      },
      interact(e) {
        if (e.kind === "set" && (!e.key || e.key === q.id)) set(num(e.value as PropValue, value));
      },
      diagnostics: () => power.diagnostics(`its ${b.output} output reads 0 V`),
    };
  };
}

// ------------------------------------------------------------------ actuator

function actuator(part: CustomPart, b: B<"actuator">): PartModelFactory {
  return (ctx) => {
    const power = new Power(ctx, supplyOf(part));
    // load
    const ratedV = b.rated_v ?? 5;
    const ratedMa = b.rated_ma ?? (part.current_ma?.typ || 100);
    const ohms = ratedV / (ratedMa / 1000);
    let el: ElementId = "";
    let vAcross = 0;
    let amps = 0;
    // logic
    let on = false;
    let duty = 0;
    const levelNow = () => (b.drive === "load" ? clamp(Math.abs(vAcross) / ratedV, 0, 1) : on ? duty : 0);
    const running = () => (b.drive === "load" ? (b.polarized ? vAcross : Math.abs(vAcross)) >= 0.25 * ratedV : on);

    return {
      stamp(c) {
        if (b.drive === "load") {
          const plus = ctx.node(b.plus!);
          const minus = ctx.node(b.minus!);
          if (b.polarized) {
            const mid = ctx.internalNode("k");
            el = c.diode(plus, mid, { vf: 0.3, rOn: 1 }, { id: "d" });
            c.resistor(mid, minus, ohms, { id: "load" });
          } else el = c.resistor(plus, minus, ohms, { id: "load" });
          return;
        }
        power.stamp(c, on ? 1 : 0.05);
        const input = ctx.node(b.input!);
        // An active-low input sinks current from VCC through the module (optocoupler LED);
        // an active-high input loads the GPIO to ground.
        if (b.active_level === "low" && power.s.vcc) c.resistor(input, ctx.node(power.s.vcc), b.input_ohms, { id: "input" });
        else c.resistor(input, "0", b.input_ohms, { id: "input" });
        if (b.contacts) {
          const com = ctx.node(b.contacts.com);
          if (b.contacts.no) c.switch(com, ctx.node(b.contacts.no), on, { id: "no" });
          if (b.contacts.nc) c.switch(com, ctx.node(b.contacts.nc), !on, { id: "nc" });
        }
      },
      onSolved(r) {
        if (b.drive === "load") {
          vAcross = r.voltage(ctx.node(b.plus!)) - r.voltage(ctx.node(b.minus!));
          amps = Math.abs(r.current(el));
          return;
        }
        const changedPower = power.read(r);
        const pwm = ctx.pwm?.(b.input!);
        const vin = r.voltage(ctx.node(b.input!));
        const threshold = Math.max(0.8, power.high * 0.5);
        let d: number;
        if (pwm?.averaged) d = b.active_level === "high" ? pwm.duty : 1 - pwm.duty;
        else {
          const lvl = ctx.digital ? ctx.digital(b.input!, threshold) : vin > threshold ? 1 : 0;
          d = (b.active_level === "high" ? lvl === 1 : lvl === 0) ? 1 : 0;
        }
        const nowOn = power.on && d > 0.02;
        duty = d;
        if (nowOn !== on || changedPower) {
          on = nowOn;
          ctx.requestSolve();
        }
      },
      visualState(): VisualState {
        const lvl = round(levelNow());
        const run = running();
        return {
          on: run,
          level: lvl,
          ...(b.drive === "load" ? { volts: round(vAcross), current_ma: round(amps * 1000, 1), direction: run ? Math.sign(vAcross) : 0 } : { powered: power.on }),
          ...(b.effect ? { [b.effect.id]: round(run ? lvl * b.effect.at_full : 0, 2) } : {}),
          ...(b.force_n !== undefined ? { force_n: round(run ? lvl * b.force_n : 0, 3) } : {}),
          label: run ? (b.effect ? `${fmt(lvl * b.effect.at_full)}${b.effect.unit ? ` ${b.effect.unit}` : ""}` : lvl < 0.99 ? `on ${Math.round(lvl * 100)}%` : "on") : "off",
          ledOpacity: run ? Math.max(0.3, lvl) : 0,
        };
      },
      setProp() {},
      diagnostics(): Diagnostic[] {
        const out: Diagnostic[] = [];
        if (b.drive === "load") {
          const gpio = ctx.pwm?.(b.plus!) ?? ctx.pwm?.(b.minus!);
          if (gpio && amps * 1000 > GPIO_MAX_MA) {
            out.push({
              severity: "error",
              code: "gpio-overcurrent",
              pin: b.plus!,
              message: `${ctx.id} (${part.name}) draws ${Math.round(amps * 1000)} mA straight from a board pin; a GPIO gives 20 mA (40 mA absolute max), so the real pin would sag or burn. Drive it through an NPN transistor / logic-level MOSFET (with a flyback diode for motors, pumps and solenoids), a relay module or a motor driver.`,
            });
          }
          if (b.polarized && vAcross < -0.5) out.push({ severity: "warning", code: "custom-reversed", pin: b.plus!, message: `${ctx.id} is wired backwards (${vAcross.toFixed(1)} V across it) and stays off. Swap ${b.plus} and ${b.minus}.` });
          else if (Math.abs(vAcross) > ratedV * 1.25) out.push({ severity: "warning", code: "custom-overvoltage", pin: b.plus!, message: `${ctx.id} gets ${Math.abs(vAcross).toFixed(1)} V, above its rated ${ratedV} V. Use a lower supply or a driver with a lower output.` });
          return out;
        }
        return power.diagnostics(`its ${b.input} input does nothing`);
      },
    };
  };
}

// ------------------------------------------------------------------ I2C register-map device

/** Raw register bytes for a field value (two's complement when signed, clamped to the width). */
export function encodeField(value: number, scale: number, offset: number, bytes: number, signed: boolean, endian: "big" | "little"): number[] {
  const bits = bytes * 8;
  const lo = signed ? -(2 ** (bits - 1)) : 0;
  const hi = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  let raw = clamp(Math.round(value * scale + offset), lo, hi);
  if (raw < 0) raw += 2 ** bits;
  const out: number[] = [];
  for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(raw / 2 ** (8 * i)) & 0xff);
  return endian === "big" ? out : out.reverse();
}

function rawToInt(bytes: number[], endian: "big" | "little"): number {
  const bs = endian === "big" ? bytes : [...bytes].reverse();
  return bs.reduce((a, b) => a * 256 + b, 0);
}

function i2cDevice(part: CustomPart, b: B<"i2c-device">): PartModelFactory {
  const s = supplyOf(part);
  return (ctx) => {
    const mod = createI2cModule(ctx, { vccPin: s.vcc!, gndPin: s.gnd ?? "GND", supplymA: s.typMa > 0 ? s.typMa : 1, minVolts: s.minV, maxVolts: s.maxV });
    const mem = new Uint8Array(256).fill(b.default_byte);
    const writable = new Uint8Array(256);
    const fields = b.registers.filter((r) => r.field);
    const values: Record<string, number> = {};
    const load = (r: (typeof b.registers)[number]) => {
      let bytes: number[];
      if (r.field) {
        const v = clamp(num(ctx.props[r.field.id], values[r.field.id] ?? r.field.default), r.field.min, r.field.max);
        values[r.field.id] = v;
        bytes = encodeField(v, r.field.scale, r.field.offset, r.bytes, r.field.signed, r.endian);
      } else bytes = encodeField(r.value ?? 0, 1, 0, r.bytes, (r.value ?? 0) < 0, r.endian);
      bytes.forEach((x, i) => (mem[(r.reg + i) & 0xff] = x));
    };
    for (const r of b.registers) {
      load(r);
      if (r.writable) for (let i = 0; i < r.bytes; i++) writable[(r.reg + i) & 0xff] = 1;
    }
    if (b.who_am_i) mem[b.who_am_i.reg] = b.who_am_i.value;
    let ptr = 0;
    let expectReg = false;
    let reads = 0;
    let writes = 0;
    let ignored = 0;
    let lastIgnored = -1;

    const setProp = (id: string, v: PropValue) => {
      if (id === "address") mod.setAddressProp(v);
      const r = fields.find((f) => f.field!.id === id);
      if (r) {
        values[id] = clamp(num(v, values[id]!), r.field!.min, r.field!.max);
        const bytes = encodeField(values[id]!, r.field!.scale, r.field!.offset, r.bytes, r.field!.signed, r.endian);
        bytes.forEach((x, i) => (mem[(r.reg + i) & 0xff] = x));
      }
    };

    const dev: I2cDevice = {
      i2cAddress: () => mod.address(),
      i2cConnect(read) {
        if (!mod.powered) return false;
        if (!read) expectReg = true;
        return true;
      },
      i2cWrite(byte) {
        if (expectReg) {
          ptr = byte & 0xff;
          expectReg = false;
          return true;
        }
        if (writable[ptr]) {
          mem[ptr] = byte & 0xff;
          writes++;
        } else {
          ignored++;
          lastIgnored = ptr;
        }
        if (b.auto_increment) ptr = (ptr + 1) & 0xff;
        return true;
      },
      i2cRead() {
        const v = mem[ptr]!;
        reads++;
        if (b.auto_increment) ptr = (ptr + 1) & 0xff;
        return v;
      },
      i2cStop() {
        expectReg = false;
      },
    };

    return {
      i2c: dev,
      stamp: (c) => mod.stamp(c),
      onSolved: (r) => mod.onSolved(r),
      visualState(): VisualState {
        const st: VisualState = { address: hex2(mod.address()), powered: mod.powered, reads, writes };
        for (const f of fields) st[f.field!.id] = values[f.field!.id]!;
        for (const r of b.registers) if (r.name) st[r.name] = rawToInt(Array.from(mem.subarray(r.reg, r.reg + r.bytes)), r.endian);
        const shown = fields[0]?.field;
        st.label = !mod.powered ? "off" : shown ? `${fmt(values[shown.id]!)}${shown.unit ? ` ${shown.unit}` : ""}` : `I2C ${hex2(mod.address())}`;
        return st;
      },
      setProp,
      interact(e) {
        if (e.kind === "set" && e.key) setProp(e.key, e.value as PropValue);
      },
      diagnostics(): Diagnostic[] {
        const out = mod.diagnostics();
        if (ignored > 0) out.push({ severity: "info", code: "custom-i2c-readonly-write", message: `${ctx.id} ignored ${ignored} byte(s) written to register ${hex2(lastIgnored)}, which its part.json does not mark writable. If the firmware is right, mark that register writable: true with update_part.` });
        return out;
      },
    };
  };
}

// ------------------------------------------------------------------ UART line device

function uartDevice(part: CustomPart, b: B<"uart-device">): PartModelFactory {
  return (ctx) => {
    const power = new Power(ctx, supplyOf(part));
    const values: Record<string, number> = {};
    for (const f of b.fields ?? []) values[f.id] = clamp(num(ctx.props[f.id], f.default), f.min, f.max);
    const fill = (text: string) =>
      text.replace(/\{([a-z][a-zA-Z0-9_]*)\}/g, (m, id: string) => {
        const f = b.fields?.find((x) => x.id === id);
        return f ? values[id]!.toFixed(f.decimals) : m;
      });
    const tx = new UartTransmitter(ctx, () => b.baud, () => ctx.requestSolve());
    let line = "";
    let lines = 0;
    let replies = 0;
    let lastLine = "";
    let lastReply = "";
    let unmatched = 0;
    let streamAcc = 0;
    let wasOn = !power.hasPin;
    let greeted = false;

    const send = (text: string, delay = 0) => {
      const out = fill(text).split("\n").map((l) => l.replace(/\r$/, "")).join(b.newline) + b.newline;
      const go = () => {
        if (!power.on) return;
        replies++;
        lastReply = fill(text);
        tx.send(out);
      };
      if (delay > 0 && ctx.schedule) ctx.schedule(delay, go);
      else go();
    };
    const onLine = (l: string) => {
      lines++;
      lastLine = l;
      const hit = b.responses.find((r) => (r.mode === "exact" ? l === r.match : r.mode === "prefix" ? l.startsWith(r.match) : l.includes(r.match)));
      if (hit) send(hit.reply, hit.delay_ms);
      else {
        unmatched++;
        if (b.unknown_reply !== undefined) send(b.unknown_reply);
      }
    };
    const rx = new UartReceiver(ctx, b.rx, () => b.baud, (byte) => {
      if (!power.on) return;
      if (b.echo) tx.send(String.fromCharCode(byte));
      if (byte === 0x0a || byte === 0x0d) {
        if (line.length) onLine(line);
        line = "";
      } else if (line.length < 512) line += String.fromCharCode(byte);
    });
    const powerUp = () => {
      if (b.greeting && !greeted) {
        greeted = true;
        send(b.greeting, 1);
      }
    };
    // Parts without a supply pin are on from 0 ms: greet once the simulation runs.
    if (wasOn && ctx.schedule) ctx.schedule(1, powerUp);
    const setProp = (id: string, v: PropValue) => {
      const f = b.fields?.find((x) => x.id === id);
      if (f) values[id] = clamp(num(v, values[id]!), f.min, f.max);
    };

    return {
      stamp(c) {
        power.stamp(c);
        c.voltageSource(ctx.node(b.tx), "0", power.on ? (tx.level ? power.high : 0) : 0, power.on ? 50 : 1e9, { id: "tx" });
      },
      onSolved(r) {
        if (power.read(r)) {
          const on = power.on;
          if (on && !wasOn) powerUp();
          if (!on) {
            tx.clear();
            line = "";
            greeted = false;
          }
          wasOn = on;
          ctx.requestSolve();
        }
      },
      tick(_t, dt) {
        if (!b.stream || !power.on) return;
        streamAcc += dt;
        if (streamAcc >= b.stream.every_ms) {
          streamAcc -= b.stream.every_ms;
          send(b.stream.text);
        }
      },
      visualState(): VisualState {
        return {
          powered: power.on,
          baud: b.baud,
          lines_received: lines,
          replies_sent: replies,
          unmatched,
          last_line: lastLine,
          last_reply: lastReply,
          framing_errors: rx.framingErrors,
          ...values,
          label: !power.on ? "off" : lastLine ? `< ${lastLine.slice(0, 14)}` : `UART ${b.baud}`,
        };
      },
      setProp,
      interact(e) {
        if (e.kind === "set" && e.key) setProp(e.key, e.value as PropValue);
      },
      dispose() {
        rx.dispose();
        tx.clear();
      },
      diagnostics(): Diagnostic[] {
        const out = power.diagnostics(`it does not answer on ${b.tx}`);
        if (rx.framingErrors > 0) out.push({ severity: "warning", code: "custom-uart-baud", pin: b.rx, message: `${ctx.id} saw ${rx.framingErrors} byte(s) with a bad stop bit: the sketch talks at a different baud rate. This part listens at ${b.baud} baud (SoftwareSerial s(rx, tx); s.begin(${b.baud});).` });
        return out;
      },
    };
  };
}

export const BEHAVIOR_MODELS = { digitalInput, analogSensor, actuator, i2cDevice, uartDevice };
