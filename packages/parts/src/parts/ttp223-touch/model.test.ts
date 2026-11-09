import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("ttp223-touch"), "ttp223-touch");
const wiring = { VCC: "vcc", IO: "io", GND: GROUND };

describe("ttp223-touch", () => {
  it("drives I/O to VCC while touched and to 0 V when not (no pull-up needed)", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 5));
    expect(b.result!.voltage("io")).toBeLessThan(0.01);
    expect(b.interact({ kind: "press" }).voltage("io")).toBeCloseTo(5, 1);
    expect(b.model.visualState()).toMatchObject({ touched: true, out: true });
    expect(b.interact({ kind: "release" }).voltage("io")).toBeLessThan(0.01);
  });

  it("runs at 3.3 V with a 3.3 V output level", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 3.3));
    expect(b.interact({ kind: "press" }).voltage("io")).toBeCloseTo(3.3, 1);
  });

  it("is HIGH when idle and LOW when touched with jumper A bridged", () => {
    const b = mount(def, { wiring, props: { output: "active-low" } });
    b.solve(supply("vcc", 5));
    expect(b.result!.voltage("io")).toBeCloseTo(5, 1);
    expect(b.interact({ kind: "press" }).voltage("io")).toBeLessThan(0.01);
  });

  it("toggles on each touch with jumper B bridged", () => {
    const b = mount(def, { wiring, props: { mode: "toggle" } });
    b.solve(supply("vcc", 5));
    b.interact({ kind: "press" });
    expect(b.interact({ kind: "release" }).voltage("io")).toBeCloseTo(5, 1);
    b.interact({ kind: "press" });
    expect(b.interact({ kind: "release" }).voltage("io")).toBeLessThan(0.01);
  });

  it("says why I/O never changes when unpowered, and warns above 5.5 V", () => {
    const b = mount(def, { wiring });
    b.solve();
    b.interact({ kind: "press" });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("ttp223-unpowered");
    b.solve(supply("vcc", 9));
    expect(b.model.diagnostics!()[0]!.code).toBe("ttp223-overvoltage");
  });
});
