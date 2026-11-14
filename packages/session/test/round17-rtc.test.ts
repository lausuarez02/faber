// Round 17: small, low-power real-time clocks. The ZS-042 DS3231 module was the bulkiest part and 96 %
// of the battery drain of the round 15 mood case (its power LED). The DS3231 mini module (same chip,
// no LED) and the RV-3028 breakout (45 nA) follow the test clock like it, and estimate_power says
// what the LED costs and what to do.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject, type Scenario } from "@jumper/project-format";
import { registry } from "@jumper/parts";
import { SimHost } from "../src/sim.ts";
import { runScenario } from "../src/scenario.ts";
import { powerBudget } from "../src/power-budget.ts";
import { usageFor } from "../src/hints.ts";

const HEX = readFileSync(fileURLToPath(new URL("../../parts/src/parts/ds3231-rtc/example.hex", import.meta.url)), "utf8");

describe("round 17: the small RTCs follow the test clock", { timeout: 60_000 }, () => {
  it("a scenario clock and set_clock set the DS3231 mini (RTClib reads it) and the RV-3028 alike", () => {
    const project = parseProject({
      format: "jumper/1",
      name: "two clocks",
      parts: [
        { id: "uno", type: "arduino-uno", x: 0, y: 0 },
        { id: "rtc", type: "ds3231-mini-rtc", x: 300, y: 0 },
        { id: "rv", type: "rv3028-rtc", x: 300, y: 300 },
      ],
      wires: [
        { id: "w1", from: { part: "rtc", pin: "VCC" }, to: { part: "uno", pin: "5V" } },
        { id: "w2", from: { part: "rtc", pin: "GND" }, to: { part: "uno", pin: "GND.1" } },
        { id: "w3", from: { part: "rtc", pin: "SDA" }, to: { part: "uno", pin: "A4" } },
        { id: "w4", from: { part: "rtc", pin: "SCL" }, to: { part: "uno", pin: "A5" } },
        { id: "w5", from: { part: "rv", pin: "VCC" }, to: { part: "uno", pin: "5V" } },
        { id: "w6", from: { part: "rv", pin: "GND" }, to: { part: "uno", pin: "GND.2" } },
        { id: "w7", from: { part: "rv", pin: "SDA" }, to: { part: "uno", pin: "A4" } },
        { id: "w8", from: { part: "rv", pin: "SCL" }, to: { part: "uno", pin: "A5" } },
      ],
      firmware: { board: "uno", artifact: "firmware/main.hex" },
    });
    const sc: Scenario = {
      id: "midnight",
      clock: "2026-11-13T23:59:57Z",
      timeout_ms: 20_000,
      steps: [
        { expect_serial: "2026-11-13 23:59:5", within_ms: 1500 },
        { expect_serial: "2026-11-14 00:00:0", within_ms: 5000 },
        { expect_part: "rv.time", op: "contains", value: "2026-11-14 00:00:0" },
        { set_clock: "2026-11-20T08:00:00Z" },
        { expect_serial: "2026-11-20 08:00:0", within_ms: 2500 },
      ],
    } as Scenario;
    const r = runScenario(new SimHost(project, registry, HEX), sc, project, registry);
    expect(r.passed, JSON.stringify(r).slice(0, 2000)).toBe(true);
    expect(JSON.stringify(r.steps)).toMatch(/rtc, rv now read 2026-11-20 08:00:00/);
  });
});

