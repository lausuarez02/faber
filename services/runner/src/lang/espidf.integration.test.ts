// ESP-IDF projects built in jumper/esp-idf and booted in Jumper's QEMU: blink + console on the
// ESP32 and ESP32-C3, and an I2C write to a part at 0x3C on the ESP32. Needs Docker with both images.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { I2cBus } from "@jumper/sim-core";
import { QemuEspBackend } from "@jumper/sim-backends/qemu-esp";
import { buildFirmware } from "../build.ts";
import { imagePresent } from "./docker-guard.ts";
import { ESP_IDF_IMAGE } from "./toolchain.ts";

const available = imagePresent(ESP_IDF_IMAGE.image) && imagePresent("jumper/qemu-esp:9.2.2-20260417-jb2");

const CMAKE = "cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(jumper_app)\n";
const BLINK = (gpio: number, i2c: boolean) => `#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
${i2c ? '#include "driver/i2c_master.h"' : ""}
void app_main(void) {
  gpio_reset_pin(${gpio});
  gpio_set_direction(${gpio}, GPIO_MODE_OUTPUT);
  printf("ready\\n");
${i2c ? `  i2c_master_bus_config_t bc = { .i2c_port = 0, .sda_io_num = 21, .scl_io_num = 22, .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = true };
  i2c_master_bus_handle_t bus; i2c_new_master_bus(&bc, &bus);
  i2c_device_config_t dc = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x3C, .scl_speed_hz = 100000 };
  i2c_master_dev_handle_t dev; i2c_master_bus_add_device(bus, &dc, &dev);
  uint8_t on[2] = { 0x80, 0xAF };
  printf("i2c %d\\n", (int)i2c_master_transmit(dev, on, 2, 100));` : ""}
  for (int i = 0; i < 4; i++) { gpio_set_level(${gpio}, i & 1 ? 0 : 1); printf("blink %d\\n", i); vTaskDelay(pdMS_TO_TICKS(100)); }
  printf("done\\n");
}
`;

describe.skipIf(!available)("ESP-IDF (idf.py in Docker, run in QEMU)", { timeout: 1_800_000 }, () => {
  const dirs: string[] = [];
  const backends: QemuEspBackend[] = [];
  afterAll(() => {
    backends.forEach((b) => b.close());
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  for (const [chip, gpio] of [["esp32", 2], ["esp32c3", 8]] as const) {
    it(`${chip}: builds, boots, blinks GPIO${gpio}${chip === "esp32" ? " and writes I2C0" : ""}; a typo is an error at file:line`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "jumper-idf-"));
      dirs.push(dir);
      const write = (rel: string, text: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      };
      write("CMakeLists.txt", CMAKE);
      write("main/CMakeLists.txt", `idf_component_register(SRCS "main.c" INCLUDE_DIRS "." REQUIRES driver ${chip === "esp32" ? "esp_driver_i2c" : ""})\n`);
      write("main/main.c", BLINK(gpio, chip === "esp32"));
      const r = await buildFirmware({ sketchDir: dir, language: "esp-idf", chip, displayPrefix: "firmware/" });
      expect(r.ok, r.logTail).toBe(true);
      expect(r.binary!.length).toBe(4 << 20);
      const be = new QemuEspBackend({ chip, network: false });
      backends.push(be);
      const bus = new I2cBus("i2c0", () => be.cycles);
      const writes: number[] = [];
      bus.attach("oled", { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: (b) => (writes.push(b), true), i2cRead: () => 0, i2cStop: () => {} });
      be.attachI2c(bus);
      let serial = "";
      be.onSerial((b) => (serial += String.fromCharCode(b)));
      be.load(r.binary!);
      const end = be.cycles + be.cyclesPerSecond * 3;
      while (be.cycles < end && !serial.includes("done")) be.step(Math.round(be.cyclesPerSecond / 100));
      expect(serial).toContain("ready");
      expect(serial).toContain("done");
      if (chip === "esp32") expect(writes).toEqual([0x80, 0xaf]);

      write("main/main.c", BLINK(gpio, false).replace("printf(\"ready\\n\");", "printf(\"ready\\n\")"));
      const bad = await buildFirmware({ sketchDir: dir, language: "esp-idf", chip, displayPrefix: "firmware/" });
      expect(bad.ok).toBe(false);
      expect(bad.diagnostics.some((d) => d.file === "firmware/main/main.c" && d.severity === "error" && typeof d.line === "number")).toBe(true);
    });
  }
});
