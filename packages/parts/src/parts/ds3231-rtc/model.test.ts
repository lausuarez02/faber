import { describe, expect, it } from "vitest";
import { GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { i2cWires, serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { Ds3231, civilFromDays, daysFromCivil, formatTime, fromEpoch, parseTime } from "./model.ts";

const def = need(registry.get("ds3231-rtc"), "ds3231-rtc");

function readAll(chip: Ds3231): number[] {
  chip.connect(false);
  chip.write(0);
  chip.stop();
  chip.connect(true);
  const out = Array.from({ length: 19 }, () => chip.read());
  chip.stop();
  return out;
}

describe("ds3231-rtc: calendar", () => {
  it("converts dates both ways without Date", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(2000, 3, 1)).toBe(11017);
    for (const d of [-1000, 0, 11016, 11017, 20000, 47482]) {
      const c = civilFromDays(d);
      expect(daysFromCivil(c.y, c.m, c.d)).toBe(d);
    }
    expect(formatTime(parseTime("2024-02-29T23:59:59")! + 1)).toBe("2024-03-01 00:00:00");
    expect(fromEpoch(parseTime("2026-01-01T00:00:00")!).weekday).toBe(4); // a Thursday
    expect(parseTime("2026-13-01T00:00:00")).toBeUndefined();
  });
});

describe("ds3231-rtc: registers", () => {
  it("counts from the start time with simulation time, in BCD", () => {
    let t = 0;
    const chip = new Ds3231(parseTime("2026-12-31T23:59:58")!, false, () => t);
    let r = readAll(chip);
    expect(r.slice(0, 7)).toEqual([0x58, 0x59, 0x23, 5, 0x31, 0x12, 0x26]);
    t = 2500;
    r = readAll(chip);
    expect(r.slice(0, 7)).toEqual([0x00, 0x00, 0x00, 6, 0x01, 0x01, 0x27]);
    expect(r[0x0e]).toBe(0x1c);
    expect(r[0x0f]! & 0x80).toBe(0);
  });

  it("sets the time from a register write and restarts the second", () => {
    let t = 1700;
    const chip = new Ds3231(parseTime("2026-01-01T00:00:00")!, true, () => t);
    expect(readAll(chip)[0x0f]! & 0x80).toBe(0x80);
    chip.connect(false);
    for (const b of [0x00, 0x01, 0x02, 0x03, 0x06, 0x04, 0x05, 0x30]) chip.write(b);
    chip.stop();
    expect(formatTime(chip.epoch())).toBe("2030-05-04 03:02:01");
    t = 2600;
    expect(formatTime(chip.epoch())).toBe("2030-05-04 03:02:01");
    t = 2700;
    expect(formatTime(chip.epoch())).toBe("2030-05-04 03:02:02");
    chip.connect(false);
    chip.write(0x0f);
    chip.write(0x08);
    chip.stop();
    expect(readAll(chip)[0x0f]! & 0x80).toBe(0);
  });

  it("supports 12-hour mode and quarter-degree temperature", () => {
    const chip = new Ds3231(parseTime("2026-01-01T15:04:05")!, false, () => 0);
    chip.temperature = -2.25;
    chip.connect(false);
    chip.write(0x02);
    chip.write(0x40 | 0x20 | 0x03); // 3 PM, 12-hour mode
    chip.stop();
    const r = readAll(chip);
    expect(r[2]).toBe(0x63);
    expect(r[0x11]).toBe(0xfd); // -3 + 0.75
    expect(r[0x12]).toBe(0xc0);
  });

  it("does not answer without power, and explains a bad startTime", () => {
    const b = mount(def, { id: "rtc", props: { startTime: "yesterday" } });
    b.solve();
    expect(b.model.i2c!.i2cConnect(false, false)).toBe(false);
    const codes = b.model.diagnostics!().map((d) => d.code);
    expect(codes).toEqual(["i2c-module-unpowered", "rtc-bad-start-time"]);
  });

  it("visual state shows the time", () => {
    const b = mount(def, { id: "rtc", wiring: { VCC: "v", GND: GROUND } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    expect(b.model.visualState()).toMatchObject({ time: "2026-01-01 12:00:00", clock: "12:00:00", running: true, lostPower: false });
  });
});

describe("ds3231-rtc: real firmware (RTClib)", { timeout: 120_000 }, () => {
  it("prints the start time and counts seconds", () => {
    const sim = unoBench({ parts: [{ id: "rtc", type: "ds3231-rtc", x: 0, y: 0, props: { temperature: 21.5 } }], wires: i2cWires("rtc"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(2100);
    expect(serialLines(sim)).toEqual(["2026-01-01 12:00:00 21.50C", "2026-01-01 12:00:01 21.50C", "2026-01-01 12:00:02 21.50C"]);
  });

  it("sets the time after a power loss", () => {
    const sim = unoBench({ parts: [{ id: "rtc", type: "ds3231-rtc", x: 0, y: 0, props: { lostPower: true } }], wires: i2cWires("rtc"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(1100);
    const lines = serialLines(sim);
    expect(lines[0]).toBe("RTC lost power, setting the time");
    expect(lines[1]).toMatch(/^2030-05-04 03:02:01 25.00C$/);
    expect(sim.partState("rtc")!.lostPower).toBe(false);
  });
});