describe("round 17: what the ZS-042's power LED costs a sleeping battery device", () => {
  const FW = "void setup(){ esp_sleep_enable_timer_wakeup(3600ULL * 1000000ULL); esp_deep_sleep_start(); }";
  const mood = (rtc: { type: string; props?: Record<string, unknown> }) =>
    parseProject({
      format: "jumper/1",
      name: "mood",
      parts: [
        { id: "xiao", type: "seeed-xiao-esp32c3", x: 0, y: 0 },
        { id: "epd", type: "epaper-154-ssd1681", x: 200, y: 0 },
        { id: "rtc", type: rtc.type, x: 400, y: 0, ...(rtc.props ? { props: rtc.props } : {}) },
        { id: "bat", type: "lipo-battery", x: 600, y: 0, props: { capacity: 500 } },
      ],
      wires: [],
      firmware: { board: "xiao", artifact: "firmware/main.bin" },
      power: { wakes_per_day: 40, awake_s: 3 },
    });

  it("the LED is most of the budget; the suggestion says to desolder it (powerLed false) or use a module without one", () => {
    const zs = powerBudget(mood({ type: "ds3231-rtc" }), registry, FW);
    const rtc = zs.loads.find((l) => l.part === "rtc")!;
    expect(rtc.share).toBeGreaterThan(80);
    expect(rtc.source).toMatch(/1.89 mA is its power LED/);
    expect(zs.suggestions.join(" ")).toMatch(/power LED: desolder the LED \(or cut its jumper\), then set_part_property rtc powerLed false → about \d+(\.\d)? h on the same cell; or use a module without one \(ds3231-mini-rtc, rv3028-rtc\)/);
    const noLed = powerBudget(mood({ type: "ds3231-rtc", props: { powerLed: false } }), registry, FW);
    expect(noLed.loads.find((l) => l.part === "rtc")!.source).toMatch(/minus its 1.89 mA power LED/);
    const mini = powerBudget(mood({ type: "ds3231-mini-rtc" }), registry, FW);
    const rv = powerBudget(mood({ type: "rv3028-rtc" }), registry, FW);
    expect(noLed.hours!).toBeGreaterThan(zs.hours! * 5);
    expect(mini.hours!).toBeCloseTo(noLed.hours!, -1);
    expect(rv.hours!).toBeGreaterThan(mini.hours! * 1.5); // the DS3231's 0.11 mA is then the biggest load left
    expect(rv.loads.find((l) => l.part === "rtc")!.avg_ma).toBeLessThan(0.001);
  });
});

describe("round 17: get_part says which RTC to pick", () => {
  it("each RTC's usage names the trade-offs", () => {
    const zs = usageFor(registry.get("ds3231-rtc")!.spec).wiring;
    expect(zs).toMatch(/power LED/);
    expect(zs).toMatch(/charg/);
    expect(zs).toMatch(/ds3231-mini-rtc|rv3028-rtc/);
    expect(usageFor(registry.get("ds3231-mini-rtc")!.spec).wiring).toMatch(/RTC_DS3231/);
    const rv = usageFor(registry.get("rv3028-rtc")!.spec);
    expect(rv.wiring).toMatch(/0x52/);
    expect(rv.wiring).toMatch(/BSM|switchover/);
    expect(rv.example).toMatch(/const uint8_t RV3028 = 0x52;[\s\S]*Wire\.beginTransmission\(RV3028\)/);
  });
});

import { LIPO_POUCH_CELLS, thinnestCell } from "@jumper/parts";
import { LIPO_CELLS } from "@jumper/enclosure";

describe("round 17: the flat LiPo cells", () => {
  it("the catalog lists the common thin cells with real sizes, and the thinnest pick for a capacity", () => {
    const codes = LIPO_POUCH_CELLS.map((c) => c.code);
    for (const c of ["401730", "402030", "502030", "503035", "603030"]) expect(codes).toContain(c);
    for (const c of LIPO_POUCH_CELLS) {
      // the code is the size: thickness in 0.1 mm, then width and length
      expect(Number(c.code.slice(0, 2)) / 10).toBeCloseTo(c.d, 1);
      expect([Number(c.code.slice(2, 4)), Number(c.code.slice(4, 6))].sort()).toEqual([c.w, c.h].sort());
      expect(c.source.length).toBeGreaterThan(10);
    }
    expect(thinnestCell(150)?.code).toBe("401730");
    expect(thinnestCell(400, 5)?.code).toBe("503035");
    expect(thinnestCell(400, 4)).toBeUndefined();
    const lipo = registry.get("lipo-battery")!.spec;
    expect(lipo.tags).toEqual(expect.arrayContaining(["402030", "502030", "503035", "603030"]));
  });

  it("the case engine packs the same cell sizes for the codes both know", () => {
    // The enclosure's own table (capacity -> cell) is owned by the case track; this keeps the sizes
    // agreeing. Cells it does not know yet are listed so the gap is visible (see the round 17 notes).
    for (const e of LIPO_CELLS) {
      const p = LIPO_POUCH_CELLS.find((c) => c.code === e.code);
      expect(p, `enclosure cell ${e.code} is missing from LIPO_POUCH_CELLS`).toBeDefined();
      expect([p!.w, p!.h, p!.d].sort((a, b) => a - b)).toEqual([e.w, e.h, e.d].sort((a, b) => a - b));
    }
    const notInCase = LIPO_POUCH_CELLS.filter((c) => !LIPO_CELLS.some((e) => e.code === c.code)).map((c) => c.code);
    expect(notInCase.every((c) => ["603030"].includes(c))).toBe(true);
  });
});
