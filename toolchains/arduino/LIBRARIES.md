# Arduino libraries in the toolchain image

The image `faber/arduino-cli:1.5.1-avr1.8.8-libs3` (built from `Dockerfile` in this folder)
ships these libraries, pinned, so sketches for Faber's display, sensor and RTC parts build with
no network access and give the same bytes on every machine. Install is `--no-deps`: every
dependency is listed here explicitly.

They are **user-side** code: they are compiled into the firmware of the sketches that include
them, not into Faber itself. A firmware image Faber ships (for example
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
| LiquidCrystal_I2C | 1.1.2-faber.1 | Apache-2.0 (Faber) | `lcd1602-i2c` | Faber's own clean-room implementation of the API, see below |
| MPU6050 (Electronic Cats) | 1.4.5 | MIT (I2Cdevlib, MIT) | `mpu6050` | The I2Cdevlib-style `MPU6050` class |
| Adafruit ILI9341 | 1.7.0 | MIT (README) / BSD (source headers), Adafruit | `ili9341-tft`, `examples/ai-pet` | `Adafruit_ILI9341 tft(CS, DC, RST); tft.begin(); tft.setRotation(1);`. Added in libs2. |
| Adafruit ST7735 and ST7789 Library | 1.12.0 | MIT, Adafruit | `st7735-tft` | `Adafruit_ST7735 tft(CS, DC, RST); tft.initR(INITR_BLACKTAB);`. Installed `--no-deps`: its seesaw / SD dependencies are only for the TFT FeatherWing examples. Added in libs2. |
| Adafruit GC9A01A | 1.2.0 | BSD (Adafruit; source headers) | `gc9a01-round-tft` | `Adafruit_GC9A01A tft(CS, DC, RST); tft.begin();`. Added in libs3. |
| DHT sensor library | 1.4.7 | MIT, Adafruit | `dht22` | `DHT dht(PIN, DHT22); dht.begin(); dht.readTemperature();`. Needs Adafruit Unified Sensor. Added in libs3. |
| FastLED | 3.10.8 | MIT | `ws2812-strip` | `FastLED.addLeds<WS2812B, PIN, GRB>(leds, N);`. 3.10.9 (2026-11-01) was too new to pin (two-week rule). Its bundled third-party code (kiss_fft BSD, libnsgif MIT, stb / minimp3 public domain, TJpg_Decoder BSD-style) is only compiled when used. Added in libs3. |
| TFT_eSPI | 2.5.43 | FreeBSD (BSD-2-Clause) for Bodmer's code, Adafruit BSD / MIT for the parts it took from Adafruit_GFX / ILI9341 (`license.txt`) | `gc9a01-round-tft`, `ili9341-tft`, `st7735-tft` on RP2040 | Put the display and pins in a `tft_setup.h` next to the sketch (`#define GC9A01_DRIVER`, `TFT_MOSI`, `TFT_SCLK`, `TFT_CS`, `TFT_DC`, `TFT_RST`); the runner adds the sketch folder to the include path when that file exists, so the library itself is never edited. Without it TFT_eSPI uses its default `User_Setup.h` (an ILI9341 on ESP8266 pins), which draws nothing on Faber's wiring. Its `Fonts/GFXFF` fonts are the GNU FreeFont conversions also in Adafruit GFX (GPL-3.0 with the font exception, see below). Not for AVR boards (the library targets 32-bit MCUs). Added in libs3. |
| Adafruit NeoPixel | 1.15.5 | **LGPL-3.0** | `ws2812-strip` | `Adafruit_NeoPixel strip(N, PIN, NEO_GRB + NEO_KHZ800);`. See "Adafruit NeoPixel and the LGPL" below. Added in libs3. |
| U8g2 | 2.36.19 | BSD-2-Clause (code); fonts under their own licenses | `ssd1306-oled-i2c` | Font licenses are listed in the library's `LICENSE`; most are public domain, X11/MIT or OFL. Check before shipping a font in a product. |

Versions are the latest in the Arduino library index on 2026-11-09 (libs3: on 2026-11-10, at least two weeks old). libs2 (2026-11-09) adds the two TFT libraries; sketches that do not include them build byte-identical to libs1. libs3 (2026-11-10, round 6) adds Adafruit GC9A01A, the DHT sensor library, FastLED, TFT_eSPI and Adafruit NeoPixel, in a Docker layer of its own; every golden hex in the repo builds byte-identical with it (checked on 2026-11-10). Licenses were checked
against the `LICENSE`/`license.txt` file inside each installed library.

## RP2040 boards get the same set

`faber/arduino-pico:6.3.1-libs3-r1` (`toolchains/arduino-pico/Dockerfile`) is built FROM the libs3
runner image, so the same library folders serve AVR and RP2040 builds. Every library above builds
for the Seeed XIAO RP2040 (`packages/parts/fixtures/libs3/all_xiao`), and the test sketches in
`packages/parts/fixtures/libs3/` run on the simulator with the part they drive:
`packages/parts/src/libs3.integration.test.ts`.

## Adafruit NeoPixel and the LGPL

Adafruit NeoPixel is LGPL-3.0. It is compiled into the person's own firmware inside the build image;
Faber's repository and packages never contain it, and Faber commits no firmware that links it (its
test sketches are built and run only by the test). If you give someone a firmware binary that links
NeoPixel (a product, a download), the LGPL-3.0 applies to that binary: give them the library's
source (or a link to https://github.com/adafruit/Adafruit_NeoPixel at tag 1.15.5) and a way to
relink your firmware with a modified library (your sketch source, or its object files). FastLED
(MIT) drives the same strips with no such duty.

## Fonts in Adafruit GFX and TFT_eSPI

The `Fonts/` (Adafruit GFX) and `Fonts/GFXFF/` (TFT_eSPI) FreeMono / FreeSans / FreeSerif files are
converted from GNU FreeFont, GPL-3.0 with the font exception: embedding the glyphs in a firmware does
not make the firmware GPL. The default 5x7 font is Adafruit's own (BSD).

## Why there is a Faber LiquidCrystal_I2C

Most Arduino tutorials (and most AI agents) write `#include <LiquidCrystal_I2C.h>` with
`LiquidCrystal_I2C lcd(0x27, 16, 2); lcd.init(); lcd.backlight();`. The library of that name in
the Arduino index (Frank de Brabander / johnrickman, 1.1.2) carries **no license**, so Faber
cannot redistribute it. `libraries/LiquidCrystal_I2C/` is an original Apache-2.0 implementation
of the same API, written from the HD44780U and PCF8574 datasheets (P0 = RS, P1 = RW, P2 = EN,
P3 = backlight, P4-P7 = D4-D7), so those sketches build unchanged. `LiquidCrystal_PCF8574`
(BSD) is the alternative from the index.

Not included, on purpose: `hd44780` by Bill Perry (GPL-3.0).

## Changing the set

1. Edit the `lib install` list in `Dockerfile` (exact `Name@version`), keep `--no-deps`, and list
   every new dependency explicitly.
2. Bump the tag suffix (`-libs2` → `-libs3`) in the Dockerfile comment, in
   `scripts/build-firmware.sh`, `build-part-examples.sh`, `services/runner/src/config.ts` (the
   base, runner and RP2040 tags), `services/runner/docker/Dockerfile` and
   `toolchains/arduino-pico/Dockerfile`, and add the library to `PINNED_LIBRARIES` there.
3. Check the license of every new library (MIT, BSD, Apache-2.0, zlib are fine; no GPL, no
   "no license") and add a row here.
4. Rebuild: `docker build -t faber/arduino-cli:1.5.1-avr1.8.8-libs<N> toolchains/arduino`,
   then `toolchains/arduino/build-part-examples.sh` and check that `examples/blink` still
   builds byte-identical (sha256 in `examples/blink/firmware/BUILD.md`).
