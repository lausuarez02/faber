import { describe, expect, it } from "vitest";
import { parseProject, type ProjectInput } from "@jumper/project-format";
import {
  createMcuBoardModel,
  createRegistry,
  Simulation,
  type BackendFactory,
  type ElementId,
  type Fidelity,
  type McuBackend,
  type PartDefinition,
  type PartSpec,
  type PinState,
} from "./index.ts";

/**
 * A fake MCU: "firmware" sets D13 as OUTPUT, D2 as INPUT_PULLUP, toggles D13 every 500 ms and,
 * on every toggle, prints '1' or '0' on serial for the level it reads on D2.
 */
class FakeMcu implements McuBackend {
  readonly cyclesPerSecond = 1_000_000;
  readonly vcc = 5;
  readonly pinIds = ["D2", "D13"] as const;
  cycles = 0;
  private loaded = false;
  private started = false;
  private pins = new Map<string, PinState>([
    ["D2", { mode: "input", value: 0 }],
    ["D13", { mode: "input", value: 0 }],
  ]);
  private pinCbs = new Set<(p: string, s: PinState, c: number) => void>();
  private serialCbs = new Set<(b: number, c: number) => void>();
  readonly half = 500_000; // 500 ms

  load(fw: Uint8Array | string) {
    this.loaded = fw === "fake-blink";
    this.reset();
  }
  reset() {
    this.cycles = 0;
    this.started = false;
    this.pins.set("D2", { mode: "input", value: 0 });
    this.pins.set("D13", { mode: "input", value: 0 });
  }
  readPin(id: string) {
    return { ...this.pins.get(id)! };
  }
  setPinInput(id: string, volts: number) {
    const p = this.pins.get(id)!;
    if (p.mode !== "output") p.value = volts > this.vcc / 2 ? 1 : 0;
  }
  private set(id: string, s: PinState) {
    this.pins.set(id, s);
    for (const cb of this.pinCbs) cb(id, { ...s }, this.cycles);
  }
  step(n: number) {
    if (!this.loaded) {
      this.cycles += n;
      return;
    }
    const end = this.cycles + n;
    if (!this.started) {
      this.started = true;
      this.set("D2", { mode: "input_pullup", value: this.pins.get("D2")!.value });
      this.set("D13", { mode: "output", value: 0 });
    }
    for (;;) {
      const nextToggle = (Math.floor(this.cycles / this.half) + 1) * this.half;
      if (nextToggle > end) break;
      this.cycles = nextToggle;
      const v = this.pins.get("D13")!.value ? 0 : 1;
      this.set("D13", { mode: "output", value: v });
      const b = this.pins.get("D2")!.value ? 0x31 : 0x30;
      for (const cb of this.serialCbs) cb(b, this.cycles);
    }
    this.cycles = end;
  }
  onPinChange(cb: (p: string, s: PinState, c: number) => void) {
    this.pinCbs.add(cb);
    return () => this.pinCbs.delete(cb);
  }
  onSerial(cb: (b: number, c: number) => void) {
    this.serialCbs.add(cb);
    return () => this.serialCbs.delete(cb);
  }
}

const fid: Fidelity = {
  level: "behavioral",
  areas: {
    logic: { level: "ok", note: "" },
    timing: { level: "n/a", note: "" },
    analog: { level: "approx", note: "" },
    power: { level: "n/a", note: "" },
    radio: { level: "n/a", note: "" },
  },
  emulates: [],
  doesNotEmulate: [],
  testOnRealDevice: [],
};
const pin = (id: string, type: PartSpec["pins"][number]["type"] = "passive") => ({ id, label: id, x: 0, y: 0, type });

const board: PartDefinition = {
  spec: {
    id: "fake-board",
    name: "Fake board",
    category: "board",
    description: "",
    size: { w: 10, h: 10 },
    pins: [pin("D2", "digital"), pin("D13", "digital"), pin("GND", "ground"), pin("5V", "power")],
    mcu: { backend: "fake", chip: "fake", clockHz: 1_000_000, vcc: 5 },
  },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => createMcuBoardModel(ctx, { rails: { "5V": 5 } }),
};

const resistor: PartDefinition = {
  spec: {
    id: "resistor",
    name: "Resistor",
    category: "passive",
    description: "",
    size: { w: 10, h: 10 },
    pins: [pin("1"), pin("2")],
    props: [{ id: "resistance", label: "R", type: "number", default: 220, unit: "Ω" }],
  },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => {
    let ohms = Number(ctx.props.resistance);
    return {
      stamp: (c) => void c.resistor(ctx.node("1"), ctx.node("2"), ohms),
      visualState: () => ({ resistance: ohms }),
      setProp: (id, v) => {
        if (id === "resistance") ohms = Number(v);
      },
    };
  },
};

const led: PartDefinition = {
  spec: {
    id: "led",
    name: "LED",
    category: "output",
    description: "",
    size: { w: 10, h: 10 },
    pins: [pin("A"), pin("C")],
    limits: { maxCurrentmA: 20 },
  },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => {
    let id: ElementId = "";
    let mA = 0;
    return {
      stamp: (c) => {
        id = c.led(ctx.node("A"), ctx.node("C"), { vf: 2.0, rOn: 5 });
      },
      onSolved: (r) => {
        mA = r.current(id) * 1000;
      },
      visualState: () => ({ brightness: Math.max(0, Math.min(1, mA / 20)), currentmA: mA }),
      setProp: () => {},
      diagnostics: () => (mA > 20 ? [{ severity: "error" as const, code: "led-overcurrent", message: `${mA.toFixed(0)} mA` }] : []),
    };
  },
};

