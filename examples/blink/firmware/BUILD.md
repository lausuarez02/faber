# Blink firmware: how the golden .hex is built

`blink/blink.ino` is the classic Blink on `LED_BUILTIN` (D13): 1000 ms on, 1000 ms off, and
`Serial.println("LED on")` / `("LED off")` at 115200 baud on every change.

The compiled image is **golden firmware**: it is committed, and the sim-backends tests assert
exact pin timing, serial output and trace hashes against it. Rebuild it only on purpose.

## Build

```sh
scripts/build-firmware.sh examples/blink/firmware/blink arduino:avr:uno examples/blink/firmware/build
cp examples/blink/firmware/build/blink.ino.hex examples/blink/firmware/blink.hex
```

The script builds the toolchain image from `toolchains/arduino/Dockerfile` on first use (native
arch: arm64 on Apple Silicon, amd64 elsewhere; `FABWRIGHT_DOCKER_PLATFORM=linux/amd64` forces one).

## Artifacts

| File | Committed | Notes |
| --- | --- | --- |
| `build/blink.ino.hex` | yes (see note) | flash image without bootloader, 1992 bytes of code |
| `blink.hex` | yes | same bytes; the path `fabwright.json` `firmware.artifact` points at |
| `build/*.elf`, `*.eep`, `*.with_bootloader.*` | no | ignored by `build/.gitignore` |

Note: the root `.gitignore` ignores every `build/` directory, so `build/blink.ino.hex` needs an
exception there (`!examples/*/firmware/build/` plus the folder's own `.gitignore`) or `git add -f`.

sha256 of the golden hex:
`b931e0a66fac7a30df9c033d2ecf171164c6fe00f33aea2bb65aaf1fe41c1d26`

## Toolchain versions (recorded 2026-11-08)

| Component | Version |
| --- | --- |
| Base image | `debian:bookworm-20251020-slim` |
| arduino-cli | 1.5.1 (commit 01f3d4f2b, 2026-06-05); tarball sha256 pinned in the Dockerfile |
| Core | `arduino:avr` 1.8.8 |
| avr-gcc | 7.3.0-atmel3.6.1-arduino7 (GCC 7.3.0) |
| avrdude (unused) | 8.0.0-arduino1 |
| FQBN | `arduino:avr:uno` |
| Image tag | `fabwright/arduino-cli:1.5.1-avr1.8.8` |

Reproducibility: built on linux/arm64 (Apple Silicon, native) and linux/amd64 (emulated); both
produced the byte-identical hex above.

## Without Docker

Install arduino-cli 1.5.1 and `arduino-cli core install arduino:avr@1.8.8`, then
`arduino-cli compile --fqbn arduino:avr:uno --output-dir examples/blink/firmware/build examples/blink/firmware/blink`.
Compare the sha256 with the one above.
