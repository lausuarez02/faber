# Robot arm firmware: how the golden .hex is built

```sh
scripts/build-firmware.sh examples/robot-arm/firmware/robot-arm arduino:avr:uno examples/robot-arm/firmware/build
cp examples/robot-arm/firmware/build/robot-arm.ino.hex examples/robot-arm/firmware/robot-arm.hex
```

Same toolchain as Blink: arduino-cli 1.5.1, `arduino:avr@1.8.8`, image
`fabwright/arduino-cli:1.5.1-avr1.8.8`, linux/arm64. Only the Arduino core (no libraries).

sha256 of the golden hex (2026-11-09):
`aa88709936030c7c0466a40b2bbef0fa8017d0b1645fabb0a629da1e815a97b1`
