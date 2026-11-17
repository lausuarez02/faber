import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (services/runner/src → ../../..). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Base toolchain image (toolchains/arduino): arduino-cli 1.5.1 + arduino:avr 1.8.8 + the pinned display /
 * sensor libraries listed in toolchains/arduino/LIBRARIES.md. Keep the tag in sync with that Dockerfile.
 */
export const BASE_IMAGE = process.env.FABWRIGHT_ARDUINO_IMAGE ?? "fabwright/arduino-cli:1.5.1-avr1.8.8-libs3";
/** Runner image = base + the robot libraries (Servo) from services/runner/docker/Dockerfile. */
export const RUNNER_IMAGE = process.env.FABWRIGHT_RUNNER_IMAGE ?? "fabwright/arduino-runner:1.5.1-avr1.8.8-libs3-r1";

/**
 * RP2040 image (toolchains/arduino-pico): the runner image + Earle Philhower's arduino-pico core
 * 6.3.1 (rp2040:rp2040), which writes the firmware as Intel HEX like the AVR builds. Keep the tag in
 * sync with that Dockerfile (decision 0003, C1 / C9). Round 6 (decision 0004, R7): built FROM the
 * libs3 runner, so RP2040 sketches get the same pinned libraries as AVR ones. Older tags stay
 * buildable: set FABWRIGHT_ARDUINO_IMAGE / FABWRIGHT_RUNNER_IMAGE / FABWRIGHT_PICO_IMAGE.
 */
export const PICO_IMAGE = process.env.FABWRIGHT_PICO_IMAGE ?? "fabwright/arduino-pico:6.3.1-libs3-r1";

/**
 * ESP32-family image (toolchains/arduino-esp32, decision 0006): the runner image + Espressif's
 * arduino-esp32 core 3.3.12 (ESP-IDF 5.5) + FabwrightEth. Builds write a merged flash image
 * (<sketch>.ino.merged.bin) that the QEMU backend boots. About 6.5 GB: built on the first ESP build.
 */
export const ESP32_IMAGE = process.env.FABWRIGHT_ESP32_IMAGE ?? "fabwright/arduino-esp32:3.3.12-r3";
/**
 * The image r3 is built on (toolchains/arduino-esp32/Dockerfile): arduino-cli + the esp32 core +
 * FabwrightEth. r3 (Dockerfile.sim, round 10 network) adds the simulation shim (FabwrightSim) and pinned
 * network libraries; device builds (target "device") turn the shim off with FABWRIGHT_SIM=0.
 */
export const ESP32_BASE_IMAGE = process.env.FABWRIGHT_ESP32_BASE_IMAGE ?? "fabwright/arduino-esp32:3.3.12-r2";

/**
 * Round 10 (Renode boards). STM32duino 2.11.0 (toolchains/arduino-stm32): linux/amd64 only (STM32Tools
 * has no aarch64 build), so on Apple silicon it runs emulated: about 14 s for a small sketch, 40 s with
 * display libraries. arduino:mbed_nano 4.4.1 (toolchains/arduino-mbed-nano) and Seeed's nRF52 core
 * 1.1.13 (toolchains/arduino-nrf52) are native arm64. All carry the libs3 libraries.
 */
export const STM32_IMAGE = process.env.FABWRIGHT_STM32_IMAGE ?? "fabwright/arduino-stm32:2.11.0-libs3-r1";
export const MBED_NANO_IMAGE = process.env.FABWRIGHT_MBED_NANO_IMAGE ?? "fabwright/arduino-mbed-nano:4.4.1-libs3-r1";
export const NRF52_IMAGE = process.env.FABWRIGHT_NRF52_IMAGE ?? "fabwright/arduino-nrf52:1.1.13-libs3-r2";

export interface Platform {
  prefix: string;
  image: () => string;
  examples: readonly string[];
  /** Folder (under toolchains/) whose Dockerfile builds the image, for "image missing" errors. */
  dockerfile: string;
  /** Extra `docker build` / `docker run` platform (amd64-only images). */
  dockerPlatform?: string;
  /**
   * The simulator build of a board whose `Serial` is USB CDC (not emulated): a header force-included
   * in every C++ file so Serial prints on the hardware UART the simulator reads.
   */
  simSerialHeader?: string;
  /**
   * Lines put in front of the main .ino of the simulator build (then `#line 1`, so diagnostics keep
   * the person's line numbers), for cores where a header in every file would break the core itself.
   */
  simSketchPrelude?: string;
  /** The image writes <sketch>.ino.sim.hex (the whole flash the simulator loads), use it over <sketch>.ino.hex. */
  simHex?: boolean;
}

