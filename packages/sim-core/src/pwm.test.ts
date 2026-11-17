import { describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import {
  createMcuBoardModel,
  createRegistry,
  PwmMeter,
  Simulation,
  type ElementId,
  type Fidelity,
  type McuBackend,
  type PartDefinition,
  type PartSpec,
  type PinState,
} from "./index.ts";

/**
 * A fake MCU whose "firmware" is a PWM schedule: pin D5 toggles with `periodCycles` and a duty
 * the test can change; D9 can send servo-like pulses. 1 MHz clock (1 cycle = 1 µs).
 */
class PwmMcu implements McuBackend {
  readonly cyclesPerSecond = 1_000_000;
  readonly vcc = 5;
  readonly pinIds = ["D5", "D9"] as const;
  cycles = 0;
  duty = 0.5;
  periodCycles = 2048; // ≈ 488 Hz
  /** Stop toggling (analogWrite(0) / (255)) and hold this level. */
  hold: 0 | 1 | undefined;
  servoUs: number | undefined;
  stopAtCalls: number[] = [];
  private pins = new Map<string, PinState>([
    ["D5", { mode: "input", value: 0 }],
    ["D9", { mode: "input", value: 0 }],
  ]);
  private cbs = new Set<(p: string, s: PinState, c: number) => void>();
  private stepEnd = 0;
  load() {}
  reset() {
    this.cycles = 0;
  }
  readPin(id: string) {
    return { ...this.pins.get(id)! };
  }
  setPinInput() {}
  onSerial() {
    return () => {};
  }
  onPinChange(cb: (p: string, s: PinState, c: number) => void) {
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  }
  stopAt(cycle: number) {
    this.stopAtCalls.push(cycle);
    if (cycle < this.stepEnd) this.stepEnd = Math.max(this.cycles, cycle);
  }
  private set(id: string, value: 0 | 1) {
    const s = this.pins.get(id)!;
    if (s.mode === "output" && s.value === value) return;
    this.pins.set(id, { mode: "output", value });
    for (const cb of this.cbs) cb(id, { mode: "output", value }, this.cycles);
  }
  /** Level of D5 / D9 at absolute cycle c. */
  private d5(c: number): 0 | 1 {
    if (this.hold !== undefined) return this.hold;
    return c % this.periodCycles < Math.round(this.duty * this.periodCycles) ? 1 : 0;
  }
  private d9(c: number): 0 | 1 {
    return this.servoUs !== undefined && c % 20_000 < this.servoUs ? 1 : 0;
  }
  step(n: number) {
    this.stepEnd = this.cycles + n;
    // advance one cycle at a time is too slow; jump between edges.
    while (this.cycles < this.stepEnd) {
      this.set("D5", this.d5(this.cycles));
      this.set("D9", this.d9(this.cycles));
      // next edge of either pin
      const nextD5 = this.hold !== undefined ? Infinity : this.nextEdge(this.cycles, this.periodCycles, Math.round(this.duty * this.periodCycles));
      const nextD9 = this.servoUs === undefined ? Infinity : this.nextEdge(this.cycles, 20_000, this.servoUs);
      this.cycles = Math.min(this.stepEnd, nextD5, nextD9);
    }
  }
  private nextEdge(c: number, period: number, high: number): number {
    const base = c - (c % period);
    for (const e of [base + high, base + period, base + period + high]) if (e > c) return e;
    return base + 2 * period;
  }
}

const fid: Fidelity = {
  level: "behavioral",
  areas: { logic: { level: "ok", note: "" }, timing: { level: "n/a", note: "" }, analog: { level: "approx", note: "" }, power: { level: "n/a", note: "" }, radio: { level: "n/a", note: "" } },
  emulates: [],
  doesNotEmulate: [],
  testOnRealDevice: [],
};
const pin = (id: string, type: PartSpec["pins"][number]["type"] = "passive") => ({ id, label: id, x: 0, y: 0, type });
const board: PartDefinition = {
  spec: { id: "pwm-board", name: "PWM board", category: "board", description: "", size: { w: 10, h: 10 }, pins: [pin("D5", "digital"), pin("D9", "digital"), pin("GND", "ground")], mcu: { backend: "fake", chip: "fake", clockHz: 1_000_000, vcc: 5 } },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => createMcuBoardModel(ctx),
};
/** 220 Ω + red LED (vf 2.0, rOn 5) in series, current readable from visualState. */
let ledSeen: { mA: number; pwm: ReturnType<NonNullable<import("./part.ts").PartContext["pwm"]>> }[] = [];
const ledLoad: PartDefinition = {
  spec: { id: "led-load", name: "LED load", category: "output", description: "", size: { w: 10, h: 10 }, pins: [pin("A"), pin("C")] },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => {
    let id: ElementId | undefined;
    let mA = 0;
    return {
      stamp(c) {
        const mid = ctx.internalNode("mid");
        c.resistor(ctx.node("A"), mid, 220);
        id = c.led(mid, ctx.node("C"), { vf: 2.0, rOn: 5 });
      },
      onSolved(r) {
        mA = id ? r.current(id) * 1000 : 0;
        ledSeen.push({ mA, pwm: ctx.pwm?.("A") });
      },
      visualState: () => ({ mA }),
      setProp() {},
    };
  },
};
/** Records every pin it sees and schedules an echo like an HC-SR04: 300 µs after a D9 fall, for 100 µs. */
const ticker: PartDefinition = {
  spec: { id: "ticker", name: "Ticker", category: "misc", description: "", size: { w: 10, h: 10 }, pins: [pin("IN")] },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => {
    let ticks = 0;
    let lastHighUs = 0;
    let fired: number[] = [];
    return {
      stamp() {},
      onSolved() {
        const pw = ctx.pwm?.("IN");
        if (pw && pw.level === 0 && pw.highUs > 0 && pw.sinceEdgeUs === 0) {
          // a falling edge right now
          lastHighUs = pw.highUs;
          ctx.schedule?.(0.3, () => fired.push(ctx.now()));
        }
      },
      tick() {
        ticks++;
      },
      visualState: () => ({ ticks, lastHighUs, fired: fired.join(",") }),
      setProp() {},
      dispose() {
        fired = [];
      },
    };
  },
};

const registry = createRegistry([board, ledLoad, ticker]);
const project = parseProject({
  format: "fabwright/1",
  name: "pwm",
  parts: [
    { id: "b", type: "pwm-board", x: 0, y: 0 },
    { id: "led", type: "led-load", x: 0, y: 0 },
    { id: "t", type: "ticker", x: 0, y: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "b", pin: "D5" }, to: { part: "led", pin: "A" } },
    { id: "w2", from: { part: "led", pin: "C" }, to: { part: "b", pin: "GND" } },
    { id: "w3", from: { part: "b", pin: "D9" }, to: { part: "t", pin: "IN" } },
  ],
  firmware: { board: "b", artifact: "x.hex" },
});

