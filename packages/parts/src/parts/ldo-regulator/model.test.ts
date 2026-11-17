import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("ldo-regulator"), "ldo-regulator");

describe("ldo-regulator", () => {
  it("makes 3.3 V from a full LiPo and takes the load current + 1.6 µA from it", () => {
    const b = mount(def, { id: "ldo", wiring: { VIN: "bat", VOUT: "3v3" } });
    const r = b.solve((c) => {
      c.voltageSource("bat", GROUND, 4.2, 0.15, { id: "cell" });
      c.resistor("3v3", GROUND, 33);
    });
    const s = b.model.visualState();
    expect(s.state).toBe("regulating");
    expect(Number(s.vout)).toBeCloseTo(3.3, 1);
    expect(r.current("cell") * 1000).toBeCloseTo(Number(s.outmA) + 0.0016, 1);
  });

  it("drops out below 3.3 V + 0.18 V: VOUT follows the cell", () => {
    const b = mount(def, { id: "ldo", wiring: { VIN: "bat", VOUT: "3v3" } });
    b.solve((c) => {
      supply("bat", 3.4)(c);
      c.resistor("3v3", GROUND, 100);
    });
    const s = b.model.visualState();
    expect(s.state).toBe("dropout");
    expect(Number(s.vout)).toBeLessThan(3.25);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("ldo-dropout");
  });

  it("AP2112K: EN LOW switches it off; MCP1700 ignores EN; over 6 V in is an error", () => {
    const b = mount(def, { id: "ldo", props: { variant: "AP2112K-3.3" }, wiring: { VIN: "vin", VOUT: "3v3", EN: "en" } });
    b.solve((c) => {
      supply("vin", 5)(c);
      supply("en", 0)(c);
      c.resistor("3v3", GROUND, 100);
    });
    expect(b.model.visualState().state).toBe("off");
    b.setProp("variant", "MCP1700-3.3");
    expect(b.model.visualState().state).toBe("regulating");
    b.solve((c) => {
      supply("vin", 7)(c);
      c.resistor("3v3", GROUND, 100);
    });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("ldo-overvoltage");
  });
});
