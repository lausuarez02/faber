import type { ProjectInput } from "@jumper/project-format";
import { MICROPYTHON_OLED_MAIN, MICROPYTHON_SSD1306, micropythonMain, platformioFiles } from "./starters.ts";

/** Starting points for new_project. Each is a jumper.json plus firmware files. */
export interface Template {
  description: string;
  /** Part types it needs (checked against the catalog). */
  needs: string[];
  project: (name: string) => ProjectInput;
  files: Record<string, string>;
}

const BLINK_INO = `// Blink: D13 drives an LED through 220 ohm, 1 s on / 1 s off, and says so on serial.
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  Serial.println("LED on");
  delay(1000);
  digitalWrite(13, LOW);
  Serial.println("LED off");
  delay(1000);
}
`;

const EMPTY_INO = `void setup() {
  Serial.begin(115200);
  Serial.println("ready");
}

void loop() {
}
`;

/** RP2040 boards: Serial is native USB, so wait for the computer to open the port (decision 0003, C1). */
const rp2040Ino = (led: string | undefined) => `// ${led ? "Blinks the on-board LED and says" : "Says"} "ready" on USB serial.
void setup() {
  Serial.begin(115200);
  // Serial is the board's own USB port: wait (up to 2 s) for the computer to open it, or the first
  // lines are lost.
  while (!Serial && millis() < 2000) delay(10);
  Serial.println("ready");${led ? `\n  pinMode(LED_BUILTIN, OUTPUT);` : ""}
}

void loop() {${led ? `\n  digitalWrite(LED_BUILTIN, ${led === "low" ? "LOW" : "HIGH"});  // on${led === "low" ? " (this LED is active low)" : ""}\n  delay(500);\n  digitalWrite(LED_BUILTIN, ${led === "low" ? "HIGH" : "LOW"});\n  delay(500);` : ""}
}
`;

function rp2040Template(type: string, id: string, fqbn: string, name: string, led: "high" | "low" | undefined): Template {
  return {
    description: `A ${name} (RP2040, 3.3 V) and a sketch (firmware/main.ino) that prints 'ready'${led ? " and blinks the on-board LED" : ""}.`,
    needs: [type],
    project: (projectName) => ({
      format: "jumper/1",
      name: projectName,
      parts: [{ id, type, x: 0, y: 0 }],
      wires: [],
      firmware: { board: id, dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn } },
      scenarios: [{ id: "boots", name: "Firmware boots", steps: [{ expect_serial: "ready", within_ms: 1000 }] }],
    }),
    files: { "firmware/main.ino": rp2040Ino(led) },
  };
}

/** ESP32-family boards (round 10): Serial is UART0 in the simulator build, so no wait for USB. */
const espIno = (led: "high" | "low" | undefined) => `// ${led ? "Blinks the on-board LED and says" : "Says"} "ready" on serial.
void setup() {
  Serial.begin(115200);
  Serial.println("ready");${led ? `\n  pinMode(LED_BUILTIN, OUTPUT);` : ""}
}

