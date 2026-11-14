// Round 15: time for day counters. A scenario's clock and set_clock now also set real-time-clock
// parts (DS3231...), so a device that counts per day can be tested across midnight.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject, type Scenario } from "@jumper/project-format";
import { registry } from "@jumper/parts";
import { SimHost } from "../src/sim.ts";
import { runScenario } from "../src/scenario.ts";

const HEX = readFileSync(fileURLToPath(new URL("../../parts/src/parts/ds3231-rtc/example.hex", import.meta.url)), "utf8");
const project = parseProject({
  format: "jumper/1",
  name: "rtc day",
  parts: [
    { id: "uno", type: "arduino-uno", x: 0, y: 0 },
    { id: "rtc", type: "ds3231-rtc", x: 300, y: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "rtc", pin: "VCC" }, to: { part: "uno", pin: "5V" } },
    { id: "w2", from: { part: "rtc", pin: "GND" }, to: { part: "uno", pin: "GND.1" } },
    { id: "w3", from: { part: "rtc", pin: "SDA" }, to: { part: "uno", pin: "A4" } },
    { id: "w4", from: { part: "rtc", pin: "SCL" }, to: { part: "uno", pin: "A5" } },
  ],
  firmware: { board: "uno", artifact: "firmware/main.hex" },
});

describe("round 15: RTC parts follow the test clock", { timeout: 60_000 }, () => {
  it("a scenario clock sets the DS3231, and set_clock moves it across midnight (no network needed)", () => {
    const sc: Scenario = {
      id: "midnight",
      clock: "2026-11-13T23:59:57Z",
      timeout_ms: 20_000,
      steps: [
        { expect_serial: "2026-11-13 23:59:5", within_ms: 1500 },
        { expect_serial: "2026-11-14 00:00:0", within_ms: 5000 },
        { set_clock: "2026-11-20T08:00:00Z" },
        { expect_serial: "2026-11-20 08:00:0", within_ms: 2500 },
      ],
    } as Scenario;
    const r = runScenario(new SimHost(project, registry, HEX), sc, project, registry);
    expect(r.passed, JSON.stringify(r).slice(0, 2000)).toBe(true);
    expect(JSON.stringify(r.steps)).toMatch(/rtc now reads 2026-11-20 08:00:00/);
  });

  it("set_clock with neither a network nor an RTC says what to add", () => {
    const bare = parseProject({ format: "jumper/1", name: "bare", parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }], wires: [], firmware: { board: "uno", artifact: "firmware/main.hex" } });
    const r = runScenario(new SimHost(bare, registry, HEX), { id: "x", steps: [{ set_clock: "2026-11-20T08:00:00Z" }] } as Scenario, bare, registry);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/no device network and no real-time-clock part.*Fix: .*add an RTC part/);
  });
});

import { measuredSleep, powerBudget, sleepTimerSeconds } from "../src/power-budget.ts";

describe("round 15: battery life of a device that deep-sleeps", () => {
  const counter = parseProject({
    format: "jumper/1",
    name: "counter",
    parts: [
      { id: "xiao", type: "seeed-xiao-esp32c3", x: 0, y: 0 },
      { id: "epd", type: "epaper-154-ssd1681", x: 200, y: 0 },
      { id: "lid", type: "hall-switch-drv5032", x: 400, y: 0 },
      { id: "bat", type: "lipo-battery", x: 600, y: 0, props: { capacity: 150 } },
    ],
    wires: [],
    firmware: { board: "xiao", artifact: "firmware/main.bin" },
  });
  const FW = "void setup(){ esp_sleep_enable_timer_wakeup(3600ULL * 1000000ULL); esp_deep_sleep_start(); }";

  it("reads the sleep timer from the firmware, counts wakes per day, and gives weeks on a small cell", () => {
    expect(sleepTimerSeconds(FW)).toBe(3600);
    expect(sleepTimerSeconds("esp_deep_sleep(SLEEP_US)")).toBeUndefined();
    const b = powerBudget(counter, registry, FW);
    expect(b.wakes).toEqual({ per_day: 24, awake_s: 1 });
    const cpu = b.loads.find((l) => l.load.startsWith("board CPU"))!;
    expect(cpu.idle_ma).toBeCloseTo(0.044, 3); // the XIAO's own 44 µA, not the chip's 5 µA
    expect(cpu.duty_text).toMatch(/24 wakes a day x 1 s awake, deep sleep otherwise/);
    const epd = b.loads.find((l) => l.part === "epd")!;
    expect(epd.duty_text).toMatch(/24 full refresh.* a day x 2000 ms/);
    expect(epd.idle_ma).toBeCloseTo(0.001, 4);
    const hall = b.loads.find((l) => l.part === "lid")!;
    expect(hall.avg_ma).toBeLessThanOrEqual(0.001);
    expect(b.days!).toBeGreaterThan(60);
    expect(b.summary).toMatch(/days/);
    expect(b.summary).toMatch(/µA average/);
  });

  it("more wakes (a busy day of lid openings) and a longer awake time cost days; the measured pattern is used when no number is set", () => {
    const quiet = powerBudget(counter, registry, FW);
    const busy = powerBudget(counter, registry, FW, { wakes_per_day: 200, awake_s: 3 });
    expect(busy.days!).toBeLessThan(quiet.days! / 2);
    const m = measuredSleep([{ t_ms: 500, woke: { t_ms: 3_600_500 } }, { t_ms: 3_601_000 }], 3_601_000)!;
    expect(m.wakes_per_day).toBeCloseTo(48, 0);
    expect(m.awake_s).toBeCloseTo(0.5, 3);
    const b = powerBudget(counter, registry, FW, undefined, { measured: m });
    expect(b.wakes).toEqual({ per_day: m.wakes_per_day, awake_s: 0.5 });
    expect(b.assumptions.join(" ")).toMatch(/measured from the last run/);
  });
});
