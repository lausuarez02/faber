# Firmware languages

Round 10. A project's firmware can be written in more than Arduino C++. Every language is the same
general mechanism, not a feature per language:

1. **`firmware.language`** in `fabwright.json` (`arduino` by default, so every older project means what
   it meant). The `set_firmware` tool (CLI `fabwright firmware <language>`) sets it with the main file,
   build tool and artifact, and writes a starter file.
2. **A toolchain per language per chip family**, as data in
   [`services/runner/src/lang/registry.ts`](../services/runner/src/lang/registry.ts): a pinned Docker
   image, or an in-process build (MicroPython needs no compiler).
3. **One output rule per chip**: the build ends as the image that chip's emulator loads. AVR and
   RP2040 load Intel HEX (the RP2040 hex spans the 2 MB flash window), the ESP32 family a merged
   flash image padded to the flash size, Renode boards an ELF. The emulator backends do not know
   which language built the image.
4. **Errors at file:line** in every language: compiler output (gcc for Arduino, ESP-IDF, PlatformIO),
   MicroPython syntax errors from `mpy-cross` at build time, and MicroPython tracebacks at run time
   (`run` returns `errors: ["firmware/util.py:2: ZeroDivisionError: divide by zero"]`; the code
   editor marks the line).

## Support matrix

"Verified" means a test in the repo boots real firmware built that way on Fabwright's emulator and
checks blink (GPIO) and the listed bus; the test is named. Everything else is "planned", with the
reason. The table is generated from the registry by hand; `services/runner/src/lang/lang.test.ts`
fails if a verified entry names a test file that does not exist.

| Language | ATmega328P (Uno, Nano) | RP2040 (Pico, XIAO RP2040, RP2040-Zero) | ESP32 | ESP32-C3 | ESP32-S3 | STM32F103 (Blue Pill) | STM32F4 | nRF52840 (Nano 33 BLE) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Arduino | verified | verified | verified (board fixtures) | verified (board fixtures) | verified (board fixtures) | verified (board fixtures) | verified (Black Pill F411) | verified (board fixtures) |
| MicroPython | no (2 KB RAM) | **verified** (blink, I2C, REPL, e2e) | **verified** (main.py, GPIO, I2C0, PWM, IRQ, UART1, ADC, REPL) | **verified** (same) | planned | no port | planned | planned |
| ESP-IDF (C) | n/a | n/a | planned (image built) | planned (image built) | planned | n/a | n/a | n/a |
| PlatformIO | planned (image built) | planned | planned | n/a | n/a | planned | n/a | planned |
| Rust | | planned | | planned | | | | |
| Zephyr | | | | | | | | planned |

The ESP32, C3, S3, STM32 and nRF52840 columns run through the process backends (Espressif QEMU,
Renode) that `fabwright serve` starts; their boards are in the parts library, and what each one emulates
is in [boards.md](boards.md). Round 10 integration: Arduino is verified by each board's fixture test
(`qemu-esp/boards.integration.test.ts`, `renode/boards.integration.test.ts`).

- **MicroPython on ESP32 / ESP32-C3** (verified, round 10 integration): the official `ESP32_GENERIC` and
  `ESP32_GENERIC_C3` 1.29.0 builds ship only nvs / phy_init / factory partitions and add `vfs` at first
  boot over the rest of the flash, so Fabwright writes the littlefs image right after the last partition.
  `micropython-esp.integration.test.ts` boots main.py from it (GPIO, I2C0 on both chips, the REPL);
  `esp-peripherals.integration.test.ts` drives PWM, a pin interrupt, UART1 and the ADC (raw: QEMU's
  eFuse has no calibration, so `read_uv` raises) and records SPI as a known gap.
- **MicroPython on ESP32-S3**: the official build stops after `Failed to set QIE bit` in QEMU, with or
  without emulated PSRAM (`psramMB` option added to the backend); its REPL is on USB-OTG, which QEMU
  does not model. Needs a UART-REPL build (the ESP-IDF image can build MicroPython from source).
- **MicroPython on STM32F4 (Renode)**: the official `STM32F4DISC` build boots in Renode (it reaches
  its idle `wfi` after the clock and backup-regulator setup) but prints nothing: its REPL is USB only.
  Needs a build with `MICROPY_HW_UART_REPL`, and the Renode backend has no serial input yet.
- **MicroPython on nRF52840 (Renode)**: the official `ARDUINO_NANO_33_BLE_SENSE` build is linked to
  start at 0x26000 after the Arduino bootloader and SoftDevice, and prints nothing alone in Renode.
- **ESP-IDF**: `fabwright/esp-idf:5.5.5-r1` built: ESP-IDF v5.5.5 on top of the arduino-esp32 image,
  which ships exactly the compilers v5.5.5 pins (`esp-14.2.0_20260121`), so it adds only the sources
  and IDF's Python environment. No project build ran (Docker failed, above); the test
  (`espidf.integration.test.ts`: blink + console on ESP32 and C3, an I2C write to 0x3C on the ESP32,
  a typo at file:line) is written.
