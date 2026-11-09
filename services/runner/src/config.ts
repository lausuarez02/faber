import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (services/runner/src → ../../..). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Base toolchain image (toolchains/arduino): arduino-cli 1.5.1 + arduino:avr 1.8.8 + the pinned display /
 * sensor libraries listed in toolchains/arduino/LIBRARIES.md. Keep the tag in sync with that Dockerfile.
 */
export const BASE_IMAGE = process.env.JUMPER_ARDUINO_IMAGE ?? "jumper/arduino-cli:1.5.1-avr1.8.8-libs1";
/** Runner image = base + the robot libraries (Servo) from services/runner/docker/Dockerfile. */
export const RUNNER_IMAGE = process.env.JUMPER_RUNNER_IMAGE ?? "jumper/arduino-runner:1.5.1-avr1.8.8-libs1-r1";

export const BASE_DOCKERFILE_DIR = join(REPO_ROOT, "toolchains/arduino");
export const RUNNER_DOCKERFILE_DIR = join(REPO_ROOT, "services/runner/docker");

export const DEFAULT_PORT = 7781;

/** Where builds, cached hex files and extra libraries live. Override with JUMPER_CACHE_DIR. */
export function cacheDir(): string {
  return process.env.JUMPER_CACHE_DIR ?? join(homedir(), ".cache", "jumper");
}

/**
 * Pinned library versions. "Adafruit SSD1306" without a version resolves to the version here.
 * `preinstalled` ones are baked into the runner image; others are installed on first use into the cache.
 * `deps` are added automatically (pinned too) so a sketch only has to name the library it includes.
 */
export const PINNED_LIBRARIES: Record<string, { version: string; preinstalled: boolean; license: string; deps?: string[]; headers: string[] }> = {
  "Adafruit SSD1306": { version: "2.5.17", preinstalled: true, license: "BSD-3-Clause", deps: ["Adafruit GFX Library", "Adafruit BusIO"], headers: ["Adafruit_SSD1306.h"] },
  "Adafruit GFX Library": { version: "1.13.0", preinstalled: true, license: "BSD-2-Clause", deps: ["Adafruit BusIO"], headers: ["Adafruit_GFX.h", "Fonts/FreeMono9pt7b.h"] },
  "Adafruit BusIO": { version: "1.17.4", preinstalled: true, license: "MIT", headers: ["Adafruit_I2CDevice.h", "Adafruit_BusIO_Register.h"] },
  Servo: { version: "1.3.0", preinstalled: true, license: "LGPL-2.1", headers: ["Servo.h"] },
  U8g2: { version: "2.36.19", preinstalled: true, license: "BSD-2-Clause", headers: ["U8g2lib.h", "U8x8lib.h"] },
  "Adafruit Unified Sensor": { version: "1.1.15", preinstalled: true, license: "Apache-2.0", headers: ["Adafruit_Sensor.h"] },
  "Adafruit BME280 Library": { version: "2.3.0", preinstalled: true, license: "BSD (see toolchains/arduino/LIBRARIES.md)", deps: ["Adafruit Unified Sensor", "Adafruit BusIO"], headers: ["Adafruit_BME280.h"] },
  "Adafruit MPU6050": { version: "2.2.9", preinstalled: true, license: "BSD (see toolchains/arduino/LIBRARIES.md)", deps: ["Adafruit Unified Sensor", "Adafruit BusIO"], headers: ["Adafruit_MPU6050.h"] },
  RTClib: { version: "2.1.4", preinstalled: true, license: "MIT (see toolchains/arduino/LIBRARIES.md)", deps: ["Adafruit BusIO"], headers: ["RTClib.h"] },
  LiquidCrystal_PCF8574: { version: "2.3.0", preinstalled: true, license: "see toolchains/arduino/LIBRARIES.md", headers: ["LiquidCrystal_PCF8574.h"] },
  "LiquidCrystal I2C": { version: "1.1.2", preinstalled: true, license: "see toolchains/arduino/LIBRARIES.md", headers: ["LiquidCrystal_I2C.h"] },
  MPU6050: { version: "1.4.5", preinstalled: true, license: "see toolchains/arduino/LIBRARIES.md", headers: ["MPU6050.h"] },
  NewPing: { version: "1.9.7", preinstalled: false, license: "GPL-3.0 (copyleft: your firmware becomes GPL if you ship it)", headers: ["NewPing.h"] },
};

/** Headers that come with the Arduino AVR core (no library to declare). */
export const CORE_HEADERS = ["Arduino.h", "Wire.h", "SPI.h", "EEPROM.h", "SoftwareSerial.h", "avr/pgmspace.h", "avr/io.h", "avr/interrupt.h", "util/delay.h"];

/** header file name → library name, for "No such file" hints. */
export function libraryForHeader(header: string): string | undefined {
  for (const [name, info] of Object.entries(PINNED_LIBRARIES)) if (info.headers.includes(header)) return name;
  return undefined;
}