const make = (setup?: (m: PwmMcu) => void) => {
  let mcu!: PwmMcu;
  const sim = new Simulation({
    project,
    registry,
    backendFactory: () => {
      mcu = new PwmMcu();
      setup?.(mcu);
      return mcu;
    },
  });
  let solves = 0;
  sim.subscribe((e) => {
    if (e.type === "solved") solves++;
  });
  return { sim, mcu, solves: () => solves };
};

describe("PwmMeter", () => {
  it("measures duty, period and pulse width from cycle stamps", () => {
    const m = new PwmMeter("D5", 16_000_000);
    m.change("output", 0, 0);
    let c = 0;
    for (let i = 0; i < 5; i++) {
      m.change("output", 1, c);
      m.change("output", 0, c + 4096); // 25 % of 16384 cycles (≈ 976.6 Hz)
      c += 16384;
    }
    m.change("output", 1, c);
    const r = m.reading(c);
    expect(r.averaged).toBe(true);
    expect(r.duty).toBeCloseTo(0.25, 6);
    expect(r.periodUs).toBeCloseTo(1024, 6);
    expect(r.freqHz).toBeCloseTo(976.5625, 3);
    expect(r.highUs).toBeCloseTo(256, 6);
    expect(r.source).toBe("mcu:D5");
  });

  it("keeps 50 Hz servo pulses per-edge and reports the pulse width", () => {
    const m = new PwmMeter("D9", 16_000_000);
    expect(m.change("output", 0, 0)).toBe(true);
    let c = 0;
    for (let i = 0; i < 4; i++) {
      expect(m.change("output", 1, c)).toBe(true);
      expect(m.change("output", 0, c + 1500 * 16)).toBe(true);
      c += 20_000 * 16;
    }
    expect(m.averaged).toBe(false);
    expect(m.reading(c).highUs).toBeCloseTo(1500, 6);
    expect(m.reading(c).periodUs).toBeCloseTo(20_000, 6);
  });

  it("asks for a re-solve only when an averaged duty moves by more than 0.4 %", () => {
    const m = new PwmMeter("D5", 1_000_000);
    m.change("output", 0, 0);
    const seq: boolean[] = [];
    let c = 0;
    const period = (high: number) => {
      seq.push(m.change("output", 1, c));
      m.change("output", 0, c + high);
      c += 1000;
    };
    for (let i = 0; i < 4; i++) period(500);
    m.markSolved();
    seq.length = 0;
    period(500);
    period(502); // 0.2 %: no
    period(502);
    period(700); // measured at the next rise
    period(700);
    expect(seq).toEqual([false, false, false, false, true]);
  });

  it("falls back to per-edge when the signal stops", () => {
    const m = new PwmMeter("D5", 1_000_000);
    m.change("output", 0, 0);
    for (let i = 0; i < 4; i++) {
      m.change("output", 1, i * 1000);
      m.change("output", 0, i * 1000 + 300);
    }
    expect(m.averaged).toBe(true);
    expect(m.checkStale(3000 + 2000)).toBe(false);
    expect(m.checkStale(3300 + 3001)).toBe(true);
    expect(m.averaged).toBe(false);
    expect(m.duty).toBe(0);
  });
});

