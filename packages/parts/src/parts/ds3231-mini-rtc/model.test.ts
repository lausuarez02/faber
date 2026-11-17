import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { i2cWires, serialLines, unoBench } from "../../lib/firmwareBench.ts";

const def = need(registry.get("ds3231-mini-rtc"), "ds3231-mini-rtc");

describe("ds3231-mini-rtc", () => {
  it("draws only the chip's 0.11 mA (no LED, no charger)", () => {
    const b = mount(def, { id: "rtc", wiring: { VCC: "v", GND: GROUND } });
    const r = b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01, { id: "src" }));
    expect(r.current("src") * 1000).toBeCloseTo(0.11, 2);
    expect(b.model.visualState()).toMatchObject({ time: "2026-01-01 12:00:00", running: true });
    expect(b.model.visualState()).not.toHaveProperty("powerLed");
    expect(b.model.diagnostics!().some((d) => d.code === "rtc-charges-coin-cell")).toBe(false);
  });

  it("is small and thin next to the ZS-042, and documents where its size comes from", () => {
    const zs = need(registry.get("ds3231-rtc"), "ds3231-rtc").spec;
    expect(def.spec.dimensions_mm!.w * def.spec.dimensions_mm!.h).toBeLessThan((zs.dimensions_mm!.w * zs.dimensions_mm!.h) / 4);
    expect(def.spec.current_ma!.typ).toBeLessThan(zs.current_ma!.typ / 10);
    expect(def.spec.mechanical!.source).toMatch(/seller listings/);
  });
});

describe("ds3231-mini-rtc: the same chip runs RTClib's RTC_DS3231 sketch", { timeout: 120_000 }, () => {
  it("prints the start time and counts seconds", () => {
    const sim = unoBench({ parts: [{ id: "rtc", type: "ds3231-mini-rtc", x: 0, y: 0, props: { temperature: 21.5 } }], wires: i2cWires("rtc"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(2100);
    expect(serialLines(sim)).toEqual(["2026-01-01 12:00:00 21.50C", "2026-01-01 12:00:01 21.50C", "2026-01-01 12:00:02 21.50C"]);
  });

  it("a set time (set_clock / interaction) carries over midnight", () => {
    const sim = unoBench({ parts: [{ id: "rtc", type: "ds3231-mini-rtc", x: 0, y: 0 }], wires: i2cWires("rtc"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(100);
    sim.interact("rtc", { kind: "set", key: "time", value: "2026-11-13T23:59:59" });
    sim.runFor(2100);
    expect(serialLines(sim).join("\n")).toMatch(/2026-11-14 00:00:0\d/);
  });
});
