# Bus fixtures: golden firmware for the TWI and SPI tests

`src/twi.test.ts` runs these real compiled sketches on the avr8js backend. The `.hex` files are
committed golden builds; rebuild them only on purpose.

| Sketch | Hex | What it does |
| --- | --- | --- |
| `i2c_probe/i2c_probe.ino` | `i2c_probe.hex` | I2C scanner (prints `found 0xNN`, `scan done N`), then every 20 ms writes `00 AF` to 0x3C and reads one byte, printing `tx <endTransmission result> rx <count> <byte>` |
| `spi_probe/spi_probe.ino` | `spi_probe.hex` | Every 20 ms: CS (D10) low, sends `9F 00 00`, prints the three bytes received |

Build (Docker, toolchain image with the pinned core):

```sh
export FABWRIGHT_ARDUINO_IMAGE=fabwright/arduino-cli:1.5.1-avr1.8.8-libs1
for s in i2c_probe spi_probe; do
  scripts/build-firmware.sh packages/sim-backends/fixtures/$s arduino:avr:uno packages/sim-backends/fixtures/$s/build
  cp packages/sim-backends/fixtures/$s/build/$s.ino.hex packages/sim-backends/fixtures/$s.hex
  rm -rf packages/sim-backends/fixtures/$s/build
done
```

Toolchain: arduino-cli 1.5.1, `arduino:avr` 1.8.8 (avr-gcc 7.3.0), FQBN `arduino:avr:uno`. Both
sketches use only the core (`Wire`, `SPI`), so the library set of the image does not matter.

sha256 (first 16 hex digits): `i2c_probe.hex` 4c06f619f6b1cf72, `spi_probe.hex` df5ed51b53c35162.

## RP2040 fixtures (arduino-pico)

`src/rp2040/*.test.ts` and `packages/parts/src/rp2040.integration.test.ts` run these on the
rp2040js backend. Golden builds, committed; rebuild only on purpose.

| Sketch | Hex | Board (FQBN) | What it does |
| --- | --- | --- | --- |
| `xiao_blink/xiao_blink.ino` | `xiao_blink.hex` | Seeed XIAO RP2040 (`rp2040:rp2040:seeed_xiao_rp2040`) | D0 (GP26) and the user LED (GP17, active low) blink 500 ms on / off; USB serial prints `LED on <n>` / `LED off <millis>` |
| `xiao_oled/xiao_oled.ino` | `xiao_oled.hex` | Seeed XIAO RP2040 | Adafruit SSD1306 128x64 at 0x3C on Wire (I2C1, D4/D5): title, frame counter and a bar of `64 + 20·sinf(frame/4)` px, every 250 ms |
| `xiao_io_probe/xiao_io_probe.ino` | `xiao_io_probe.hex` | Seeed XIAO RP2040 | Button on D0 (INPUT_PULLUP), `analogWrite(D1, 64)`, `analogRead(A2)`, Serial1 at 115200 sends `AT` and echoes lines as `rx …`, one SPI transfer `9F 00 00` with CS on D3, every 100 ms |
| `pico_gadget/pico_gadget.ino` | `pico_gadget.hex` | Raspberry Pi Pico (`rp2040:rp2040:rpipico`) | ST7735 TFT on SPI0 (GP17-GP21), Adafruit MPU6050 on Wire (GP4/GP5), button on GP14, `tone(15, 1000)` while pressed |

Build (Docker, the pinned arduino-pico image; the wrapper writes `<sketch>.ino.hex` from the ELF):

```sh
# once: the base, runner and RP2040 images (see packages/parts/fixtures/libs3/BUILD.md)
export FABWRIGHT_ARDUINO_IMAGE=fabwright/arduino-pico:6.3.1-libs3-r1
for s in xiao_blink xiao_oled xiao_io_probe; do
  scripts/build-firmware.sh packages/sim-backends/fixtures/$s rp2040:rp2040:seeed_xiao_rp2040 packages/sim-backends/fixtures/$s/build
  cp packages/sim-backends/fixtures/$s/build/$s.ino.hex packages/sim-backends/fixtures/$s.hex
  rm -rf packages/sim-backends/fixtures/$s/build
done
scripts/build-firmware.sh packages/sim-backends/fixtures/pico_gadget rp2040:rp2040:rpipico packages/sim-backends/fixtures/pico_gadget/build
cp packages/sim-backends/fixtures/pico_gadget/build/pico_gadget.ino.hex packages/sim-backends/fixtures/pico_gadget.hex
rm -rf packages/sim-backends/fixtures/pico_gadget/build
```