- **PlatformIO**: `fabwright/platformio:6.2.0-avr5.3.0-r1` built and compiled an Uno blink during its
  own image build (offline packages baked in). Fabwright's build path and the run on avr8js
  (`platformio.integration.test.ts`: blink, serial, Wire to 0x3C, an error at `src/main.cpp:2`) are
  written but did not run (Docker). Other platforms are refused up front with the reason, before any
  download: espressif32 alone is about 1.5 GB per image, and Arduino / ESP-IDF already cover those chips.
- **Rust, Zephyr**: no toolchain image yet. `set_firmware` refuses them with that reason.

## MicroPython

No compile step. A build:

1. checks every `.py` in `firmware/` with MicroPython's own compiler (`mpy-cross`, WebAssembly, in
   process) and reports `SyntaxError` / `IndentationError` at file:line;
2. takes the pinned official firmware for the board (`RPI_PICO` 1.29.0 is shipped in
   `toolchains/micropython/firmware/`, the others are downloaded from micropython.org once and checked
   against a pinned SHA-256; `fabwright setup micropython` fetches them ahead of time);
3. writes a littlefs filesystem (littlefs itself, compiled to WebAssembly) with the files at the
   address that firmware mounts: the last 1408 KB of the RP2040's flash (352 blocks, checked with
   `os.statvfs` in the test), the `vfs` partition on the ESP32 family;
4. returns the whole flash as Intel HEX (RP2040) or a padded flash image (ESP32).

MicroPython then boots, runs `boot.py` and `main.py`, and waits at its REPL on the console. The Serial
panel is that console: it shows `print()` output, and the line under it sends text to the board (Enter
runs a REPL line; Ctrl-C with an empty line stops `main.py`). Agents use `run {"serial_write": "…"}`.
`machine.Pin`, `I2C`, `SPI`, `PWM` and `ADC` reach the same emulated peripherals as Arduino code; the
backend facts in each board's `fidelity.json` apply unchanged.

What differs from a real board, stated:

- **RP2040 console launcher.** MicroPython starts USB only after `boot.py`, and the emulated computer
  opens the port about 13 ms later; text printed before that waits in MicroPython's USB buffer until
  the next print (a real Pico does the same, which is why Thonny and mpremote reset the board after
  connecting). So that an always-open terminal sees everything, the device's `main.py` is a 3-line
  launcher that waits 40 ms and runs the project's `main.py` (stored as `fabwright_main.py`) under the
  name `main.py` in the REPL's globals. Tracebacks show one extra `main.py` frame; the build output
  says the launcher is there.
- **Files at the root only.** The littlefs build exports no `mkdir`, so folders under `firmware/` are
  not copied (the build warns, with the fix: put modules next to `main.py`).
- **Syntax check version.** `mpy-cross` is MicroPython 1.19's (the newest WebAssembly build); runtime
  errors come from the real 1.29.0 firmware.
- **RP2040 output pins read back their level.** Fixed in the RP2040 backend this round (it is what the
  chip does): `Pin.value()` / `toggle()` and `digitalRead()` of an output now return the driven level.

Templates: `pico-micropython` (blink on the on-board LED, a passing scenario) and
`pico-micropython-oled` (SSD1306 on I2C0 GP4 / GP5 with a small original `ssd1306.py` on top of
`framebuf`).

## ESP-IDF

`firmware/CMakeLists.txt` + `firmware/main/CMakeLists.txt` + `firmware/main/main.c` (what
`set_firmware {"language": "esp-idf"}` writes). The runner copies `firmware/` into
`fabwright/esp-idf:5.5.5-r1` and runs `idf.py build` with `IDF_TARGET` = the board's chip and a
`sdkconfig` overlay for DIO flash of the right size (QEMU boots DIO; the project's own
`sdkconfig.defaults` is applied first), then `esptool merge_bin --fill-flash-size`. The container has
no network (`IDF_COMPONENT_MANAGER=0`), so builds are reproducible; managed components are planned.
Compiler and CMake errors map to `firmware/<path>:<line>`. Output: `firmware/main.bin`.

## PlatformIO

`firmware/platformio.ini` + `firmware/src/main.cpp`. `pio run -e <env>` in
`fabwright/platformio:6.2.0-avr5.3.0-r1` (the first env, or `firmware.build.env`). The image carries
the atmelavr platform with its packages; `lib_deps` download on first use into
`~/.cache/fabwright/platformio`. The env's platform is checked before Docker runs: a platform the image
does not carry is refused with the reason and what to use instead. Output: `firmware.hex` for avr8js.

## Adding a language or a chip

1. A toolchain: a Dockerfile under `toolchains/<name>/` with pinned versions and a wrapper that
   writes its outputs to `/work/out` (see `toolchains/esp-idf/fabwright-esp-idf.sh`), or an in-process
   builder; a `ToolchainImage` entry in `services/runner/src/lang/toolchain.ts`.
2. A `build-<language>.ts` in `services/runner/src/lang/` that maps its errors to file:line and
   returns the chip's image format (`CHIP_IMAGE`).
3. The registry entry per chip, `planned` with the reason until a test proves it; then `verified`
   with the test's path. `docs/firmware-languages.md` (this table) and NOTICE follow.
4. A starter in `packages/session/src/starters.ts` so `set_firmware` can create a project.

## Commands

```
fabwright firmware micropython -p my-device      # set_firmware
fabwright setup list                             # what runs where
fabwright setup micropython | esp-idf | platformio
fabwright new my-pico --template pico-micropython
```
