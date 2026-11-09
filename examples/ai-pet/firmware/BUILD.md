# AI pet firmware: how the golden .hex is built

```sh
export JUMPER_ARDUINO_IMAGE=jumper/arduino-cli:1.5.1-avr1.8.8-libs2
docker image inspect "$JUMPER_ARDUINO_IMAGE" >/dev/null || docker build -t "$JUMPER_ARDUINO_IMAGE" toolchains/arduino
scripts/build-firmware.sh examples/ai-pet/firmware/ai-pet arduino:avr:uno examples/ai-pet/firmware/build
cp examples/ai-pet/firmware/build/ai-pet.ino.hex examples/ai-pet/firmware/ai-pet.hex
rm -rf examples/ai-pet/firmware/build
```

| Component | Version |
| --- | --- |
| arduino-cli | 1.5.1 |
| Core | `arduino:avr` 1.8.8 (avr-gcc 7.3.0), including SoftwareSerial and SPI |
| Adafruit ILI9341 | 1.7.0 (MIT / BSD) |
| Adafruit GFX Library | 1.13.0 (BSD) |
| Adafruit BusIO | 1.17.4 (MIT) |
| FQBN | `arduino:avr:uno` |

Size: 25134 bytes of flash (77 %), 841 bytes of globals (41 %).

sha256 of `ai-pet.hex` (first 16 hex digits): `e1bcffbbb7d469b8`.
