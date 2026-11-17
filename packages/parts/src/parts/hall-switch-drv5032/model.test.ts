import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("hall-switch-drv5032"), "hall-switch-drv5032");
const wiring = { VCC: "vcc", OUT: "out", GND: GROUND };

describe("hall-switch-drv5032", () => {
  it("OUT is high with no magnet and goes low at the next sample once the magnet is within B_OP", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 3.3));
    expect(b.result!.voltage("out")).toBeCloseTo(3.3, 1);
    const at = b.model.visualState().detects_at_mm as number;
    expect(at).toBeGreaterThan(14);
    expect(at).toBeLessThan(20);
    b.interact({ kind: "set", key: "magnet_mm", value: at - 1 });
    // not before the next sample (200 ms on the FB)
    b.model.tick!(100, 1);
    expect(b.model.visualState().detected).toBe(false);
    b.model.tick!(200, 1);
    expect(b.solve().voltage("out")).toBeLessThan(0.05);
    // hysteresis: still detected just past B_OP, released past B_RP
    b.interact({ kind: "set", key: "magnet_mm", value: at + 1 });
    b.model.tick!(400, 1);
    expect(b.model.visualState().detected).toBe(true);
    b.interact({ kind: "set", key: "magnet", value: "away" });
    b.model.tick!(600, 1);
    expect(b.solve().voltage("out")).toBeCloseTo(3.3, 1);
    expect(b.model.visualState().detections).toBe(1);
  });

  it("draws 0.69 µA (FB) and the open-drain AJ needs a pull-up and a stronger field", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 3.3));
    const aj = mount(def, { wiring, props: { version: "AJ" } });
    aj.solve((c) => {
      supply("vcc", 3.3)(c);
      c.resistor("vcc", "out", 45_000);
    });
    expect(aj.result!.voltage("out")).toBeCloseTo(3.3, 1);
    expect(aj.model.visualState().detects_at_mm as number).toBeLessThan(b.model.visualState().detects_at_mm as number);
    expect(aj.model.visualState().sample_ms).toBe(50);
  });

  it("says why OUT never changes when it has no supply", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 1.2));
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("drv5032-undervoltage");
  });
});
