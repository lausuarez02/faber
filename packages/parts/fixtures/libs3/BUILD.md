# libs3 test sketches

`packages/parts/src/libs3.integration.test.ts` runs these on the simulator with the part each one
drives (decision 0004, R7). Golden builds, committed; rebuild them only on purpose.

| Sketch | Board (FQBN) | Library | Part, wiring | What the test checks |
| --- | --- | --- | --- | --- |
| `gc9a01a_uno` | Uno (`arduino:avr:uno`) | Adafruit GC9A01A 1.2.0 | `gc9a01-round-tft`: SCL D13, SDA D11, RES D8, DC D9, CS D10 | orange disc, two black eyes, blue mouth, black corners |
| `gc9a01a_xiao` | Seeed XIAO RP2040 (`rp2040:rp2040:seeed_xiao_rp2040`) | Adafruit GC9A01A 1.2.0 | `gc9a01-round-tft`: SCL GP2, SDA GP3, RES GP28, DC GP29, CS GP1 | the same face |
| `tft_espi_xiao` | Seeed XIAO RP2040 | TFT_eSPI 2.5.43 + `tft_setup.h` | as above | the same face, drawn by TFT_eSPI |
| `dht_uno` / `dht_xiao` | Uno / XIAO RP2040 | DHT sensor library 1.4.7 | `dht22` DATA on D2 / GP26 | `t=23.4 h=41.5` on serial |
| `fastled_uno` / `fastled_xiao` | Uno / XIAO RP2040 (PIO) | FastLED 3.10.8 | `ws2812-strip` (8 LEDs) DIN on D6 / GP26 | red, green, blue, 5 × dim white |
| `neopixel_uno` / `neopixel_xiao` | Uno / XIAO RP2040 (PIO) | Adafruit NeoPixel 1.15.5 (LGPL-3.0) | as FastLED | the same colours; **no hex committed** (NOTICE): the test builds and runs them when the images are there |
| `all_xiao` | XIAO RP2040 | every display / sensor library | none (compile only) | builds |

Build (Docker, the pinned images; `ensureImage` builds them on first use):

```sh
docker build -t fabwright/arduino-cli:1.5.1-avr1.8.8-libs3 toolchains/arduino
docker build --build-arg BASE_IMAGE=fabwright/arduino-cli:1.5.1-avr1.8.8-libs3 -t fabwright/arduino-runner:1.5.1-avr1.8.8-libs3-r1 services/runner/docker
docker build --build-arg BASE_IMAGE=fabwright/arduino-runner:1.5.1-avr1.8.8-libs3-r1 -t fabwright/arduino-pico:6.3.1-libs3-r1 toolchains/arduino-pico
pnpm exec vitest run packages/parts/src/libs3.integration.test.ts   # rebuilds and compares when the images exist
```

To regenerate a hex on purpose, build the sketch through the runner (`buildFirmware` from
`@fabwright/runner` with the FQBN and library above) and write `result.hex` to `<sketch>.hex`.

Toolchain: arduino-cli 1.5.1, `arduino:avr` 1.8.8, `rp2040:rp2040` 6.3.1, libraries at the versions
of `toolchains/arduino/LIBRARIES.md`.
