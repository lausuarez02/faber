// Round 15: deep sleep with real firmware. A XIAO ESP32-C3 sketch written for the real device counts
// lid openings across deep sleeps: RTC_DATA_ATTR counters, a GPIO wake-up (a switch to ground) and an
// hourly timer. The simulation build links the JumperSleep shim; Jumper stops the firmware while it
// sleeps (an hour of virtual time in a few seconds), wakes it on the pin or the timer, and the sketch
// sees the right wake cause, its RTC memory and a clock moved on by the time slept.
// Needs the native ESP32 toolchain + QEMU (jumper setup esp32); skipped otherwise.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canBuildArduino } from "@jumper/runner";
import { qemuImageAvailable } from "@jumper/sim-backends/node";
import { ProjectSession } from "../src/index.ts";

const ready = qemuImageAvailable() && canBuildArduino("esp32:esp32:XIAO_ESP32C3").ok;
if (!ready) console.warn("skipping the deep-sleep firmware test: the ESP32 toolchain and QEMU are not ready (Fix: pnpm jumper setup esp32)");

const SKETCH = `// Counts lid openings; sleeps between them. Written for the real XIAO ESP32-C3.
#include <sys/time.h>
#define LID 3  // D1: a switch (reed, hall, lever) to GND, closed while the lid is OPEN

RTC_DATA_ATTR int boots = 0;
RTC_DATA_ATTR int count = 0;

void setup() {
  Serial.begin(115200);
  delay(20);
  boots++;
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_GPIO) count++;
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  Serial.printf("boot %d cause %d count %d reset %d t %ld\\n", boots, (int)cause, count, (int)esp_reset_reason(), (long)tv.tv_sec);
  pinMode(LID, INPUT_PULLUP);
  while (digitalRead(LID) == LOW) delay(10);  // wait until the lid is closed again
  esp_deep_sleep_enable_gpio_wakeup(1ULL << LID, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_sleep_enable_timer_wakeup(3600ULL * 1000000ULL);  // and once an hour (a new day starts at midnight)
  esp_deep_sleep_start();
}

void loop() {}
`;

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe.skipIf(!ready)("deep sleep with real firmware (real build, real QEMU)", { timeout: 900_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "jumper-sleep-fw-"));
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("wakes on the pin and on the timer; RTC memory, the wake cause and the clock survive", async () => {
    await call(s, "new_project", { template: "xiao-esp32c3" });
    await call(s, "place_part", { type: "pushbutton", id: "lid" });
    await call(s, "connect", { from: "lid.1a", to: "xiao.GPIO3" });
    await call(s, "connect", { from: "lid.2a", to: "xiao.GND" });
    await call(s, "write_file", { path: "firmware/main.ino", content: SKETCH });
    const b = await call(s, "build");
    expect(b.ok, JSON.stringify(b).slice(0, 3000)).toBe(true);
    // the simulation build links the shim (its console line is in the image); the device build does not
    expect(readFileSync(join(dir, "firmware/main.bin")).includes(Buffer.from("[jumper:sleep]"))).toBe(true);
    await call(s, "write_scenario", {
      id: "count-across-sleeps",
      timeout_ms: 4_000_000,
      steps: [
        { expect_serial: { regex: "boot 1 cause 0 count 0" }, within_ms: 4000 },
        { run_ms: 1000 },
        { expect_part: "xiao.asleep", op: "==", value: true },
        { press: "lid", hold_ms: 400 },
        { expect_serial: { regex: "boot 2 cause 7 count 1 reset 8" }, within_ms: 4000 },
        { run_ms: 1000 },
        { expect_part: "xiao.asleep", op: "==", value: true },
        { run_ms: 3_600_000 },
        { expect_serial: { regex: "boot 3 cause 4 count 1 reset 8 t 36\\d\\d" }, within_ms: 5000 },
      ],
    });
    const t0 = Date.now();
    const r = await call(s, "run_tests", { ids: ["count-across-sleeps"] });
    const res = ((r.results ?? r.scenarios ?? []) as Array<Record<string, any>>).find((x) => x.id === "count-across-sleeps") ?? r;
    expect(res.passed, JSON.stringify(res).slice(0, 4000)).toBe(true);
    console.log(`deep-sleep scenario: ${Math.round((Date.now() - t0) / 1000)} s wall for ${Math.round(res.t_ms / 1000)} s virtual`);
  });

  it("an e-paper face that survives deep sleep: the sketch draws with raw SPI, refreshes, hibernates the panel, sleeps; a reed switch wakes it", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "jumper-sleep-epd-"));
    const s2 = new ProjectSession({ dir: d2, actor: "test" });
    try {
      await call(s2, "new_project", { template: "xiao-esp32c3" });
      await call(s2, "place_part", { type: "epaper-154-ssd1681", id: "epd" });
      await call(s2, "place_part", { type: "reed-switch", id: "lid" });
      const wires: [string, string][] = [
        ["epd.VCC", "xiao.3V3"], ["epd.GND", "xiao.GND"], ["epd.DIN", "xiao.GPIO10"], ["epd.CLK", "xiao.GPIO8"],
        ["epd.CS", "xiao.GPIO5"], ["epd.DC", "xiao.GPIO4"], ["epd.RST", "xiao.GPIO7"], ["epd.BUSY", "xiao.GPIO6"],
        ["lid.1", "xiao.GPIO3"], ["lid.2", "xiao.GND"],
      ];
      for (const [from, to] of wires) await call(s2, "connect", { from, to });
      // the lid is closed (magnet near) at the start
      await call(s2, "set_part_property", { id: "lid", prop: "magnet_mm", value: 3 });
      await call(s2, "write_file", { path: "firmware/main.ino", content: EPD_SKETCH });
      const b = await call(s2, "build");
      expect(b.ok, JSON.stringify(b).slice(0, 3000)).toBe(true);
      await call(s2, "write_scenario", {
        id: "face-across-sleeps",
        timeout_ms: 200_000,
        steps: [
          { expect_serial: { regex: "opens 0" }, within_ms: 4000 },
          { expect_part: "epd.lit", op: "==", value: 200, within_ms: 6000 },
          { expect_part: "epd.sleeping", op: "==", value: true, within_ms: 1000 },
          { expect_part: "xiao.asleep", op: "==", value: true, within_ms: 1000 },
          { run_ms: 60_000 },
          { set: "lid.magnet_mm", value: 30 },
          { expect_serial: { regex: "opens 1" }, within_ms: 4000 },
          { set: "lid.magnet_mm", value: 3 },
          { expect_part: "epd.lit", op: "==", value: 300, within_ms: 6000 },
          { expect_part: "xiao.asleep", op: "==", value: true, within_ms: 3000 },
          { expect_part: "epd.fullRefreshes", op: "==", value: 2 },
        ],
      });
      const r = await call(s2, "run_tests", { ids: ["face-across-sleeps"] });
      const res = ((r.results ?? r.scenarios ?? []) as Array<Record<string, any>>).find((x) => x.id === "face-across-sleeps") ?? r;
      expect(res.passed, JSON.stringify(res).slice(0, 4000)).toBe(true);
    } finally {
      s2.dispose();
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

const EPD_SKETCH = `// Raw SSD1681 over SPI (no library) on a XIAO ESP32-C3; the reed switch closes while the lid is shut.
#include <SPI.h>
#define CS 5
#define DC 4
#define RST 7
#define BUSY 6
#define LID 3

RTC_DATA_ATTR int opens = 0;

void waitBusy() { while (digitalRead(BUSY) == HIGH) delay(5); }
void cmd(uint8_t c) { digitalWrite(DC, LOW); digitalWrite(CS, LOW); SPI.transfer(c); digitalWrite(CS, HIGH); digitalWrite(DC, HIGH); }
void dat(uint8_t d) { digitalWrite(CS, LOW); SPI.transfer(d); digitalWrite(CS, HIGH); }

void setup() {
  Serial.begin(115200);
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_GPIO) opens++;
  Serial.printf("opens %d\\n", opens);
  pinMode(CS, OUTPUT); digitalWrite(CS, HIGH);
  pinMode(DC, OUTPUT); pinMode(RST, OUTPUT); pinMode(BUSY, INPUT);
  pinMode(LID, INPUT_PULLUP);
  SPI.begin(8, 9, 10, -1);
  digitalWrite(RST, LOW); delay(10); digitalWrite(RST, HIGH); delay(10);
  cmd(0x12); waitBusy();
  cmd(0x01); dat(0xC7); dat(0x00); dat(0x00);
  cmd(0x11); dat(0x03);
  cmd(0x44); dat(0); dat(24);
  cmd(0x45); dat(0); dat(0); dat(199); dat(0);
  cmd(0x4E); dat(0);
  cmd(0x4F); dat(0); dat(0);
  cmd(0x24);
  for (int y = 0; y < 200; y++)
    for (int xb = 0; xb < 25; xb++) {
      uint8_t v = 0xFF;
      if (y == 0) v = 0x00;                                     // a line along the top
      if (y >= 20 && y < 30 && xb < opens * 2 && (xb % 2) == 0) v = 0x00; // 8x10 px per open
      if (y >= 20 && y < 30 && xb < opens * 2 && (xb % 2) == 1) v = 0x3F; // + 2 px = 10x10
      dat(v);
    }
  cmd(0x22); dat(0xF7);
  cmd(0x20); delay(1); waitBusy();
  cmd(0x10); dat(0x01);                                         // panel to deep sleep: the image stays
  esp_deep_sleep_enable_gpio_wakeup(1ULL << LID, ESP_GPIO_WAKEUP_GPIO_HIGH);  // the lid opens: the reed opens, the pull-up wins
  esp_deep_sleep_start();
}

void loop() {}
`;

