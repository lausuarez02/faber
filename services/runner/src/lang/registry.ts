// Firmware languages as data: for every language, which chip families it builds for, with which
// toolchain, and which image format it hands the emulator. The support matrix in
// docs/firmware-languages.md is this table; tests keep the two honest (a "verified" entry names
// the test that proves it).
import type { FirmwareLanguage } from "@jumper/project-format";

/** Chip families Jumper's backends know (part.json mcu.chip). */
export const CHIPS = ["atmega328p", "rp2040", "esp32", "esp32s3", "esp32c3", "stm32f103", "stm32f4", "nrf52840"] as const;
export type Chip = (typeof CHIPS)[number];

/** What the build hands the emulator. */
export type ImageFormat = "ihex" | "esp-flash" | "elf";

/** The emulator image format each chip's backend loads. */
export const CHIP_IMAGE: Record<Chip, { backend: string; format: ImageFormat }> = {
  atmega328p: { backend: "avr8js", format: "ihex" },
  rp2040: { backend: "rp2040js", format: "ihex" },
  esp32: { backend: "qemu-esp", format: "esp-flash" },
  esp32s3: { backend: "qemu-esp", format: "esp-flash" },
  esp32c3: { backend: "qemu-esp", format: "esp-flash" },
  stm32f103: { backend: "renode", format: "elf" },
  stm32f4: { backend: "renode", format: "elf" },
  nrf52840: { backend: "renode", format: "elf" },
};

export interface LanguageSupport {
  status: "verified" | "planned";
  /** verified: the test file that proves blink (and the listed buses) on this chip. */
  test?: string;
  /** planned: why not yet, in plain words. */
  why?: string;
  /** Docker image (pinned) or "in-process" (no Docker needed). */
  toolchain?: string;
}

export interface LanguageInfo {
  id: FirmwareLanguage;
  label: string;
  /** Main file a new project gets, relative to firmware/. */
  mainFile: string;
  /** Source files that belong to the build (hashing, the editor's file tree). */
  sourceExt: RegExp;
  /** Editor mode for each file kind. */
  editor: "cpp" | "python" | "rust";
  /** Build tool written into firmware.build.tool. */
  tool: "arduino-cli" | "micropython" | "esp-idf" | "platformio" | "cargo" | "west";
  /** Runtime errors this language prints on the console, mapped to file:line (see runtimeErrors). */
  chips: Partial<Record<Chip, LanguageSupport>>;
}

const RENODE_SERIAL_IN = "the Renode backend has no serial input yet (ExternalControl has no UART write in 1.17), so a REPL cannot be driven";