const button: PartDefinition = {
  spec: {
    id: "button",
    name: "Button",
    category: "input",
    description: "",
    size: { w: 10, h: 10 },
    pins: [pin("1"), pin("2")],
  },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => {
    let pressed = false;
    return {
      stamp: (c) => void c.switch(ctx.node("1"), ctx.node("2"), pressed),
      visualState: () => ({ pressed }),
      setProp: () => {},
      interact: (e) => {
        if (e.kind === "press") pressed = true;
        if (e.kind === "release") pressed = false;
      },
    };
  },
};

const registry = createRegistry([board, resistor, led, button]);
const backendFactory: BackendFactory = () => new FakeMcu();

const input: ProjectInput = {
  format: "jumper/1",
  name: "fake blink",
  parts: [
    { id: "b", type: "fake-board", x: 0, y: 0 },
    { id: "r1", type: "resistor", x: 0, y: 0 },
    { id: "led1", type: "led", x: 0, y: 0 },
    { id: "btn", type: "button", x: 0, y: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "b", pin: "D13" }, to: { part: "r1", pin: "1" } },
    { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" } },
    { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "b", pin: "GND" } },
    { id: "w4", from: { part: "b", pin: "D2" }, to: { part: "btn", pin: "1" } },
    { id: "w5", from: { part: "btn", pin: "2" }, to: { part: "b", pin: "GND" } },
  ],
  firmware: { board: "b", artifact: "firmware/fake.hex" },
};
const project = parseProject(input);
const make = (chunkMs?: number) =>
  new Simulation({ project, registry, backendFactory, firmware: "fake-blink", ...(chunkMs ? { chunkMs } : {}) });

describe("Simulation", () => {
  it("maps ground pins to node 0 and wired pins to shared nets", () => {
    const sim = make();
    expect(sim.nodeOf("led1", "C")).toBe("0");
    expect(sim.nodeOf("b", "D13")).toBe(sim.nodeOf("r1", "1"));
    expect(sim.nodeOf("b", "5V")).not.toBe("0");
    expect(sim.pinVoltage("b", "5V")).toBeCloseTo(5, 3);
  });

  it("blinks the LED from MCU pin changes", () => {
    const sim = make();
    sim.runFor(100);
    expect(sim.partState("led1")!.brightness).toBe(0);
    sim.runFor(500); // t = 600 ms, D13 HIGH since 500 ms
    const s = sim.partState("led1")!;
    expect(s.currentmA as number).toBeGreaterThan(11);
    expect(s.currentmA as number).toBeLessThan(13);
    expect(sim.partState("b")!.pin_D13).toBe(1);
    sim.runFor(500); // t = 1100 ms, LOW again
    expect(sim.partState("led1")!.brightness).toBe(0);
    expect(sim.timeMs).toBe(1100);
    const toggles = sim.trace.filter((t) => t.kind === "pin" && t.pin === "D13" && t.mode === "output");
    expect(toggles.map((t) => t.cycle)).toEqual([0, 500_000, 1_000_000]);
  });

  it("feeds net voltages back into MCU inputs (pull-up + button)", () => {
    const sim = make();
    sim.runFor(1100);
    expect(sim.serialText()).toBe("11"); // pull-up reads HIGH
    sim.interact("btn", { kind: "press" });
    expect(sim.pinVoltage("b", "D2")).toBeLessThan(0.1);
    sim.runFor(1000);
    expect(sim.serialText()).toBe("1100");
    sim.interact("btn", { kind: "release" });
    sim.runFor(500);
    expect(sim.serialText()).toBe("11001");
  });

  it("is deterministic and independent of chunk size", () => {
    const a = make();
    const b = make(7);
    a.runFor(3000);
    for (let i = 0; i < 30; i++) b.runFor(100);
    expect(a.trace.length).toBeGreaterThan(5);
    expect(a.traceHash()).toBe(b.traceHash());
    expect(a.traceHash()).toMatch(/^[0-9a-f]{14}$/);
  });

  it("reports overcurrent when the resistor is shorted out", () => {
    const sim = make();
    sim.setProp("r1", "resistance", 0.001);
    sim.runFor(600);
    const codes = sim.diagnostics().map((d) => d.code);
    expect(codes).toContain("led-overcurrent");
    expect(codes).toContain("gpio-overcurrent");
  });

  it("stops, resets and emits events", () => {
    const sim = make();
    const events: string[] = [];
    const off = sim.subscribe((e) => events.push(e.type));
    sim.runFor(600);
    sim.stop();
    sim.runFor(1000);
    expect(sim.timeMs).toBe(600);
    sim.reset();
    expect(sim.timeMs).toBe(0);
    expect(sim.trace).toHaveLength(0);
    expect(sim.partState("led1")!.brightness).toBe(0);
    off();
    expect(events).toContain("pin");
    expect(events).toContain("solved");
    expect(events).toContain("stopped");
    expect(events).toContain("reset");
  });

  it("runs clock events and works without an MCU", () => {
    const p = parseProject({ ...input, firmware: undefined });
    const sim = new Simulation({ project: p, registry });
    expect(sim.mcu).toBeUndefined();
    const at: number[] = [];
    sim.clock.schedule(sim.clock.fromMs(5), (c) => at.push(c));
    sim.runFor(10);
    expect(at).toEqual([5000]);
    expect(sim.timeMs).toBe(10);
  });

  it("flags unknown part types instead of crashing", () => {
    const p = parseProject({ format: "jumper/1", name: "x", parts: [{ id: "q", type: "nope", x: 0, y: 0 }] });
    const sim = new Simulation({ project: p, registry });
    expect(sim.diagnostics()[0]).toMatchObject({ partId: "q", code: "unknown-part-type", severity: "error" });
  });
});
