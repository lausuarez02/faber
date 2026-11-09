# Bus fixtures: golden firmware for the TWI and SPI tests

`src/twi.test.ts` runs these real compiled sketches on the avr8js backend. The `.hex` files are
committed golden builds; rebuild them only on purpose.

| Sketch | Hex | What it does |
| --- | --- | --- |
| `i2c_probe/i2c_probe.ino` | `i2c_probe.hex` | I2C scanner (prints `found 0xNN`, `scan done N`), then every 20 ms writes `00 AF` to 0x3C and reads one byte, printing `tx <endTransmission result> rx <count> <byte>` |
| `spi_probe/spi_probe.ino` | `spi_probe.hex` | Every 20 ms: CS (D10) low, sends `9F 00 00`, prints the three bytes received |

Build (Docker, toolchain image with the pinned core):

```sh
export JUMPER_ARDUINO_IMAGE=jumper/arduino-cli:1.5.1-avr1.8.8-libs1
for s in i2c_probe spi_probe; do
  scripts/build-firmware.sh packages/sim-backends/fixtures/$s arduino:avr:uno packages/sim-backends/fixtures/$s/build
  cp packages/sim-backends/fixtures/$s/build/$s.ino.hex packages/sim-backends/fixtures/$s.hex
  rm -rf packages/sim-backends/fixtures/$s/build
done
```

Toolchain: arduino-cli 1.5.1, `arduino:avr` 1.8.8 (avr-gcc 7.3.0), FQBN `arduino:avr:uno`. Both
sketches use only the core (`Wire`, `SPI`), so the library set of the image does not matter.

sha256 (first 16 hex digits): `i2c_probe.hex` 4c06f619f6b1cf72, `spi_probe.hex` df5ed51b53c35162.