describe("Simulation with PWM", () => {
  it("LED current is duty × on-current, with a handful of solves instead of one per edge", () => {
    ledSeen = [];
    const { sim, solves } = make((m) => (m.duty = 0.25));
    sim.runFor(1000);
    const edges = sim.trace.filter((e) => e.kind === "pin" && e.pin === "D5").length;
    expect(edges).toBeGreaterThan(900); // 488 Hz → ~977 edges
    expect(solves()).toBeLessThan(30);
    const full = (5 - 2.0) / (220 + 5 + 25); // 12 mA when HIGH
    expect(Number(sim.partState("led")!.mA)).toBeCloseTo(0.25 * full * 1000, 1);
    const pw = sim.pwm("b", "D5")!;
    expect(pw).toMatchObject({ averaged: true, source: "mcu:D5" });
    expect(pw.duty).toBeCloseTo(0.25, 3);
    expect(pw.freqHz).toBeCloseTo(1e6 / 2048, 3);
    // Parts on the PWM net see the same reading through ctx.pwm.
    expect(ledSeen.at(-1)!.pwm).toMatchObject({ averaged: true, source: "mcu:D5" }); // the anode is on D5's net
  });

  it("re-solves when analogWrite changes the duty and when PWM stops", () => {
    const { sim, mcu } = make((m) => (m.duty = 0.25));
    sim.runFor(200);
    mcu.duty = 0.75;
    sim.runFor(200);
    const full = (5 - 2.0) / 250;
    expect(Number(sim.partState("led")!.mA)).toBeCloseTo(0.75 * full * 1000, 1);
    mcu.hold = 1; // analogWrite(255): pin just stays HIGH
    sim.runFor(50);
    expect(sim.pwm("b", "D5")!.averaged).toBe(false);
    expect(Number(sim.partState("led")!.mA)).toBeCloseTo(full * 1000, 1);
  });

  it("ticks parts every 1 ms and measures servo pulses to the cycle", () => {
    const { sim, mcu } = make((m) => {
      m.servoUs = 1500;
      m.duty = 0.5;
    });
    sim.runFor(100);
    expect(sim.partState("t")!.ticks).toBe(100);
    expect(sim.partState("t")!.lastHighUs).toBe(1500);
    const pw = sim.pwm("t", "IN")!;
    expect(pw).toMatchObject({ averaged: false, highUs: 1500, periodUs: 20_000 });
    // ctx.schedule(0.3 ms) after each pulse's falling edge fired exactly 300 µs later, and the MCU step was cut short for it.
    const fired = String(sim.partState("t")!.fired).split(",").map(Number);
    expect(fired.slice(0, 3)).toEqual([1.5 + 0.3, 21.5 + 0.3, 41.5 + 0.3]);
    expect(mcu.stopAtCalls.length).toBeGreaterThan(0);
  });

  it("is deterministic under any runFor slicing", () => {
    const a = make((m) => (m.duty = 0.3));
    const b = make((m) => (m.duty = 0.3));
    a.sim.runFor(500);
    for (let i = 0; i < 31; i++) b.sim.runFor(16);
    b.sim.runFor(4);
    expect(a.sim.traceHash()).toBe(b.sim.traceHash());
    expect(a.sim.partState("led")).toEqual(b.sim.partState("led"));
    expect(a.sim.partState("t")).toEqual(b.sim.partState("t"));
  });

  it("every() calls back at fixed virtual times and survives reset", () => {
    const { sim } = make();
    const at: number[] = [];
    sim.every(4, (t) => at.push(t));
    sim.runFor(10);
    sim.runFor(7);
    expect(at).toEqual([4, 8, 12, 16]);
    sim.reset();
    at.length = 0;
    sim.runFor(9);
    expect(at).toEqual([4, 8]);
    expect(() => sim.every(0, () => {})).toThrow(/periodMs must be > 0/);
  });
});
