# Native runtime: firmware builds and emulators without Docker

Round 11. Jumper builds Arduino firmware and runs the ESP32, STM32 and nRF52 emulators either in
pinned Docker images (Linux, CI, any machine whose Docker works) or natively, from toolchains and
emulators Jumper installs and owns under `~/.jumper`. A Mac without Docker needs nothing else.

```sh
pnpm jumper setup            # everything: every board family's toolchain, QEMU, Renode
pnpm jumper setup esp32      # one family: avr, rp2040, esp32, stm32, nrf52, renode
pnpm jumper setup list       # what is installed, and which runtime Jumper will use
```

The app shows the same lines: `GET /api/runtime` (where builds and emulators run, what is
installed) and `POST /api/runtime/setup {"target": "esp32"}` (the install's progress, one JSON line
per line `jumper setup` prints).

## Which runtime runs what

`JUMPER_RUNTIME` (default `auto`):

| Setting | Builds | Emulators |
| --- | --- | --- |
| `auto` | Docker when `docker info` answers within 4 s (`JUMPER_DOCKER_PROBE_MS`) and the board's image is there; the native toolchain when Docker does not answer, or when it does but the image is missing and the native toolchain is installed; Docker (which builds its image) otherwise | the same rule with the emulator's image and native install |
| `docker` | always Docker (round 10 behaviour) | always Docker |
| `native` | always native; a missing toolchain fails with the `jumper setup` command to run | always native |

The probe runs once per 30 s, so a hung Docker Desktop costs one 4 s wait, not one per build.
`JUMPER_QEMU_ESP_RUNTIME` and `JUMPER_RENODE_RUNTIME` still force one emulator.

When nothing can run, the error says what failed, why and how to fix it, for example:

> Build failed: nothing on this computer can compile for esp32:esp32:XIAO_ESP32S3. Why: Docker is not
> running (Cannot connect to the Docker daemon …), and Jumper's native toolchain for ESP32 / S3 / C3
> (arduino-esp32) is not installed. Fix: run `jumper setup esp32` (installs it natively, no Docker
> needed; about 2.5 GB, 4 minutes), or start Docker Desktop, then build again.

## What is installed