Toolchain: arduino-cli 1.5.1, `rp2040:rp2040` 6.3.1 (pqt-gcc 5.0.0-9576866, GCC 14), default board
options (the CPU speed menu at its default), the library versions of
`toolchains/arduino/LIBRARIES.md`. The builds are reproducible: `services/runner/test/runner.test.ts`
rebuilds `xiao_blink` through the runner and compares it byte for byte.

Rebuilt byte-identical with the libs3 images (`fabwright/arduino-pico:6.3.1-libs3-r1`) on 2026-11-10;
the older `fabwright/arduino-pico:6.3.1-r1` gives the same bytes.

sha256 (first 16 hex digits): `xiao_blink.hex` 5d16935da7297f1d, `xiao_oled.hex` 55f2cf778673ecc6,
`xiao_io_probe.hex` 7f363c27bb871337, `pico_gadget.hex` b19abe7a89b90c64.

## ESP32-family fixtures (arduino-esp32, run in Espressif's QEMU)

`src/qemu-esp/qemu-esp.integration.test.ts` boots these in the `fabwright/qemu-esp` image
(toolchains/qemu-esp). They are merged 4 MB flash images (bootloader + partition table +
boot_app0 + app, as `esptool merge-bin` writes them), gzipped (the padding is 0xFF).

| Sketch | Image | Chip | What it does |
| --- | --- | --- | --- |
| `esp32_blink_io/esp32_blink_io.ino` | `esp32c3_blink_io.merged.bin.gz` | ESP32-C3 | Prints `hello from fabwright esp32`, toggles GPIO8 every 500 ms, mirrors GPIO4 to GPIO2 and prints `in4=<level>` |
| `esp32_i2c_probe/esp32_i2c_probe.ino` | `esp32_i2c_probe.merged.bin.gz` | ESP32 | I2C0 (SDA 21, SCL 22) scan, reads QEMU's built-in tmp105 at 0x48, writes `04 AA` to 0x3C, reads 4 bytes from register 2 |

```sh
docker build -t fabwright/arduino-esp32:3.3.12-r2 toolchains/arduino-esp32
F=packages/sim-backends/fixtures
docker run --rm -v $PWD/$F:/work fabwright/arduino-esp32:3.3.12-r2 compile \
  --fqbn esp32:esp32:esp32c3:FlashMode=dio --output-dir /work/build /work/esp32_blink_io
gzip -9 -n -c $F/build/esp32_blink_io.ino.merged.bin > $F/esp32c3_blink_io.merged.bin.gz
docker run --rm -v $PWD/$F:/work fabwright/arduino-esp32:3.3.12-r2 compile \
  --fqbn esp32:esp32:esp32:FlashMode=dio --output-dir /work/build2 /work/esp32_i2c_probe
gzip -9 -n -c $F/build2/esp32_i2c_probe.ino.merged.bin > $F/esp32_i2c_probe.merged.bin.gz
rm -rf $F/build $F/build2
```

Toolchain: arduino-cli 1.5.1, `esp32:esp32` 3.3.12 (ESP-IDF v5.5.5, esp-x32 / esp-rv32 2601,
esptool 5.3.1). sha256 (first 16 hex digits of the .gz): `esp32c3_blink_io.merged.bin.gz`
09de6aab95b741a7, `esp32_i2c_probe.merged.bin.gz` 0adda1611242ac3e.

## Renode fixtures (round 9)

