// Round 6 (power): the firmware board only runs while its supply is up (USB or a battery path).
import { describe, expect, it } from "vitest";
import { parseProject, type ProjectInput } from "@fabwright/project-format";
import { createMcuBoardModel, createRegistry, GROUND, Simulation, type Fidelity, type McuBackend, type PartDefinition, type PartSpec, type PinState } from "./index.ts";

/** "Firmware" that prints one byte every 100 ms of its own time since reset. */
class TickMcu implements McuBackend {
  readonly cyclesPerSecond = 1_000_000;
  readonly vcc = 5;
  readonly pinIds = ["D2"] as const;
  cycles = 0;
  resets = 0;
  private cbs = new Set<(b: number, c: number) => void>();
  load() {
    this.reset();
  }
  reset() {
    this.cycles = 0;
    this.resets++;
  }
  readPin(): PinState {
    return { mode: "input", value: 0 };
  }
  setPinInput() {}
  step(n: number) {
    const end = this.cycles + n;
    for (;;) {
      const next = (Math.floor(this.cycles / 100_000) + 1) * 100_000;
      if (next > end) break;
      this.cycles = next;
      for (const cb of this.cbs) cb(0x2e, this.cycles);
    }
    this.cycles = end;
  }
  onPinChange() {
    return () => {};
  }
  onSerial(cb: (b: number, c: number) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
}

const fid: Fidelity = {
  level: "behavioral",
  areas: { logic: { level: "ok", note: "" }, timing: { level: "n/a", note: "" }, analog: { level: "n/a", note: "" }, power: { level: "n/a", note: "" }, radio: { level: "n/a", note: "" } },
  emulates: [],
  doesNotEmulate: [],
  testOnRealDevice: [],
};
const pin = (id: string, type: PartSpec["pins"][number]["type"]) => ({ id, label: id, x: 0, y: 0, type });

const board: PartDefinition = {
  spec: { id: "fake-board", name: "Fake", category: "board", description: "", size: { w: 1, h: 1 }, pins: [pin("D2", "digital"), pin("GND", "ground"), pin("5V", "power")], mcu: { backend: "fake", chip: "fake", clockHz: 1e6, vcc: 5 }, current_ma: { typ: 20, max: 20 } },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => createMcuBoardModel(ctx, { rails: { "5V": 5 } }),
};
const cell: PartDefinition = {
  spec: { id: "cell", name: "Cell", category: "power", description: "", size: { w: 1, h: 1 }, pins: [pin("POS", "power"), pin("NEG", "ground")] },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => ({ stamp: (c) => void c.voltageSource(ctx.node("POS"), GROUND, 5, 0.1, { id: "cell" }), visualState: () => ({}), setProp() {} }),
};
const registry = createRegistry([board, cell]);

function sim(extra: Partial<ProjectInput> = {}, withCell = false) {
  const project = parseProject({
    format: "fabwright/1",
    name: "p",
    parts: [{ id: "b", type: "fake-board", x: 0, y: 0 }, ...(withCell ? [{ id: "c", type: "cell", x: 0, y: 0 }] : [])],
    wires: withCell ? [{ id: "w1", from: { part: "c", pin: "POS" }, to: { part: "b", pin: "5V" } }] : [],
    firmware: { board: "b", dir: "firmware", artifact: "firmware/main.hex" },
    ...extra,
  });
  const mcu = new TickMcu();
  const s = new Simulation({ project, registry, backendFactory: () => mcu, firmware: "x" });
  return { s, mcu };
}

const serial = (s: Simulation) => s.trace.filter((t) => t.kind === "serial");

describe("board power (round 6)", () => {
  it("USB plugged (default): the firmware runs as before", () => {
    const { s } = sim();
    s.runFor(1000);
    expect(s.boardPowered).toBe(true);
    expect(serial(s)).toHaveLength(10);
  });

  it("USB unplugged and nothing on the supply pins: the MCU is held in reset", () => {
    const { s } = sim({ power: { usb: false } });
    s.runFor(1000);
    expect(s.boardPowered).toBe(false);
    expect(serial(s)).toHaveLength(0);
    expect(s.timeMs).toBeCloseTo(1000, 6);
    expect(s.diagnostics().map((d) => d.code)).toContain("board-unpowered");
  });

  it("plugging USB in later boots the firmware from reset at that moment", () => {
    const { s, mcu } = sim({ power: { usb: false } });
    s.runFor(1000);
    const resets = mcu.resets;
    expect(s.setPower({ usb: true })).toBe(true);
    expect(mcu.resets).toBe(resets + 1);
    s.runFor(500);
    const lines = serial(s);
    expect(lines).toHaveLength(5);
    // Trace cycles are global: the first byte comes 100 ms after power-on at 1000 ms.
    expect(lines[0]!.cycle).toBe(1_100_000);
    expect(s.timeMs).toBeCloseTo(1500, 6);
  });

  it("unplugging USB stops it; a battery on the supply pin keeps it running", () => {
    const { s } = sim();
    s.runFor(300);
    s.setPower({ usb: false });
    s.runFor(300);
    expect(serial(s)).toHaveLength(3);
    const b = sim({ power: { usb: false } }, true).s;
    b.runFor(1000);
    expect(b.boardPowered).toBe(true);
    expect(serial(b)).toHaveLength(10);
    // The board's own 20 mA comes out of the cell.
    expect(b.lastSolve!.current("c/cell") * 1000).toBeCloseTo(20, 0);
  });

  it("adoptProps applies a power.usb change live", () => {
    const { s } = sim();
    s.runFor(200);
    const changed = s.adoptProps({ ...s.project, power: { usb: false } });
    expect(changed).toContain("power.usb");
    expect(s.boardPowered).toBe(false);
  });
});