/** arduino-cli platforms the images carry, by FQBN prefix. */
export const PLATFORMS: readonly Platform[] = [
  { prefix: "arduino:avr:", image: () => RUNNER_IMAGE, examples: ["arduino:avr:uno", "arduino:avr:nano"], dockerfile: "services/runner/docker" },
  { prefix: "rp2040:rp2040:", image: () => PICO_IMAGE, examples: ["rp2040:rp2040:rpipico", "rp2040:rp2040:seeed_xiao_rp2040", "rp2040:rp2040:waveshare_rp2040_zero"], dockerfile: "toolchains/arduino-pico" },
  {
    prefix: "STMicroelectronics:stm32:",
    image: () => STM32_IMAGE,
    examples: ["STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8", "STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F411CE", "STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE"],
    dockerfile: "toolchains/arduino-stm32",
    dockerPlatform: "linux/amd64",
  },
  {
    prefix: "arduino:mbed_nano:",
    image: () => MBED_NANO_IMAGE,
    examples: ["arduino:mbed_nano:nano33ble"],
    dockerfile: "toolchains/arduino-mbed-nano",
    simSerialHeader: "#pragma once\n#ifdef __cplusplus\n#include <Arduino.h>\n#undef Serial\n#define Serial _UART1_\n#endif\n",
  },
  {
    prefix: "Seeeduino:nrf52:",
    image: () => NRF52_IMAGE,
    examples: ["Seeeduino:nrf52:xiaonRF52840"],
    dockerfile: "toolchains/arduino-nrf52",
    simHex: true,
    // Serial is TinyUSB's USB CDC object here (the core needs Adafruit_TinyUSB.h in the sketch to link
    // it); the simulator build prints Serial on Serial1 (UARTE0) instead.
    simSketchPrelude: "#include <Adafruit_TinyUSB.h>\n#define Serial Serial1\n",
  },
  {
    prefix: "esp32:esp32:",
    image: () => ESP32_IMAGE,
    examples: ["esp32:esp32:esp32", "esp32:esp32:esp32s3", "esp32:esp32:XIAO_ESP32S3", "esp32:esp32:XIAO_ESP32C3", "esp32:esp32:nologo_esp32c3_super_mini"],
    dockerfile: "toolchains/arduino-esp32",
  },
];

export function platformFor(fqbn: string): Platform {
  return PLATFORMS.find((p) => fqbn.startsWith(p.prefix)) ?? PLATFORMS[0]!;
}

/** What a build writes: Intel HEX text (AVR, RP2040) or a merged flash image (ESP32 family). */
export function outputFormatFor(fqbn: string): "hex" | "bin" {
  return fqbn.startsWith("esp32:esp32:") ? "bin" : "hex";
}

/** The Docker image that builds a FQBN (the AVR runner image for anything it does not know). */
export function imageFor(fqbn: string): string {
  return platformFor(fqbn).image();
}

/** "arduino:avr:uno", "rp2040:rp2040:rpipico", … for error messages. */
export const SUPPORTED_FQBNS: readonly string[] = PLATFORMS.flatMap((p) => p.examples);

export const BASE_DOCKERFILE_DIR = join(REPO_ROOT, "toolchains/arduino");
export const PICO_DOCKERFILE_DIR = join(REPO_ROOT, "toolchains/arduino-pico");
export const RUNNER_DOCKERFILE_DIR = join(REPO_ROOT, "services/runner/docker");
export const ESP32_DOCKERFILE_DIR = join(REPO_ROOT, "toolchains/arduino-esp32");
export const QEMU_ESP_DOCKERFILE_DIR = join(REPO_ROOT, "toolchains/qemu-esp");

export const DEFAULT_PORT = 7781;

/** Where builds, cached hex files and extra libraries live. Override with FABWRIGHT_CACHE_DIR. */
export function cacheDir(): string {
  return process.env.FABWRIGHT_CACHE_DIR ?? join(homedir(), ".cache", "fabwright");
}

/**
 * Pinned library versions. "Adafruit SSD1306" without a version resolves to the version here.
 * `preinstalled` ones are baked into the runner image; others are installed on first use into the cache.
 * `deps` are added automatically (pinned too) so a sketch only has to name the library it includes.
 */
