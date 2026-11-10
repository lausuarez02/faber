import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("boost-converter"), "boost-converter");

describe("boost-converter", () => {
  it("makes 5 V from a 3.7 V cell and draws vout × Iout / (0.88 × VIN) + 1 mA", () => {
    const b = mount(def, { id: "boost", wiring: { "VIN+": "bat", "VOUT+": "5v" } });
    const r = b.solve((c) => {
      c.voltageSource("bat", GROUND, 3.7, 0.1, { id: "cell" });
      c.resistor("5v", GROUND, 25); // 200 mA at 5 V = 1 W
    });
    const s = b.model.visualState();
    expect(s.state).toBe("boosting");
    expect(Number(s.vout)).toBeCloseTo(5, 1);
    const vin = r.voltage("bat");
    expect(r.current("cell")).toBeCloseTo((5 * 0.2) / (0.88 * vin) + 0.001, 2);
    expect(Number(s.inmA)).toBeGreaterThan(300);
  });

  it("is off below 2 V in and passes the input through above vout", () => {
    const b = mount(def, { id: "boost", wiring: { "VIN+": "bat", "VOUT+": "out" } });
    b.solve((c) => {
      supply("bat", 1.5)(c);
      c.resistor("out", GROUND, 100);
    });
    expect(b.model.visualState().state).toBe("off");
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("boost-undervoltage");
    b.solve((c) => {
      supply("bat", 7.4)(c);
      c.resistor("out", GROUND, 100);
    });
    expect(b.model.visualState().state).toBe("pass-through");
    expect(Number(b.model.visualState().vout)).toBeCloseTo(7.0, 1);
  });

  it("follows the trimmer (vout prop)", () => {
    const b = mount(def, { id: "boost", props: { vout: 9 }, wiring: { "VIN+": "bat", "VOUT+": "out" } });
    b.solve((c) => {
      supply("bat", 3.7)(c);
      c.resistor("out", GROUND, 1000);
    });
    expect(Number(b.model.visualState().vout)).toBeCloseTo(9, 1);
  });
});
