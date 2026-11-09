import { describe, expect, it } from "vitest";
import { GROUND, type CircuitBuilder } from "@jumper/sim-core";
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
