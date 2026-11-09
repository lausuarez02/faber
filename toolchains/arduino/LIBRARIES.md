# Arduino libraries in the toolchain image

The image `jumper/arduino-cli:1.5.1-avr1.8.8-libs1` (built from `Dockerfile` in this folder)
ships these libraries, pinned, so sketches for Jumper's display, sensor and RTC parts build with
no network access and give the same bytes on every machine. Install is `--no-deps`: every
dependency is listed here explicitly.

They are **user-side** code: they are compiled into the firmware of the sketches that include
them, not into Jumper itself. A firmware image Jumper ships (for example
`examples/tamagotchi/firmware/tamagotchi.hex`) discloses the libraries linked into it in
`NOTICE`.

| Library (arduino-cli name) | Version | License | Used by | Notes |
| --- | --- | --- | --- | --- |
| Adafruit BusIO | 1.17.4 | MIT | GFX, SSD1306, BME280, MPU6050, RTClib | I2C/SPI helper classes |
| Adafruit GFX Library | 1.13.0 | BSD-2-Clause-style (Adafruit BSD) | SSD1306 | Drawing primitives and the classic 5x7 font |
| Adafruit SSD1306 | 2.5.17 | BSD (Adafruit) | `ssd1306-oled-i2c` | `display.begin(SSD1306_SWITCHCAPVCC, 0x3C)` |
| Adafruit Unified Sensor | 1.1.15 | Apache-2.0 | BME280, MPU6050 | `sensors_event_t` |
| Adafruit BME280 Library | 2.3.0 | BSD (Adafruit) | `bme280` | Default address 0x77; most modules are 0x76 |
| Adafruit MPU6050 | 2.2.9 | BSD (Adafruit) | `mpu6050` | |
| RTClib | 2.1.4 | MIT | `ds3231-rtc` | `RTC_DS3231` |
| LiquidCrystal_PCF8574 | 2.3.0 | BSD-3-Clause | `lcd1602-i2c` | `LiquidCrystal_PCF8574 lcd(0x27); lcd.begin(16, 2);` |
| LiquidCrystal_I2C | 1.1.2-jumper.1 | Apache-2.0 (Jumper) | `lcd1602-i2c` | Jumper's own clean-room implementation of the API, see below |
| MPU6050 (Electronic Cats) | 1.4.5 | MIT (I2Cdevlib, MIT) | `mpu6050` | The I2Cdevlib-style `MPU6050` class |
| U8g2 | 2.36.19 | BSD-2-Clause (code); fonts under their own licenses | `ssd1306-oled-i2c` | Font licenses are listed in the library's `LICENSE`; most are public domain, X11/MIT or OFL. Check before shipping a font in a product. |

Versions are the latest in the Arduino library index on 2026-11-09. Licenses were checked
against the `LICENSE`/`license.txt` file inside each installed library.

## Why there is a Jumper LiquidCrystal_I2C

Most Arduino tutorials (and most AI agents) write `#include <LiquidCrystal_I2C.h>` with
`LiquidCrystal_I2C lcd(0x27, 16, 2); lcd.init(); lcd.backlight();`. The library of that name in
the Arduino index (Frank de Brabander / johnrickman, 1.1.2) carries **no license**, so Jumper
cannot redistribute it. `libraries/LiquidCrystal_I2C/` is an original Apache-2.0 implementation
of the same API, written from the HD44780U and PCF8574 datasheets (P0 = RS, P1 = RW, P2 = EN,
P3 = backlight, P4-P7 = D4-D7), so those sketches build unchanged. `LiquidCrystal_PCF8574`
(BSD) is the alternative from the index.

Not included, on purpose: `hd44780` by Bill Perry (GPL-3.0).

## Changing the set

1. Edit the `lib install` list in `Dockerfile` (exact `Name@version`), keep `--no-deps`, and list
   every new dependency explicitly.
2. Bump the tag suffix (`-libs1` → `-libs2`) in the Dockerfile comment, in
   `scripts/build-firmware.sh` and in `build-part-examples.sh`.
3. Check the license of every new library (MIT, BSD, Apache-2.0, zlib are fine; no GPL, no
   "no license") and add a row here.
4. Rebuild: `docker build -t jumper/arduino-cli:1.5.1-avr1.8.8-libs<N> toolchains/arduino`,
   then `toolchains/arduino/build-part-examples.sh` and check that `examples/blink` still
   builds byte-identical (sha256 in `examples/blink/firmware/BUILD.md`).
