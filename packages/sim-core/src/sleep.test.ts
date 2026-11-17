import { describe, expect, it } from "vitest";
import { parseProject } from "@faber/project-format";
import { createMcuBoardModel, createRegistry, parseSleepMarker, Simulation, sleepText, type Fidelity, type McuBackend, type PartDefinition, type PinState, type WakeInfo } from "./index.ts";

/**
 * A fake firmware that counts boots: on every boot it sets D2 INPUT_PULLUP, prints "boot <n>",
 * waits 100 ms and prints the sleep shim's line (a 1 h timer and D2 low as wake pins).
 */
class SleepyMcu implements McuBackend {
  readonly cyclesPerSecond = 1_000_000;
  readonly vcc = 3.3;
  readonly pinIds = ["D2"] as const;
  cycles = 0;
  boots = 0;
  wakes: WakeInfo[] = [];
  private said = false;
  private pins = new Map<string, PinState>([["D2", { mode: "input", value: 0 }]]);
  private pinCbs = new Set<(p: string, s: PinState, c: number) => void>();
  private serialCbs = new Set<(b: number, c: number) => void>();
  constructor(private readonly line = '[faber:sleep] {"mode":"deep","us":3600000000,"pins":[{"gpio":2,"level":0}],"any":true,"src":"ext0"}') {}
  load() {
    this.reset();
  }
  reset() {
    this.cycles = 0;
    this.said = false;
    this.pins.set("D2", { mode: "input", value: 0 });
  }
  reboot() {
    this.reset();
  }
  setWakeInfo(i: WakeInfo) {
    this.wakes.push(i);
  }
  readPin(id: string) {
    return { ...this.pins.get(id)! };
  }
  setPinInput(id: string, v: number) {
    const p = this.pins.get(id)!;
    p.value = v > this.vcc / 2 ? 1 : 0;
  }
  private print(s: string) {
    for (const ch of s) for (const cb of this.serialCbs) cb(ch.charCodeAt(0), this.cycles);
  }
  step(n: number) {
    const end = this.cycles + n;
    if (this.cycles === 0 && n > 0) {
      this.boots++;
      this.pins.set("D2", { mode: "input_pullup", value: 1 });
      for (const cb of this.pinCbs) cb("D2", { mode: "input_pullup", value: 1 }, 0);
      this.print(`boot ${this.boots}\n`);
    }
    if (!this.said && end >= 100_000) {
      this.cycles = Math.max(this.cycles, 100_000);
      this.said = true;
      this.print(`${this.line}\n`);
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
  areas: { logic: { level: "ok", note: "" }, timing: { level: "n/a", note: "" }, analog: { level: "n/a", note: "" }, power: { level: "n/a", note: "" }, radio: { level: "n/a", note: "" } },
  emulates: [],
  doesNotEmulate: [],
  testOnRealDevice: [],
};
const pin = (id: string, type: "digital" | "ground" | "power" | "passive" = "passive") => ({ id, label: id, x: 0, y: 0, type });
const board: PartDefinition = {
  spec: { id: "fake-board", name: "Fake", category: "board", description: "", size: { w: 10, h: 10 }, pins: [pin("D2", "digital"), pin("GND", "ground"), pin("3V3", "power")], mcu: { backend: "fake", chip: "fake", clockHz: 1_000_000, vcc: 3.3 } },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => createMcuBoardModel(ctx, { rails: { "3V3": 3.3 } }),
};
let ticks = 0;
// the reed switch is wired D2 → GND through its node (the fake model stamps between the D2 net and ground)
const registry = createRegistry([
  board,
  {
    spec: { id: "reed", name: "Reed", category: "input", description: "", size: { w: 10, h: 10 }, pins: [pin("1"), pin("2")] },
    fidelity: fid,
    svg: "<svg/>",
    create: (ctx) => {
      let closed = false;
      return {
        stamp: (c) => void c.switch(ctx.node("1"), ctx.node("2"), closed),
        visualState: () => ({ closed }),
        setProp: () => {},
        tick: () => void ticks++,
        interact: (e) => {
          closed = e.kind === "press";
        },
      };
    },
  },
]);
const project = parseProject({
  format: "faber/1",
  name: "sleepy",
  parts: [
    { id: "b", type: "fake-board", x: 0, y: 0 },
    { id: "lid", type: "reed", x: 0, y: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "b", pin: "D2" }, to: { part: "lid", pin: "1" } },
    { id: "w2", from: { part: "lid", pin: "2" }, to: { part: "b", pin: "GND" } },
  ],
  firmware: { board: "b", artifact: "firmware/x.bin" },
});

const make = (mcu = new SleepyMcu()) => ({ mcu, sim: new Simulation({ project, registry, backendFactory: () => mcu, firmware: "x" }) });

describe("deep sleep (round 15)", () => {
  it("parses the shim's line and says what is wrong with a bad one", () => {
    const r = parseSleepMarker('boot\r[faber:sleep] {"us":60000000,"pins":[{"gpio":4,"level":1}],"any":false,"src":"ext1"}');
    expect(r).toEqual({ mode: "deep", wakeAfterMs: 60000, wakePins: [{ pin: "GPIO4", level: 1 }], any: false, pinSource: "ext1" });
    expect(sleepText(r as never)).toBe("deep sleep, wakes after 1 min or when GPIO4 goes high");
    expect(parseSleepMarker("hello")).toBeUndefined();
    expect((parseSleepMarker("[faber:sleep] {oops") as { error: string }).error).toMatch(/not JSON.*Fix: rebuild/);
    expect((parseSleepMarker('[faber:sleep] {"pins":[{"gpio":"x"}]}') as { error: string }).error).toMatch(/gpio/);
  });

  it("sleeps on the marker, jumps an hour of virtual time fast, and wakes on the timer with a reboot", () => {
    const { mcu, sim } = make();
    sim.runFor(200);
    expect(sim.asleep).toBe(true);
    expect(sim.sleepRequest?.wakeAfterMs).toBe(3_600_000);
    const t0 = Date.now();
    sim.runFor(3_600_000 - 200); // just before the timer (it slept at 100 ms)
    expect(sim.asleep).toBe(true);
    sim.runFor(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(sim.asleep).toBe(true); // it rebooted, ran 100 ms and slept again
    expect(mcu.boots).toBe(2);
    expect(mcu.wakes[0]).toMatchObject({ cause: "timer" });
    expect(mcu.wakes[0]!.slept_ms).toBeCloseTo(3_600_000, 0);
    const log = sim.sleepLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.woke).toMatchObject({ cause: "timer" });
    expect(sim.serialText()).toContain("boot 2");
  });

  it("wakes when a wake pin reaches its level (a reed switch closing), keeping the pull-up while asleep", () => {
    const { mcu, sim } = make(new SleepyMcu());
    sim.runFor(200);
    // the shim names GPIO2; the fake board calls it D2: re-enter with the board's own id
    sim.enterSleep({ mode: "deep", wakePins: [{ pin: "D2", level: 0 }], any: true, pinSource: "ext0" });
    sim.runFor(10 * 60_000);
    expect(sim.asleep).toBe(true);
    expect(mcu.boots).toBe(1);
    sim.interact("lid", { kind: "press" }); // D2 to ground
    sim.runFor(1);
    expect(mcu.boots).toBe(2);
    expect(mcu.wakes.at(-1)).toMatchObject({ cause: "ext0", pin: "D2" });
    expect(sim.sleepLog().at(-1)!.woke!.slept_ms).toBeGreaterThan(599_000);
  });

  it("ticks parts once a second while asleep (a day costs ~86 400 ticks, not 86 million)", () => {
    const { sim } = make();
    sim.runFor(200);
    ticks = 0;
    sim.enterSleep({ mode: "deep", wakePins: [], any: true });
    sim.runFor(86_400_000);
    expect(sim.asleep).toBe(true);
    expect(ticks).toBeLessThan(100_000);
  });

  it("reset_board wakes it (a reset button) and reset() forgets the log", () => {
    const { mcu, sim } = make();
    sim.runFor(200);
    expect(sim.resetBoard()).toBe(true);
    expect(sim.asleep).toBe(false);
    sim.runFor(50);
    expect(mcu.boots).toBe(2);
    sim.reset();
    expect(sim.sleepLog()).toHaveLength(0);
  });
});
