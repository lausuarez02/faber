import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { timedMount } from "../../lib/timedBench.ts";
import { internalOhms, ocv } from "./model.ts";

const def = need(registry.get("lipo-battery"), "lipo-battery");

describe("lipo-battery", () => {
  it("follows the LiPo voltage curve", () => {
    expect(ocv(100)).toBe(4.2);
    expect(ocv(50)).toBeCloseTo(3.84, 2);
    expect(ocv(0)).toBeCloseTo(3.27, 2);
    expect(ocv(52.5)).toBeCloseTo(3.845, 3);
    expect(internalOhms(500, 80)).toBeCloseTo(0.15, 2);
    expect(internalOhms(500, 0)).toBeCloseTo(0.3, 2);
  });

  it("sags under load: 4.2 V full, ~4.1 V with 500 mA from a 500 mAh cell", () => {
    const b = mount(def, { wiring: { POS: "bat" } });
    b.solve((c) => void c.resistor("bat", GROUND, 8.2));
    const s = b.model.visualState();
    expect(Number(s.currentmA)).toBeGreaterThan(490);
    expect(Number(s.volts)).toBeGreaterThan(4.08);
    expect(Number(s.volts)).toBeLessThan(4.15);
  });

  it("drains with the current drawn: 100 mA for 6 s at ×600 = 100 mAh = 20 %", () => {
    const t = timedMount(def, { wiring: { POS: "bat" }, props: { speedup: 600 } });
    t.extra((c) => void c.currentSource("bat", GROUND, 0.1));
    t.solve();
    t.advance(6000);
    const s = t.model.visualState();
    expect(Number(s.usedmAh)).toBeCloseTo(100, 0);
    expect(Number(s.soc)).toBeCloseTo(80, 0);
    expect(Number(s.volts)).toBeCloseTo(ocv(80) - 0.1 * internalOhms(500, 80), 2);
    expect(String(s.label)).toMatch(/×600$/);
  });

  it("drains in real time by default", () => {
    const t = timedMount(def, { wiring: { POS: "bat" } });
    t.extra((c) => void c.currentSource("bat", GROUND, 0.1));
    t.solve();
    t.advance(3600);
    // 100 mA for 3.6 s = 0.1 mAh
    expect(Number(t.model.visualState().usedmAh)).toBeCloseTo(0.1, 3);
  });

  it("charges when a source pushes current in", () => {
    const t = timedMount(def, { wiring: { POS: "bat" }, props: { soc: 50, speedup: 3600 } });
    t.extra((c) => void c.currentSource(GROUND, "bat", 0.25));
    t.solve();
    t.advance(1000);
    const s = t.model.visualState();
    expect(s.charging).toBe(true);
    expect(Number(s.soc)).toBeCloseTo(100, 0);
  });

  it("protection disconnects an empty cell under load and warns", () => {
    const b = mount(def, { wiring: { POS: "bat" }, props: { soc: 0 } });
    b.solve((c) => void c.resistor("bat", GROUND, 0.5));
    expect(b.model.visualState().cutoff).toBe(true);
    expect(b.result!.voltage("bat")).toBeLessThan(0.01);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("lipo-cutoff");
  });

  it("warns about charging faster than 1C and drawing more than 2C", () => {
    const b = mount(def, { wiring: { POS: "bat" }, props: { soc: 50 } });
    b.solve((c) => void c.currentSource(GROUND, "bat", 1));
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("lipo-fast-charge");
    b.solve((c) => void c.resistor("bat", GROUND, 2));
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("lipo-overcurrent");
  });
});
