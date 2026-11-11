// Round 10 (languages): the starter files set_firmware writes for each language, and the
// language-specific templates. Board facts come from the board part (chip, on-board LED); nothing
// here is per-board code beyond picking a pin.
import type { FirmwareLanguage } from "@jumper/project-format";

export interface StarterBoard {
  /** part.json mcu.chip, e.g. "rp2040", "esp32c3". */
  chip?: string;
  /** Board part type, e.g. "raspberry-pi-pico". */
  type?: string;
}

/** The on-board LED GPIO a starter blinks (undefined: the board has none Jumper draws). */
function ledGpio(b: StarterBoard): { gpio: number; activeLow: boolean } | undefined {
  if (b.type === "raspberry-pi-pico") return { gpio: 25, activeLow: false };
  if (b.type === "seeed-xiao-rp2040") return { gpio: 25, activeLow: true }; // blue user LED
  if (b.chip === "esp32") return { gpio: 2, activeLow: false };
  if (b.chip === "esp32c3") return { gpio: 8, activeLow: false };
  return undefined;
}

export function micropythonMain(b: StarterBoard): string {
  const led = ledGpio(b);
  if (!led) {
    return `# MicroPython: prints "ready", then a counter every second.
# print() goes to the Serial panel, which is also the REPL once main.py ends.
import time

print("ready")
n = 0
while True:
    print("tick", n)
    n += 1
    time.sleep_ms(1000)
`;
  }
  return `# MicroPython blink: the on-board LED (GPIO ${led.gpio}${led.activeLow ? ", active low" : ""}) toggles every 500 ms.
# print() goes to the Serial panel, which is also the REPL once main.py ends (Ctrl-C stops it).
from machine import Pin
import time

led = Pin(${led.gpio}, Pin.OUT)
print("ready")
while True:
    led.toggle()
    print("LED", "${led.activeLow ? "off" : "on"}" if led.value() else "${led.activeLow ? "on" : "off"}")
    time.sleep_ms(500)
`;
}

export function espIdfFiles(b: StarterBoard): Record<string, string> {
  const led = ledGpio(b) ?? { gpio: 2, activeLow: false };
  return {
    "firmware/CMakeLists.txt": `# ESP-IDF project (built by Jumper with ESP-IDF v5.5.5, idf.py build).
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(jumper_app)
`,
    "firmware/main/CMakeLists.txt": `idf_component_register(SRCS "main.c" INCLUDE_DIRS "." REQUIRES driver)
`,
    "firmware/main/main.c": `// ESP-IDF blink: GPIO ${led.gpio} toggles every 500 ms and the console says so (UART0, 115200).
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define LED_GPIO ${led.gpio}

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);
    printf("ready\\n");
    int on = 0;
    while (1) {
        on = !on;
        gpio_set_level(LED_GPIO, on);
        printf("LED %s\\n", on ? "on" : "off");
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
`,
  };
}

export function platformioFiles(b: StarterBoard & { fqbn?: string }): Record<string, string> {
  const board = b.type === "arduino-nano" ? "nanoatmega328" : "uno";
  return {
    "firmware/platformio.ini": `; PlatformIO project (built by Jumper with PlatformIO Core 6.2.0, platform atmelavr 5.3.0).
[env:${board}]
platform = atmelavr@5.3.0
board = ${board}
framework = arduino
`,
    "firmware/src/main.cpp": `// PlatformIO blink: D13 toggles every 500 ms and says so on serial.
#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
  Serial.println("ready");
}

void loop() {
  digitalWrite(13, !digitalRead(13));
  Serial.println(digitalRead(13) ? "LED on" : "LED off");
  delay(500);
}
`,
  };
}

/** Files and firmware fields for a language on a board. `sketch` is relative to firmware/. */
export function starterFor(language: Exclude<FirmwareLanguage, "rust" | "zephyr">, b: StarterBoard & { fqbn?: string }): { sketch: string; artifact: string; build: Record<string, string>; files: Record<string, string> } {
  switch (language) {
    case "micropython":
      return { sketch: "main.py", artifact: b.chip === "rp2040" ? "firmware/main.hex" : "firmware/main.bin", build: { tool: "micropython" }, files: { "firmware/main.py": micropythonMain(b) } };
    case "esp-idf":
      return { sketch: "main/main.c", artifact: "firmware/main.bin", build: { tool: "esp-idf" }, files: espIdfFiles(b) };
    case "platformio":
      return { sketch: "platformio.ini", artifact: "firmware/main.hex", build: { tool: "platformio" }, files: platformioFiles(b) };
    case "arduino":
      return {
        sketch: "main.ino",
        artifact: "firmware/main.hex",
        build: { tool: "arduino-cli", fqbn: b.fqbn ?? "arduino:avr:uno" },
        files: { "firmware/main.ino": 'void setup() {\n  Serial.begin(115200);\n  Serial.println("ready");\n}\n\nvoid loop() {\n}\n' },
      };
  }
}

/** A small SSD1306 driver for MicroPython (Jumper's own, Apache-2.0), on top of the built-in framebuf. */
export const MICROPYTHON_SSD1306 = `# ssd1306.py: SSD1306 128x64 / 128x32 OLED over I2C for MicroPython.
# Jumper's own minimal driver (Apache-2.0). Draw with the framebuf methods
# (fill, text, rect, line, pixel...), then call show().
import framebuf


class SSD1306_I2C(framebuf.FrameBuffer):
    def __init__(self, width, height, i2c, addr=0x3C):
        self.width = width
        self.height = height
        self.i2c = i2c
        self.addr = addr
        self.pages = height // 8
        self.buffer = bytearray(self.pages * width)
        super().__init__(self.buffer, width, height, framebuf.MONO_VLSB)
        for c in (
            0xAE, 0xD5, 0x80, 0xA8, height - 1, 0xD3, 0x00, 0x40,
            0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8,
            0xDA, 0x12 if height == 64 else 0x02,
            0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF,
        ):
            self.cmd(c)
        self.fill(0)
        self.show()

    def cmd(self, c):
        self.i2c.writeto(self.addr, bytes((0x80, c)))

    def show(self):
        for c in (0x21, 0, self.width - 1, 0x22, 0, self.pages - 1):
            self.cmd(c)
        self.i2c.writevto(self.addr, (b"\\x40", self.buffer))
`;

export const MICROPYTHON_OLED_MAIN = `# MicroPython + SSD1306 OLED on I2C0 (SDA GP4, SCL GP5): a title, a frame counter and a moving bar.
from machine import Pin, I2C
import time
import ssd1306

i2c = I2C(0, sda=Pin(4), scl=Pin(5), freq=400_000)
print("i2c scan:", [hex(a) for a in i2c.scan()])
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
n = 0
while True:
    oled.fill(0)
    oled.text("MicroPython", 0, 0)
    oled.text("frame %d" % n, 0, 16)
    oled.fill_rect(0, 40, 8 + (n * 12) % 120, 8, 1)
    oled.show()
    print("frame", n)
    n += 1
    time.sleep_ms(250)
`;