export const PINNED_LIBRARIES: Record<string, { version: string; preinstalled: boolean; license: string; deps?: string[]; headers: string[]; /** Preinstalled only in these build images (FQBN prefixes); installed into the cache elsewhere. */ only?: string[] }> = {
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
  "Adafruit ILI9341": { version: "1.7.0", preinstalled: true, license: "MIT / BSD (see toolchains/arduino/LIBRARIES.md)", deps: ["Adafruit GFX Library", "Adafruit BusIO"], headers: ["Adafruit_ILI9341.h"] },
  "Adafruit ST7735 and ST7789 Library": { version: "1.12.0", preinstalled: true, license: "MIT", deps: ["Adafruit GFX Library", "Adafruit BusIO"], headers: ["Adafruit_ST7735.h", "Adafruit_ST7789.h", "Adafruit_ST77xx.h"] },
  // libs3 (round 6, decision 0004 R7): the libraries agents reach for on round screens, LED strips and DHT sensors.
  "Adafruit GC9A01A": { version: "1.2.0", preinstalled: true, license: "MIT / BSD (see toolchains/arduino/LIBRARIES.md)", deps: ["Adafruit GFX Library", "Adafruit BusIO"], headers: ["Adafruit_GC9A01A.h"] },
  "DHT sensor library": { version: "1.4.7", preinstalled: true, license: "MIT", deps: ["Adafruit Unified Sensor"], headers: ["DHT.h", "DHT_U.h"] },
  FastLED: { version: "3.10.8", preinstalled: true, license: "MIT", headers: ["FastLED.h"] },
  TFT_eSPI: { version: "2.5.43", preinstalled: true, license: "FreeBSD (BSD-2-Clause) + Adafruit BSD / MIT parts (see toolchains/arduino/LIBRARIES.md)", headers: ["TFT_eSPI.h"] },
  "Adafruit NeoPixel": { version: "1.15.5", preinstalled: true, license: "LGPL-3.0 (compiled into your firmware: shipping that binary carries LGPL-3.0 duties, see toolchains/arduino/LIBRARIES.md)", headers: ["Adafruit_NeoPixel.h"] },
  // Round 11: the network libraries of the ESP32 simulation image (toolchains/arduino-esp32/Dockerfile.sim);
  // pinned so firmware.libraries "PubSubClient" builds the image's version, not the newest one.
  PubSubClient: { version: "2.8.0", preinstalled: true, only: ["esp32:esp32:"], license: "MIT", headers: ["PubSubClient.h"] },
  MQTT: { version: "2.5.3", preinstalled: true, only: ["esp32:esp32:"], license: "MIT", headers: ["MQTT.h", "MQTTClient.h"] },
  ArduinoJson: { version: "7.4.3", preinstalled: true, only: ["esp32:esp32:"], license: "MIT", headers: ["ArduinoJson.h"] },
  WebSockets: { version: "2.7.2", preinstalled: true, only: ["esp32:esp32:"], license: "LGPL-2.1 (a build input of your firmware, see NOTICE)", headers: ["WebSocketsClient.h", "WebSocketsServer.h"] },
  NewPing: { version: "1.9.7", preinstalled: false, license: "GPL-3.0 (copyleft: your firmware becomes GPL if you ship it)", headers: ["NewPing.h"] },
};

/** Headers that come with the Arduino AVR core (no library to declare). */
export const CORE_HEADERS = ["Arduino.h", "Wire.h", "SPI.h", "EEPROM.h", "SoftwareSerial.h", "avr/pgmspace.h", "avr/io.h", "avr/interrupt.h", "util/delay.h"];

/** Headers that come with arduino-pico (RP2040 boards), on top of the Arduino API ones. */
export const PICO_CORE_HEADERS = ["Arduino.h", "Wire.h", "SPI.h", "EEPROM.h", "SoftwareSerial.h", "Servo.h", "LittleFS.h", "hardware/gpio.h", "hardware/pwm.h", "hardware/adc.h", "hardware/pio.h", "pico/stdlib.h"];

/** header file name → library name, for "No such file" hints. */
export function libraryForHeader(header: string): string | undefined {
  for (const [name, info] of Object.entries(PINNED_LIBRARIES)) if (info.headers.includes(header)) return name;
  return undefined;
}
