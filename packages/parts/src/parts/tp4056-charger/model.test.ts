import { describe, expect, it } from "vitest";
import { parseProject } from "@jumper/project-format";
import { GROUND, Simulation, type CircuitBuilder } from "@jumper/sim-core";
import { backendFactory } from "@jumper/sim-backends";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("tp4056-charger"), "tp4056-charger");
const wiring = { VIN: "vin", BAT: "bat", OUT: "out" };

/** A cell: open-circuit `v` behind 0.15 Ω. */
const cell = (v: number) => (c: CircuitBuilder) => {
  c.voltageSource("bat", GROUND, v, 0.15, { id: "cell" });
};

describe("tp4056-charger", () => {
  it("charges a half-full cell at the set current when USB is plugged in", () => {
    const b = mount(def, { wiring });
    b.solve(cell(3.8));
    expect(b.model.visualState()).toMatchObject({ mode: "off", charging: false, label: "no input" });
    b.interact({ kind: "press" });
    const s = b.model.visualState();
    expect(s).toMatchObject({ usb: true, mode: "CC", charging: true, full: false });
    expect(Number(s.chargemA)).toBeCloseTo(1000, 0);
    expect(b.result!.current("cell")).toBeCloseTo(-1, 2);
  });

  it("uses the R_PROG current and trickles a deeply discharged cell", () => {
    const b = mount(def, { wiring, props: { usb: true, chargeCurrentmA: 400 } });
    b.solve(cell(2.7));
    expect(b.model.visualState().mode).toBe("trickle");
    expect(Number(b.model.visualState().chargemA)).toBeCloseTo(40, 0);
    b.solve(cell(3.6));
    expect(b.model.visualState().mode).toBe("CC");
    expect(Number(b.model.visualState().chargemA)).toBeCloseTo(400, 0);
  });

  it("holds 4.2 V with a tapering current (CV) and stops when the current is under 10 %", () => {
    const b = mount(def, { wiring, props: { usb: true } });
    b.solve(cell(4.1));
    const s = b.model.visualState();
    expect(s.mode).toBe("CV");
    expect(b.result!.voltage("bat")).toBeCloseTo(4.2, 1);
    expect(Number(s.chargemA)).toBeGreaterThan(100);
    expect(Number(s.chargemA)).toBeLessThan(1000);
    b.solve(cell(4.19));
    expect(b.model.visualState()).toMatchObject({ mode: "full", full: true, charging: false });
  });

  it("passes the battery to OUT and cuts it off below 2.4 V", () => {
    const b = mount(def, { wiring });
    b.solve((c) => {
      cell(3.7)(c);
      c.resistor("out", GROUND, 37);
    });
    expect(b.result!.voltage("out")).toBeGreaterThan(3.6);
    b.solve((c) => {
      cell(2.2)(c);
      c.resistor("out", GROUND, 37);
    });
    expect(b.model.visualState().protected).toBe(true);
    expect(b.result!.voltage("out")).toBeLessThan(0.01);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("tp4056-protected");
  });

  it("charges from 5 V on IN+ and refuses an 9 V input", () => {
    const b = mount(def, { wiring });
    b.solve((c) => {
      cell(3.8)(c);
      c.voltageSource("vin", GROUND, 5, 0.01);
    });
    expect(b.model.visualState().mode).toBe("CC");
    b.solve((c) => {
      cell(3.8)(c);
      c.voltageSource("vin", GROUND, 9, 0.01);
    });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("tp4056-overvoltage");
  });
});

describe("tp4056-charger + lipo-battery in a simulation (×3600 time, so 1 s = 1 h)", () => {
  it("charges a half-full 500 mAh cell through CC, then CV, to full, and the LEDs follow", () => {
    const project = parseProject({
      format: "jumper/1",
      name: "charge",
      parts: [
        { id: "cell", type: "lipo-battery", x: 0, y: 0, props: { capacity: 500, soc: 50, speedup: 3600 } },
        { id: "chg", type: "tp4056-charger", x: 0, y: 0, props: { usb: true, chargeCurrentmA: 500 } },
      ],
      wires: [
        { id: "w1", from: { part: "cell", pin: "POS" }, to: { part: "chg", pin: "BAT" } },
        { id: "w2", from: { part: "cell", pin: "NEG" }, to: { part: "chg", pin: "GND.2" } },
      ],
    });
    const sim = new Simulation({ project, registry, backendFactory });
    sim.runFor(100);
    expect(sim.partState("chg")).toMatchObject({ mode: "CC", charging: true });
    expect(Number(sim.partState("cell")!.currentmA)).toBeCloseTo(-500, 0);
    const modes = new Set<string>();
    for (let i = 0; i < 40 && sim.partState("chg")!.mode !== "full"; i++) {
      sim.runFor(100);
      modes.add(String(sim.partState("chg")!.mode));
    }
    expect([...modes]).toEqual(expect.arrayContaining(["CC", "CV", "full"]));
    const cell = sim.partState("cell")!;
    expect(Number(cell.soc)).toBeGreaterThan(95);
    expect(Number(cell.volts)).toBeGreaterThan(4.15);
    expect(Number(cell.volts)).toBeLessThanOrEqual(4.21);
    expect(sim.partState("chg")).toMatchObject({ full: true, charging: false });
    // No over-charge or fast-charge warning at 1C.
    expect(sim.diagnostics().map((d) => d.code)).not.toContain("lipo-fast-charge");
    expect(sim.diagnostics().map((d) => d.code)).not.toContain("lipo-overcharge");
  }, 60_000);

  it("warns when the 1 A it is sold with charges a 500 mAh cell", () => {
    const project = parseProject({
      format: "jumper/1",
      name: "charge",
      parts: [
        { id: "cell", type: "lipo-battery", x: 0, y: 0, props: { capacity: 500, soc: 50 } },
        { id: "chg", type: "tp4056-charger", x: 0, y: 0, props: { usb: true } },
      ],
      wires: [{ id: "w1", from: { part: "cell", pin: "POS" }, to: { part: "chg", pin: "BAT" } }],
    });
    const sim = new Simulation({ project, registry, backendFactory });
    sim.runFor(10);
    expect(sim.diagnostics().find((d) => d.code === "lipo-fast-charge")?.message).toMatch(/chargeCurrentmA to 500 or less/);
  });
});
