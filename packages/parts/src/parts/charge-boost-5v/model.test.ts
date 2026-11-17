import { describe, expect, it } from "vitest";
import { GROUND, type CircuitBuilder } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("charge-boost-5v"), "charge-boost-5v");
const wiring = { VIN: "vin", BAT: "bat", OUT: "out" };

/** A cell (open-circuit `v` behind 0.15 Ω) and a load on OUT. */
const rig = (v: number, loadOhms?: number) => (c: CircuitBuilder) => {
  c.voltageSource("bat", GROUND, v, 0.15, { id: "cell" });
  if (loadOhms) c.resistor("out", GROUND, loadOhms, { id: "load" });
};

describe("charge-boost-5v (IP5306 class)", () => {
  it("is one part smaller than a TP4056 plus an MT3608 together", () => {
    const area = (id: string) => {
      const d = need(registry.get(id), id).spec.dimensions_mm!;
      return d.w * d.h;
    };
    expect(area("charge-boost-5v")).toBeLessThan(area("tp4056-charger") + area("boost-converter"));
    expect(def.spec.dimensions_mm!.d).toBeLessThan(need(registry.get("boost-converter"), "boost").spec.dimensions_mm!.d);
  });

  it("gives 5 V from a 3.7 V cell and draws 5 × I / (0.9 × Vcell) from it", () => {
    const b = mount(def, { wiring });
    b.solve(rig(3.7, 50)); // 100 mA at 5 V
    expect(b.result!.voltage("out")).toBeCloseTo(5, 1);
    const s = b.model.visualState();
    expect(s.outOn).toBe(true);
    expect(Number(s.outmA)).toBeCloseTo(100, -1);
    const cellA = b.result!.current("cell");
    expect(cellA).toBeGreaterThan(0.14);
    expect(cellA).toBeLessThan(0.17);
  });

  it("charges the cell from USB (CC at the chip's 2 A, then CV at 4.2 V)", () => {
    const b = mount(def, { wiring, props: { usb: true } });
    b.solve(rig(3.8));
    expect(b.model.visualState()).toMatchObject({ mode: "CC", charging: true });
    expect(Number(b.model.visualState().chargemA)).toBeCloseTo(2000, -1);
    b.solve(rig(4.15));
    expect(b.model.visualState().mode).toBe("CV");
    expect(b.result!.voltage("bat")).toBeCloseTo(4.2, 1);
  });

  it("cuts the output at a 3.0 V cell and comes back when USB is plugged", () => {
    const b = mount(def, { wiring });
    b.solve(rig(2.9, 50));
    expect(b.model.visualState()).toMatchObject({ outOn: false, off: "low battery" });
    expect(b.result!.voltage("out")).toBeLessThan(0.1);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("charge-boost-low-battery");
    b.setProp("usb", true);
    expect(b.model.visualState().outOn).toBe(true);
  });

  it("light-load auto-off: under 45 mA for 32 s turns OUT off; KEY wakes it", () => {
    const b = mount(def, { wiring });
    b.solve(rig(3.9, 250)); // 20 mA at 5 V
    expect(b.model.visualState().outOn).toBe(true);
    b.model.onSolved!(b.result!, 31_000);
    expect(b.model.visualState().outOn).toBe(true);
    b.model.onSolved!(b.result!, 32_500);
    b.solve();
    expect(b.model.visualState()).toMatchObject({ outOn: false, off: "auto-off" });
    const d = b.model.diagnostics!().find((x) => x.code === "charge-boost-auto-off")!;
    expect(d.message).toMatch(/Why:.*Fix:/);
    b.interact({ kind: "press" });
    expect(b.model.visualState().outOn).toBe(true);
  });

  it("a heavy enough load (or auto_off false) stays on", () => {
    const heavy = mount(def, { wiring });
    heavy.solve(rig(3.9, 50)); // 100 mA
    heavy.model.onSolved!(heavy.result!, 60_000);
    expect(heavy.model.visualState().outOn).toBe(true);
    const i2c = mount(def, { wiring, props: { auto_off: false } });
    i2c.solve(rig(3.9, 250));
    i2c.model.onSolved!(i2c.result!, 60_000);
    i2c.solve();
    expect(i2c.model.visualState().outOn).toBe(true);
  });
});
