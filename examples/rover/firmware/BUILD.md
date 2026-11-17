# Rover firmware: how the golden .hex is built

```sh
scripts/build-firmware.sh examples/rover/firmware/rover arduino:avr:uno examples/rover/firmware/build
cp examples/rover/firmware/build/rover.ino.hex examples/rover/firmware/rover.hex
```

Same toolchain as Blink (`firmware/BUILD.md` there): arduino-cli 1.5.1, `arduino:avr@1.8.8`,
image `faber/arduino-cli:1.5.1-avr1.8.8`, built natively on linux/arm64 (Apple Silicon). The
sketch uses only the Arduino core (no libraries).

sha256 of the golden hex (2026-11-09):
`f23e7248b3f18674e0491fab58b120d89426b0998ed2bc4abc4ccfde546facf8`

`build/rover.ino.hex` is committed too (the folder's `.gitignore` keeps only it); a test asserts
both files are identical.
