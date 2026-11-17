# Tamagotchi firmware: how the golden .hex is built

```sh
export FABER_ARDUINO_IMAGE=faber/arduino-cli:1.5.1-avr1.8.8-libs1
scripts/build-firmware.sh examples/tamagotchi/firmware/tamagotchi arduino:avr:uno examples/tamagotchi/firmware/build
cp examples/tamagotchi/firmware/build/tamagotchi.ino.hex examples/tamagotchi/firmware/tamagotchi.hex
rm -rf examples/tamagotchi/firmware/build
```

The image is built from `toolchains/arduino/Dockerfile` (see `toolchains/arduino/LIBRARIES.md`).

| Component | Version |
| --- | --- |
| arduino-cli | 1.5.1 |
| Core | `arduino:avr` 1.8.8 (avr-gcc 7.3.0) |
| Adafruit SSD1306 | 2.5.17 (BSD) |
| Adafruit GFX Library | 1.13.0 (BSD) |
| Adafruit BusIO | 1.17.4 (MIT) |
| FQBN | `arduino:avr:uno` |

Size: 17040 bytes of flash (52%), 568 bytes of globals plus the 1024-byte display buffer that
Adafruit_SSD1306 allocates at `begin()`.

sha256 of `tamagotchi.hex` (first 16 hex digits): `153ec20a5c35dc0f`.