void loop() {${led ? `\n  digitalWrite(LED_BUILTIN, ${led === "low" ? "LOW" : "HIGH"});  // on${led === "low" ? " (this LED is active low)" : ""}\n  delay(500);\n  digitalWrite(LED_BUILTIN, ${led === "low" ? "HIGH" : "LOW"});\n  delay(500);` : "\n  delay(1000);"}
}
`;

function espTemplate(type: string, id: string, fqbn: string, name: string, chip: string, led: "high" | "low" | undefined): Template {
  return {
    description: `A ${name} (${chip}, 3.3 V; runs in a local emulator, needs Docker) and a sketch (firmware/main.ino) that prints 'ready'${led ? " and blinks the on-board LED" : ""}.`,
    needs: [type],
    project: (projectName) => ({
      format: "jumper/1",
      name: projectName,
      parts: [{ id, type, x: 0, y: 0 }],
      wires: [],
      firmware: { board: id, dir: "firmware", sketch: "main.ino", artifact: "firmware/main.bin", build: { tool: "arduino-cli", fqbn } },
      scenarios: [{ id: "boots", name: "Firmware boots", steps: [{ expect_serial: "ready", within_ms: 1500 }] }],
    }),
    files: { "firmware/main.ino": espIno(led) },
  };
}

export const TEMPLATES: Record<string, Template> = {
  blank: {
    description: "Empty canvas, no parts, no firmware.",
    needs: [],
    project: (name) => ({ format: "jumper/1", name, parts: [], wires: [], scenarios: [] }),
    files: {},
  },
  uno: {
    description: "An Arduino Uno and an empty sketch (firmware/main.ino) that prints 'ready'.",
    needs: ["arduino-uno"],
    project: (name) => ({
      format: "jumper/1",
      name,
      parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }],
      wires: [],
      firmware: { board: "uno", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" } },
      scenarios: [{ id: "boots", name: "Firmware boots", steps: [{ expect_serial: "ready", within_ms: 500 }] }],
    }),
    files: { "firmware/main.ino": EMPTY_INO },
  },
  nano: {
    description: "An Arduino Nano and an empty sketch (firmware/main.ino).",
    needs: ["arduino-nano"],
    project: (name) => ({
      format: "jumper/1",
      name,
      parts: [{ id: "nano", type: "arduino-nano", x: 0, y: 0 }],
      wires: [],
      firmware: { board: "nano", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:nano" } },
      scenarios: [{ id: "boots", name: "Firmware boots", steps: [{ expect_serial: "ready", within_ms: 500 }] }],
    }),
    files: { "firmware/main.ino": EMPTY_INO },
  },
  // rp2040 track (decision 0003, C1): the pocket boards.
  pico: rp2040Template("raspberry-pi-pico", "pico", "rp2040:rp2040:rpipico", "Raspberry Pi Pico", "high"),
  "xiao-rp2040": rp2040Template("seeed-xiao-rp2040", "xiao", "rp2040:rp2040:seeed_xiao_rp2040", "Seeed XIAO RP2040", "low"),
  "rp2040-zero": rp2040Template("waveshare-rp2040-zero", "zero", "rp2040:rp2040:waveshare_rp2040_zero", "Waveshare RP2040-Zero", undefined),
  "xiao-esp32s3": espTemplate("seeed-xiao-esp32s3", "xiao", "esp32:esp32:XIAO_ESP32S3", "Seeed XIAO ESP32-S3", "ESP32-S3", "low"),
  "xiao-esp32c3": espTemplate("seeed-xiao-esp32c3", "xiao", "esp32:esp32:XIAO_ESP32C3", "Seeed XIAO ESP32-C3", "ESP32-C3", undefined),
  "esp32-c3-supermini": espTemplate("esp32-c3-supermini", "c3", "esp32:esp32:nologo_esp32c3_super_mini", "ESP32-C3 SuperMini", "ESP32-C3", "low"),
  esp32: espTemplate("esp32-devkitc", "esp32", "esp32:esp32:esp32", "ESP32 DevKitC", "ESP32", undefined),
  "esp32-s3": espTemplate("esp32-s3-devkitc-1", "s3", "esp32:esp32:esp32s3", "ESP32-S3 DevKitC-1", "ESP32-S3", undefined),
  // Round 10 (languages): the same boards in other firmware languages.
  "pico-micropython": {
    description: "A Raspberry Pi Pico running MicroPython: firmware/main.py blinks the on-board LED and prints to the Serial panel, which is also the REPL.",
    needs: ["raspberry-pi-pico"],
    project: (name) => ({
      format: "jumper/1",
      name,
      parts: [{ id: "pico", type: "raspberry-pi-pico", x: 0, y: 0 }],
      wires: [],
      firmware: { board: "pico", language: "micropython", dir: "firmware", sketch: "main.py", artifact: "firmware/main.hex", build: { tool: "micropython" } },
      scenarios: [{ id: "blinks", name: "main.py runs and blinks", steps: [{ expect_serial: "ready", within_ms: 1000 }, { expect_serial: "LED on", within_ms: 600 }, { expect_part: "pico.led", op: "==", value: 1 }, { expect_serial: "LED off", within_ms: 600 }, { expect_part: "pico.led", op: "==", value: 0 }] }],
    }),
    files: { "firmware/main.py": micropythonMain({ chip: "rp2040", type: "raspberry-pi-pico" }) },
  },
  "pico-micropython-oled": {
    description: "A Raspberry Pi Pico running MicroPython with an SSD1306 OLED on I2C0 (GP4 / GP5): main.py draws a counter and a bar with a small ssd1306.py driver.",
    needs: ["raspberry-pi-pico", "ssd1306-oled-i2c"],
    project: (name) => ({
      format: "jumper/1",
      name,
      parts: [
        { id: "pico", type: "raspberry-pi-pico", x: 0, y: 0 },
        { id: "oled", type: "ssd1306-oled-i2c", x: 320, y: -40 },
      ],
      wires: [
        { id: "w1", from: { part: "oled", pin: "GND" }, to: { part: "pico", pin: "GND.1" }, color: "#2B3038" },
        { id: "w2", from: { part: "oled", pin: "VCC" }, to: { part: "pico", pin: "3V3" }, color: "#FF4D2E" },
        { id: "w3", from: { part: "oled", pin: "SDA" }, to: { part: "pico", pin: "GP4" }, color: "#F2E14A" },
        { id: "w4", from: { part: "oled", pin: "SCL" }, to: { part: "pico", pin: "GP5" }, color: "#B47CFF" },
      ],
      firmware: { board: "pico", language: "micropython", dir: "firmware", sketch: "main.py", artifact: "firmware/main.hex", build: { tool: "micropython" } },
      scenarios: [{ id: "draws", name: "The OLED shows frames", steps: [{ expect_serial: "i2c scan: ['0x3c']", within_ms: 1500 }, { expect_serial: "frame 2", within_ms: 2000 }, { expect_part: "oled.blank", op: "==", value: false, within_ms: 500 }] }],
    }),
    files: { "firmware/main.py": MICROPYTHON_OLED_MAIN, "firmware/ssd1306.py": MICROPYTHON_SSD1306 },
  },
  "uno-platformio": {
    description: "An Arduino Uno built with PlatformIO: firmware/platformio.ini ([env:uno], atmelavr) and firmware/src/main.cpp blinking D13.",
    needs: ["arduino-uno"],
    project: (name) => ({
      format: "jumper/1",
      name,
      parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }],
      wires: [],
      firmware: { board: "uno", language: "platformio", dir: "firmware", sketch: "platformio.ini", artifact: "firmware/main.hex", build: { tool: "platformio", env: "uno" } },
      scenarios: [{ id: "blinks", name: "D13 blinks", steps: [{ expect_serial: "ready", within_ms: 500 }, { expect_serial: "LED on", within_ms: 600 }, { expect_pin: "uno.D13", level: "high" }] }],
    }),
    files: platformioFiles({ chip: "atmega328p", type: "arduino-uno" }),
  },
  blink: {
    description: "Uno + 220 Ω + red LED on D13, the Blink sketch and two passing scenarios.",
    needs: ["arduino-uno", "resistor", "led"],
    project: (name) => ({
      format: "jumper/1",
      name,
      description: "D13 drives a red LED through 220 Ω, 1 s on / 1 s off.",
      parts: [
        { id: "uno", type: "arduino-uno", x: 0, y: 0 },
        { id: "r1", type: "resistor", x: 300, y: -130, props: { resistance: 220 } as Record<string, number> },
        { id: "led1", type: "led", x: 440, y: -210, props: { color: "red" } as Record<string, string> },
      ],
      wires: [
        { id: "w1", from: { part: "uno", pin: "D13" }, to: { part: "r1", pin: "1" }, color: "#FF4D2E" },
        { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" }, color: "#FF4D2E" },
        { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "uno", pin: "GND.1" }, color: "#2B3038" },
      ],
      firmware: { board: "uno", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" } },
      scenarios: [
        { id: "blinks", name: "LED turns on and off", steps: [{ expect_serial: "LED on", within_ms: 1100 }, { expect_pin: "uno.D13", level: "high" }, { expect_part: "led1.on", op: "==", value: true }, { expect_serial: "LED off", within_ms: 1100 }, { expect_pin: "uno.D13", level: "low" }] },
        { id: "safe", name: "No part is overloaded", steps: [{ run_ms: 2500 }, { expect_no_errors: true }] },
      ],
    }),
    files: { "firmware/main.ino": BLINK_INO },
  },
};

/** Every starter sketch a template writes, to tell "still the template" from firmware someone wrote. */
export const TEMPLATE_SOURCES: ReadonlySet<string> = new Set(Object.values(TEMPLATES).flatMap((t) => Object.values(t.files).map((f) => f.trim())));
