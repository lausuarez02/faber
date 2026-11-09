import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("battery-pack"), "battery-pack");

const loaded = (props: Record<string, string | number>, ohms: number) => {
  const b = mount(def, { props, wiring: { POS: "p" } });
  b.solve((c) => void c.resistor("p", "0", ohms, { id: "load" }));
  return b;
};

describe("battery-pack", () => {
  it("4×AA: 6.0 V open circuit, sags 0.6 V per amp", () => {
    expect(loaded({}, 1e9).result!.voltage("p")).toBeCloseTo(6, 3);
    const b = loaded({}, 5.4); // ≈ 1 A
    expect(b.result!.voltage("p")).toBeCloseTo(5.4, 2);
    expect(Number(b.model.visualState().currentmA)).toBeCloseTo(1000, -1);
  });

  it("2S LiPo is stiff; 9 V block is weak", () => {
    expect(loaded({ preset: "2S-LiPo" }, 4).result!.voltage("p")).toBeGreaterThan(8.3);
    expect(loaded({ preset: "9V" }, 9).result!.voltage("p")).toBeLessThan(8);
  });

  it("voltage and internalResistance override the preset (drained pack, custom)", () => {
    expect(loaded({ voltage: 4.8 }, 1e9).result!.voltage("p")).toBeCloseTo(4.8, 3);
    expect(loaded({ preset: "custom", voltage: 12, internalResistance: 1 }, 11).result!.voltage("p")).toBeCloseTo(11, 2);
  });

  it("warns above its practical current", () => {
    const b = loaded({ preset: "9V" }, 2);
    expect(b.model.diagnostics!().find((d) => d.code === "battery-overcurrent")?.message).toMatch(/9 V/);
  });

  it("labels itself", () => {
    expect(loaded({ preset: "2S-LiPo" }, 1e9).model.visualState()).toMatchObject({ presetLabel: "2S LiPo", label: "8.4 V · 0 mA" });
  });
});