| Path | What | Pinned like |
| --- | --- | --- |
| `~/.jumper/toolchains/arduino/1.5.1/bin/arduino-cli` | arduino-cli 1.5.1, the release archive for this OS, SHA-256 checked (macOS arm64 / x64, Linux x64 / arm64) | `toolchains/arduino/Dockerfile` |
| `…/data` | the cores: `arduino:avr` 1.8.8, `rp2040:rp2040` 6.3.1, `esp32:esp32` 3.3.12, `STMicroelectronics:stm32` 2.11.0, `arduino:mbed_nano` 4.4.1, `Seeeduino:nrf52` 1.1.13 (arduino-cli checks every archive against its index); the folders the Dockerfiles delete (other chips' libraries, debuggers) are deleted here too | each family's Dockerfile |
| `…/user/base/libraries` | the libs3 set + Servo, `--no-deps`, plus Jumper's LiquidCrystal_I2C | `toolchains/arduino/LIBRARIES.md`, `services/runner/docker` |
| `…/user/esp32/libraries` | the same, plus PubSubClient 2.8.0, MQTT 2.5.3, ArduinoJson 7.4.3, WebSockets 2.7.2, JumperEth and JumperSim | `toolchains/arduino-esp32/Dockerfile.sim` (r3) |
| `~/.jumper/emulators/qemu-esp/9.2.2-20260417-jb7` | Espressif QEMU `esp-develop-9.2.2-20260417` + `toolchains/qemu-esp/0001..0006` (bridge v6: + I2S, Ethernet RX queueing, and the camera port `CC` / `CD`, [cameras.md](cameras.md); round 13), **built on this machine** (Jumper does not ship QEMU binaries) with the Docker image's configure flags | `toolchains/qemu-esp/Dockerfile` |
| `~/.jumper/emulators/renode/1.17.0` | Renode 1.17.0 portable (macOS arm64 `.dmg`, Linux arm64 `.tar.gz`), SHA-256 checked, platform cache warmed | `toolchains/renode/Dockerfile` |

Jumper's folders never touch an Arduino IDE install (`~/Library/Arduino15`, `~/Documents/Arduino`).
`JUMPER_NATIVE_HOME` moves all of it (`JUMPER_HOME` stays the projects registry's folder).

The post-build steps the images' entrypoints do run natively too: RP2040 ELF to Intel HEX
(`objcopy`), the ESP32 simulation build (`-DJUMPER_SIM=1`, and for sketches that include network
headers the JumperSim shim and `--wrap` flags on a copy of the sketch; `purpose: "device"` leaves
it out), the merged ESP32 flash padded to 4 MB, and the nRF52 `sim.hex` + `.uf2`
(`toolchains/arduino-nrf52/jumper-sim-hex.py`, needs `python3`).

## Machine requirements

- macOS on Apple silicon (tested: M4 Max, macOS 15.6) or Linux.
- `python3` (Xcode Command Line Tools on macOS): the nRF52 sim.hex step and the Seeed core's UF2 step.
- The ESP32 emulator is compiled here: a C compiler, `git`, `pkg-config`, and Homebrew's `glib`,
  `pixman`, `libgcrypt`, `libslirp` (`brew install glib pixman libgcrypt libslirp pkgconf`). Jumper
  puts `ninja` and `tomli` (macOS's Python 3.9 has no `tomllib`) in a private venv. Missing pieces
  are named with their install command before anything is built. The binaries link Homebrew's
  libraries, so they are for this machine only.
- Rosetta 2 (Apple silicon): the Seeed nRF52 core's own `adafruit-nrfutil` (the DFU zip step) is an
  x86-64 binary. STM32duino's `STM32Tools` are only amd64 on Linux; on macOS they are shell scripts
  plus arm64 compilers, so STM32 builds run natively without Rosetta.

## Measured (round 11, M4 Max, home connection)

| Family | `jumper setup` time | On disk |
| --- | --- | --- |
| arduino-cli + `avr` | 30 s | 0.29 GB (with arduino-cli and the base libraries: 0.5 GB) |
| `rp2040` | 27 s | 1.1 GB |
| `esp32` (toolchain) | 92 s | 3.9 GB + 0.19 GB libraries |
| `esp32` (QEMU, compiled) | 45 s | 50 MB |
| `stm32` | 34 s | 2.2 GB |
| `nrf52` (mbed_nano + Seeed) | 17 s + 31 s | 0.5 GB + 0.9 GB |
| Renode 1.17.0 | 13 s | 180 MB |

Everything: about 10 GB and 5 minutes. For comparison, the ESP32 Docker image alone is about 6.5 GB.

## Same output as Docker

- AVR and RP2040: byte-identical to the committed Docker builds (`examples/blink`, `xiao_blink`,
  the libs3 fixtures), checked by `services/runner/test/runner.test.ts` and
  `packages/parts/src/libs3.integration.test.ts`. Exception: FastLED sketches differ by a few bytes
  of register allocation (GCC is not bit-reproducible across host builds of the same version); the
  test runs them on the simulator instead (the strip shows the same colours).
- ESP32 family: the same image size as the Docker build of the same sketch. Native builds map paths
  to the image's (`-ffile-prefix-map` to `/opt/arduino/…`, `/work`), so no home folder ends up in the
  firmware. ESP-IDF stamps the build time into every image, so two builds (Docker or native) never
  match byte for byte.
- STM32 / nRF52: the committed Renode fixtures were built natively already (round 10); the Renode
  tests run them.

## Not native yet

- ESP-IDF (`jumper/esp-idf`) and PlatformIO (`jumper/platformio`) builds still need Docker.
- MicroPython needs no toolchain (composed in process) on any runtime.
- Native QEMU and Renode are not signed or notarised; QEMU is compiled locally for that reason.