export const LANGUAGES: Record<FirmwareLanguage, LanguageInfo> = {
  arduino: {
    id: "arduino",
    label: "Arduino (C++)",
    mainFile: "main.ino",
    sourceExt: /\.(ino|pde|h|hpp|hh|c|cc|cpp|cxx|S|s)$/,
    editor: "cpp",
    tool: "arduino-cli",
    chips: {
      atmega328p: { status: "verified", test: "packages/parts/src/blink.integration.test.ts", toolchain: "jumper/arduino-runner:1.5.1-avr1.8.8-libs3-r1" },
      rp2040: { status: "verified", test: "packages/parts/src/rp2040.integration.test.ts", toolchain: "jumper/arduino-pico:6.3.1-libs3-r1" },
      esp32: { status: "verified", test: "packages/sim-backends/src/qemu-esp/qemu-esp.integration.test.ts", toolchain: "jumper/arduino-esp32:3.3.12-r2" },
      esp32s3: { status: "planned", why: "boots in the round 9 spike, but no I2C controller model in QEMU and no board part yet", toolchain: "jumper/arduino-esp32:3.3.12-r2" },
      esp32c3: { status: "verified", test: "packages/sim-backends/src/qemu-esp/qemu-esp.integration.test.ts", toolchain: "jumper/arduino-esp32:3.3.12-r2" },
      stm32f103: { status: "verified", test: "packages/sim-backends/src/renode/renode.integration.test.ts", toolchain: "jumper/arduino-stm32:2.11.0-r1" },
      stm32f4: { status: "planned", why: "no STM32F4 board part or fixture yet" },
      nrf52840: { status: "verified", test: "packages/sim-backends/src/renode/renode.integration.test.ts", toolchain: "jumper/arduino-mbed-nano:4.4.1-r1" },
    },
  },
  micropython: {
    id: "micropython",
    label: "MicroPython",
    mainFile: "main.py",
    sourceExt: /\.py$/,
    editor: "python",
    tool: "micropython",
    chips: {
      rp2040: { status: "verified", test: "services/runner/src/lang/micropython.integration.test.ts", toolchain: "in-process (official MicroPython UF2 + littlefs image)" },
      esp32: { status: "verified", test: "services/runner/src/lang/micropython-esp.integration.test.ts", toolchain: "in-process image, runs in jumper/qemu-esp" },
      esp32c3: { status: "verified", test: "services/runner/src/lang/micropython-esp.integration.test.ts", toolchain: "in-process image, runs in jumper/qemu-esp" },
      esp32s3: { status: "planned", why: "the official ESP32_GENERIC_S3 build stops after 'Failed to set QIE bit' in QEMU (its REPL is on USB-OTG, which QEMU does not model); needs a UART-REPL build" },
      stm32f4: { status: "planned", why: "the official STM32F4DISC build boots in Renode but its REPL is USB-only (no UART output); needs a UART-REPL build, and " + RENODE_SERIAL_IN },
      nrf52840: { status: "planned", why: "the official ARDUINO_NANO_33_BLE_SENSE build is linked after the Arduino bootloader and SoftDevice (loads at 0x26000) and prints nothing in Renode; needs a bare build, and " + RENODE_SERIAL_IN },
      stm32f103: { status: "planned", why: "MicroPython has no STM32F1 port" },
      atmega328p: { status: "planned", why: "MicroPython does not run on 8-bit AVR (2 KB RAM)" },
    },
  },
  "esp-idf": {
    id: "esp-idf",
    label: "ESP-IDF (C)",
    mainFile: "main/main.c",
    sourceExt: /\.(c|h|cpp|hpp|cc|S|txt|cmake|csv|defaults|projbuild)$|(^|\/)(CMakeLists\.txt|sdkconfig\.defaults|Kconfig\.projbuild|partitions\.csv|idf_component\.yml)$/,
    editor: "cpp",
    tool: "esp-idf",
    chips: {
      esp32: { status: "verified", test: "services/runner/src/lang/espidf.integration.test.ts", toolchain: "jumper/esp-idf:5.5.5-r1" },
      esp32c3: { status: "verified", test: "services/runner/src/lang/espidf.integration.test.ts", toolchain: "jumper/esp-idf:5.5.5-r1" },
      esp32s3: { status: "planned", why: "builds; no I2C controller model in QEMU for the S3 yet, and no board part", toolchain: "jumper/esp-idf:5.5.5-r1" },
    },
  },
  platformio: {
    id: "platformio",
    label: "PlatformIO",
    mainFile: "platformio.ini",
    sourceExt: /\.(ino|h|hpp|c|cc|cpp|S|ini)$/,
    editor: "cpp",
    tool: "platformio",
    chips: {
      atmega328p: { status: "verified", test: "services/runner/src/lang/platformio.integration.test.ts", toolchain: "jumper/platformio:6.2.0-avr5.3.0-r1" },
      rp2040: { status: "planned", why: "the official raspberrypi platform builds with Arduino-Mbed, whose USB serial and boot differ from arduino-pico; the arduino-pico platform is a third-party fork. Use Arduino (arduino-pico) or MicroPython on RP2040 for now" },
      esp32: { status: "planned", why: "platform espressif32 adds about 1.5 GB per image; Arduino and ESP-IDF already cover the ESP32 with the same core" },
      stm32f103: { status: "planned", why: "platform ststm32 is amd64-only for some toolchains; Arduino (STM32duino) covers the Blue Pill" },
      nrf52840: { status: "planned", why: "the nordicnrf52 platform's Arduino framework for the Nano 33 BLE is Mbed, already covered by Arduino" },
    },
  },
  rust: {
    id: "rust",
    label: "Rust",
    mainFile: "src/main.rs",
    sourceExt: /\.(rs|toml)$/,
    editor: "rust",
    tool: "cargo",
    chips: {
      rp2040: { status: "planned", why: "rp-hal / embassy-rp build to an ELF that converts to the same hex; not built yet (toolchain image to add)" },
      esp32c3: { status: "planned", why: "esp-hal with espflash save-image --merge runs on the same QEMU backend; not built yet" },
    },
  },
  zephyr: {
    id: "zephyr",
    label: "Zephyr (C)",
    mainFile: "src/main.c",
    sourceExt: /\.(c|h|conf|overlay|txt|yaml)$/,
    editor: "cpp",
    tool: "west",
    chips: {
      nrf52840: { status: "planned", why: "west build -b nrf52840dk/nrf52840 gives an ELF Renode loads; the Zephyr SDK image is several GB and was not built this round" },
    },
  },
};

export function languageInfo(lang: FirmwareLanguage): LanguageInfo {
  return LANGUAGES[lang];
}

export function isChip(s: string | undefined): s is Chip {
  return !!s && (CHIPS as readonly string[]).includes(s);
}

/** Support of `lang` on `chip`, or a "planned" entry that says nobody has tried it. */
export function supportOf(lang: FirmwareLanguage, chip: string): LanguageSupport {
  const s = isChip(chip) ? LANGUAGES[lang].chips[chip] : undefined;
  return s ?? { status: "planned", why: `${LANGUAGES[lang].label} on ${chip} has not been tried in Jumper yet` };
}

/** Languages verified on a chip, Arduino first: what plan_device and the editor offer. */
export function languagesFor(chip: string): FirmwareLanguage[] {
  return (Object.keys(LANGUAGES) as FirmwareLanguage[]).filter((l) => supportOf(l, chip).status === "verified");
}