`renode/bridge_bluepill.elf` (sketch `renode/bridge_stm32/`) and `renode/hello_nano33ble.elf`
(sketch `renode/hello_nano/`), debug info stripped, symbols kept (Renode finds the vector table
through them; a fully stripped Nano 33 BLE ELF, linked at 0x10000 behind the bootloader, faults):

    docker run --rm -v $PWD:/src fabwright/arduino-stm32:2.11.0-r1 compile \
      -b STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8 --output-dir /src/out /src/bridge_stm32
    docker run --rm -v $PWD:/src fabwright/arduino-mbed-nano:4.4.1-r1 arduino-cli compile \
      -b arduino:mbed_nano:nano33ble --output-dir /src/out /src/hello_nano
    arm-none-eabi-strip --strip-debug -o <name>.elf out/<sketch>.ino.elf

## ESP32-family board fixtures (round 10)

`src/qemu-esp/boards.integration.test.ts` boots these in Espressif's QEMU (`fabwright/qemu-esp:9.2.2-20260417-jb5`)
through the server-side factory with each board's `part.json` mcu block. They are the fixture tests
the boards' `mcu.verified` names: a board appears in the parts library only while its fixture passes.

| Sketch | Image | Board (simulator FQBN) | What it does |
| --- | --- | --- | --- |
| `esp-boards/<board>/sketch/sketch.ino` | `esp-boards/<board>.bin.gz` | the board's `mcu.toolchain.simFqbn` (+ `simBuildProperties`) | prints `boot <board>`; one GPIO toggles every 100 ms; another is INPUT_PULLUP and prints `in=<level> t=<ms>` on every change |

Pins: XIAO ESP32-S3 GPIO1 / GPIO2 (+ user LED GPIO21), XIAO ESP32-C3 GPIO3 / GPIO4, C3 SuperMini
GPIO10 / GPIO9 (+ LED GPIO8), DevKitC GPIO2 / GPIO4, S3 DevKitC-1 GPIO4 / GPIO5.

Build through Fabwright's own pipeline (`services/runner`, image `fabwright/arduino-esp32:3.3.12-r2`,
arduino-esp32 3.3.12):

```sh
node_modules/.bin/tsx packages/sim-backends/fixtures/esp-boards/build.ts
```

The `.bin.gz` files hold the merged flash image without its trailing 0xFF padding; the backend pads it
to the board's flash size (`mcu.flash.sizeMB`).

## Renode board fixtures (round 10)

`src/renode/boards.integration.test.ts` and `packages/parts/src/renode.integration.test.ts` boot
these on the Renode backend. Intel HEX, as every Fabwright build keeps firmware; the XIAO nRF52840 ones
are the simulator image (Nordic MBR + S140 SoftDevice 7.3.0 + the app, see docs/renode.md).

| Sketch | Files | What it does |
| --- | --- | --- |
| `renode/pinprobe/` | `renode/pinprobe-<board>.hex` (5 boards) | each listed pin (`pins.h`) HIGH for 2 ms as an output, then as inputs prints `in <bits>` every 10 ms |
| `renode/busprobe/` | `renode/busprobe-<board>.hex` (5 boards) | I2C scan of 0x46..0x49 and a register read from 0x48, SPI `9F 00`, analogRead, analogWrite 64, attachInterrupt FALLING count, Serial echo |
| `renode/oled_blackpill/` | `renode/oled_blackpill-stm32-blackpill-f411.hex` | Adafruit SSD1306 at 0x3C on Wire: title, frame counter, a bar; LED on PC13 |

Rebuild through Fabwright's own build pipeline (the runner's images, Serial redirection and sim.hex):

    node --import tsx scripts/build-renode-fixtures.ts [pinprobe|busprobe|oled_blackpill]

The committed files were built on 2026-11-11 with the same pinned cores and flags outside Docker
(Docker Desktop was failing on the build machine): arduino-cli 1.5.1 for macOS, STMicroelectronics:stm32
2.11.0, arduino:mbed_nano 4.4.1, Seeeduino:nrf52 1.1.13, Adafruit SSD1306 2.5.17 / GFX 1.13.0 /
BusIO 1.17.4, then toolchains/arduino-nrf52/fabwright-sim-hex.py for the XIAO. A Docker rebuild may
differ in bytes (paths in debug info, host compilers); the tests check behaviour, not bytes.
