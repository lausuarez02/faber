# 0006: Any board, run locally, plus a generic device network

Status: proposed · 2026-11-11 · round 9 (spike) · branches `round9/plan` (this note), `round9/spike`
(the merged prototypes), `round9/esp32`, `round9/renode`, `round9/network`

The person asked: "i want to build the emulator, it will run locally if people are using the
machine, i want to build the architecture to be able to run basically any board", plus generic
fundamentals so a device can call APIs and use the network easily. They do **not** want anything
built specially for AI voice. Voice is only a possible later example built on the generic layer.

Round 9 was a spike. Three tracks ran real emulators on the target machine (M4 Max, 16 cores,
48 GB, macOS 15 / Darwin 24, Docker Desktop with arm64 Linux containers). This note fixes the
architecture and the plan from what actually ran. The detail is in the track write-ups:
`docs/esp32-emulator.md` (round9/esp32), `docs/decisions/0007-device-network-draft.md` (round9/network,
written as 0006 on its own branch and renumbered on `round9/spike`), and the Renode notes in
`packages/sim-backends/fixtures/BUILD.md` and the NOTICE (round9/renode).

## What ran (verified)

Re-run by the architect on 2026-11-11 from the spike folders, with the images below (not taken
from the track reports):

| Chip / board | Emulator (image) | Boots | Serial | GPIO out | GPIO in | I2C | Network | Speed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ESP32 (Xtensa LX6) | Espressif QEMU 9.2.2 + Jumper bridge patch (`jumper/qemu-esp:9.2.2-20260417-jb2`) | yes, re-run | yes (`hello`, ticks) | yes (GPIO2, test) | yes (GPIO4, test) | yes, I2C0 to a TS device (test) | open_eth + NAT, track run only | free-running icount: 34 s virtual in 6.2 s wall (Blink, idle-heavy); lockstep 1 ms steps 0.7x real time |
| ESP32-S3 | same image, `qemu-system-xtensa -machine esp32s3` | yes, re-run | yes | track run only | track run only | no model in QEMU | open_eth, track run only | 50 s virtual in 6.2 s wall; lockstep 1 ms 1.9x |
| ESP32-C3 (RISC-V) | same image, `qemu-system-riscv32 -machine esp32c3` | yes, re-run | yes | yes (GPIO8, test) | yes (test) | no model in QEMU | open_eth, track run only | 93 s virtual in 6.2 s wall; lockstep 1 ms 1.8 to 2.7x, 10 ms 5x |
| STM32F103 (Blue Pill) | Renode 1.17.0 (`jumper/renode:1.17.0-r1`) + 3 overlays (RCC, FLASH_ACR, bit-band) | yes, re-run | yes (USART1) | yes (test) | yes (test) | yes, C# sensor peripheral (test) | not tried | about 1.2x real time (10 s virtual in 8.5 s; busy-wait `delay()`); container start to running 3.1 s for 2 s virtual |
| nRF52840 (Nano 33 BLE) | Renode 1.17.0, upstream board file | yes, re-run | yes (Serial1 = `uart0`) | yes (D13, test) | track run only | not tried | not tried (no BLE between boards tried) | 5 s virtual in 2.1 s wall including container start; about 9x real time (Mbed sleeps) |
| ATmega328P (Uno / Nano) | avr8js in browser and Node (main) | yes | yes | yes | yes | yes | ESP-01 AT part | ≥1x in the browser (main) |
| RP2040 (Pico, XIAO RP2040, RP2040-Zero) | rp2040js (main) | yes | yes | yes | yes | yes | no | main |

"Test" means a vitest test that passed on `round9/spike` on this machine (with Docker up, none
skipped): `packages/sim-backends` + `packages/device-net`, 9 files, 57 tests, 9 s. "Track run only"
means the track ran it and logged the output; the architect did not repeat it.

The commands the architect ran:

```
# ESP32 / S3 / C3: the Blink merged image padded to 4 MB, 6 s of wall time each
docker run --rm -v $PWD:/fw:ro jumper/qemu-esp:9.2.2-20260417-jb2 timeout 6 \
  qemu-system-xtensa -machine esp32 -nographic -monitor none -serial file:/dev/stdout \
  -icount shift=3,align=off,sleep=off -drive file=/fw/esp32.bin,if=mtd,format=raw -snapshot
#  -> "hello from jumper esp32", "tick 34 on t=34297"   (S3: tick 50 t=50625, C3: tick 93 t=93260)

# Renode: Nano 33 BLE for 5 s virtual, Blue Pill for 2 s virtual
docker run --rm --network none -v .../scripts:/s:ro -v .../fw/out:/fw:ro -v $OUT:/out \
  jumper/renode:1.17.0-r1 --disable-gui --console --plain run_nano5.resc
#  -> "hello from nano33ble", "tick 49 ms=4909 btn=1", exit 0, 2.1 s wall
#  -> Blue Pill: "hello from stm32", "tick 0 ms=0", exit 0, 3.1 s wall
```

Not working (verified by the tracks): Wi-Fi and Bluetooth on every ESP chip
(`WiFi.mode(WIFI_STA)` asserts in `esp_phy_enable` and reboots in a loop); I2S on ESP32 / S3;
`analogRead` on F103 and nRF52840 in Renode (no ADC model); I2C on S3 / C3 (no controller model).

## Options considered

1. **Everything in the browser** (port QEMU / Renode to WASM). The person explicitly wants it to
   run locally on the machine. QEMU-ESP in WASM is a research project (TCG on WASM is slow), and
   Renode is .NET. Rejected for now. The browser keeps the backends that are already JS.
2. **A hosted emulator farm.** Costs money per minute, needs accounts, and the firmware runs far
   from the person. Possible later for CI, not the default.
3. **One emulator to rule them all** (only Renode, or only QEMU). Renode has no ESP32 or RP2040
   upstream; Espressif's QEMU only does Espressif chips. Neither covers what people buy most.
4. **Chosen: one `McuBackend` contract, two kinds of backends.** In-process JS backends (avr8js,
   rp2040js) run in the browser and in Node. Out-of-process backends (Espressif QEMU, Renode,
   later QEMU-Linux) run as separate local processes, in pinned Docker images by default, driven in
   lockstep by Jumper's clock over a socket. A local runner owns them. Boards are data.

## The backend contract

`McuBackend` (packages/sim-core/src/mcu.ts) stays the one interface. The spike proved a
synchronous `step()` works for process backends without changing sim-core: a worker thread owns
the socket and the main thread blocks in `Atomics.wait` until the emulator answers `T <ns>`
(QEMU) or `RunFor` returns (Renode). Both backends pass the same kind of tests as avr8js and
rp2040js.

Changes to the contract (small, additive):

- **`prepare?(): Promise<void>`** on the factory result, or an async `backendFactory`, so the 1 to
  3 s container start never blocks the event loop. The Simulation awaits it before the first
  `step()`. Today's backends return immediately.
- **`dispose(): void`** required for process backends (kill the container by name; both prototypes
  already label and reap leftovers).
- **`capabilities`**: which buses are bridged (`gpio`, `uart`, `i2c`, `spi`, `adc`, `pwm`, `i2s`,
  `net`), so the fidelity report and design checks say "I2C is not emulated on the ESP32-C3" at
  the board instead of failing at run time.
- **`stopAt`** stays optional. QEMU lockstep can honour it (`R <cycle>`); Renode only at the end of
  a `RunFor`, so parts that need sub-step timing (HC-SR04) get a smaller step on those boards.
- New optional sinks, same shape as `attachI2c` / `attachSpi`: `attachI2s?(stream)` (sample
  frames with virtual time), `attachNet?(net)` (see below), and per-byte UART time on Renode
  (needs the C# bridge, see Bridges).

Where each kind runs:

| | In-process (avr8js, rp2040js) | Local process (qemu-esp, renode) |
| --- | --- | --- |
| Browser canvas | runs in the page (today) | the page follows the runner's simulation over `ws://…/live` (the follow mode that exists today for agent runs), and sends inputs (button presses, sensor values) back |
| `jumper serve`, MCP, CLI, CI | runs in Node (`SimHost`) | `SimHost` in Node, backend spawns the emulator process |
| Determinism | exact | exact in lockstep (QEMU icount + `-rtc clock=vm`, Renode paused between `RunFor`); network traffic is the exception |

The **local runner** is `services/runner` grown up: today it builds firmware in Docker; it also
owns emulator processes (start, reuse a warm one per board type, kill on dispose, reap orphans at
start), checks Docker and the image and says why and how to fix it when either is missing ("Docker
is not running. Fix: open Docker Desktop, then press Run again"), and exposes both to `jumper
serve`. Never port 7780 by accident: every emulator port is picked free at launch.

**Docker by default, native optional.** Both tracks measured native macOS arm64 releases: Renode's
native app starts in 0.46 s vs 1.9 s and runs at the same speed, but is unsigned; Espressif's
native QEMU cannot be used as-is because pin access needs our patch. A pinned Linux image runs the
same on macOS, Linux and a server and is the only thing CI needs. The launchers already accept
`runtime: "native"` for later (a signed, notarised build we ship next to the app).

## Bridges: how each signal crosses

Everything the circuit can see crosses as a **time-stamped event** on one socket per board, so
the Simulation applies it at the right virtual time and runs stay reproducible.

| Signal | ESP (QEMU + patch) | Renode | Status |
| --- | --- | --- | --- |
| GPIO out / in | `G` / `I` lines (patched GPIO block, both banks) | ExternalControl GPIO callbacks / set | done, tested |
| UART | `U` / `W` lines, per byte with virtual ns | separate socket, stamped at the end of the step | done; Renode per-byte time needs the C# bridge |
| I2C | `IS/IW/IR/IP` out, `A/D` answers, ESP32 I2C0 | one C# "Jumper bridge" peripheral that forwards transactions (prototype: a fixed sensor) | ESP32 done; Renode generic bridge next; S3/C3 need a QEMU I2C controller model |
| SPI | not yet (pin-matrix routing first) | `ExternalControlSPIPeripheral`, per byte | Renode done |
| PWM | LEDC duty as an event, not edges | Renode PWM peripherals per platform | next |
| ADC | input voltage as an event | only on platforms that model it (G0, RA4M1) | next |
| I2S | a new QEMU device that streams sample frames with virtual time to `attachI2s` | per platform | designed only |
| RMT / NeoPixel | RMT symbols as an event | n/a | next |
| Network | QEMU `-nic` (open_eth) into the device network, below | Renode `CreateNetworkServer` / TAP, untested | ESP: NAT works; gateway adapter not built |

Later the ESP patch becomes a proper QEMU device with binary framing (the text protocol costs
about 0.4 ms per round trip through Docker Desktop; most of that is the VM boundary, not parsing).

## Clock and determinism per backend

| Backend | Time base | Determinism | Speed (measured) |
| --- | --- | --- | --- |
| avr8js / rp2040js | CPU cycles, in process | exact | ≥1x in the browser |
| QEMU-ESP | `-icount shift=3,align=off,sleep=off -rtc clock=vm`, lockstep `T`/`R` | exact to the ns across runs, all three chips (tested) | 1 ms steps: ESP32 0.7x, S3 1.9x, C3 1.8 to 2.7x real time; 10 ms steps up to 5x (C3); 100 µs steps 0.22 to 0.25x |
| Renode | virtual time, paused between `RunFor`, GPIO / SPI events stop it until answered | identical edge times across 4 runs | 1.2x (F103 busy-wait) to 9x (nRF52 sleeping) |

Default step: 1 ms; the Simulation raises it to 5 to 10 ms when no part asks for tighter timing
(most projects), and lowers it around `stopAt` requests. The ESP32 (dual core) below 1x in lockstep
is a known gap; the C3 and S3 are above 1x.

A run with real network traffic (internet mode) cannot be bit-for-bit reproducible. Mock and
cassette modes are, once the gateway's delays move to virtual time.

## Boards are data

A board is a part folder (as today) whose `part.json` `mcu` block names everything the runtime
needs. Nothing about a board lives in backend code except the chip model:

```jsonc
"mcu": {
  "backend": "qemu-esp",            // avr8js | rp2040js | qemu-esp | renode
  "chip": "esp32s3",                // the backend's chip id
  "clockHz": 240000000,             // the time base McuBackend.cycles counts in
  "vcc": 3.3,
  "platform": "boards/seeed_xiao_esp32s3.repl", // Renode: platform file (+ overlays); QEMU: machine
  "flash": { "sizeMB": 8, "mode": "dio" },
  "console": "uart0",
  "pinMap": { "D0": "GPIO1", "D1": "GPIO2" },   // part pin id -> backend pin id
  "pullUps": ["GPIO5", "GPIO6"],
  "busPins": { "i2c": { "sda": "GPIO5", "scl": "GPIO6" } },
  "toolchain": { "image": "jumper/arduino-esp32:3.3.12-r2", "fqbn": "esp32:esp32:XIAO_ESP32S3:FlashMode=dio" },
  "verified": "packages/sim-backends/fixtures/xiao-esp32s3"  // the fixture test that proves it
}
```

Plus what part folders already carry: pins, visual, `dimensions_mm`, mass, power limits,
`mechanical` and `sourcing` (case design, factory pack), `fidelity.json`. The project-format schema
grows the optional fields; existing boards keep working unchanged. A board without a passing
fixture shows as "unverified" in the fidelity report.

Toolchain images are picked from the FQBN prefix as today (`services/runner/src/config.ts`
`PLATFORMS`): add `esp32:esp32:` → `jumper/arduino-esp32`, `STMicroelectronics:stm32:` →
`jumper/arduino-stm32` (amd64-only image: STM32Tools has no aarch64 build, so it runs emulated, 14 s
per sketch), `arduino:mbed_nano:` → `jumper/arduino-mbed-nano`. Firmware formats: AVR / RP2040 Intel
HEX (today), ESP merged flash image (padded to the flash size), Renode ELF (not fully stripped:
Renode finds the vector table from symbols; use `--strip-debug`).

## Firmware languages

| Language / framework | What it needs | When |
| --- | --- | --- |
| Arduino (arduino-cli) | done for AVR, RP2040; spike images for ESP32 family, STM32duino, Mbed Nano | now (M-A, M-C) |
| ESP-IDF (C) | an image with the IDF + `idf.py build`, merged image via `esptool merge_bin`; same QEMU backend. Gets OpenETH by `sdkconfig` instead of the JumperEth library | M-D |
| PlatformIO | one image, `pio run -e <env>`; reads `platformio.ini`; maps to the same backends by `board =`. Big downloads per platform: cache them in the image per platform family | M-D |
| Zephyr | `west build -b <board>`; Zephyr has QEMU and Renode targets upstream, so the board file names the Zephyr board too | M-D |
| Rust (esp-hal, embassy) | `cargo` + `espflash save-image --merge`; for Cortex-M a plain ELF for Renode | M-D |
| MicroPython / CircuitPython | no build: a pinned firmware image per board plus the person's `.py` files written into the emulated flash filesystem (littlefs image built in the container) | M-D, after the filesystem tool |

Each language is one toolchain image + one output-format rule; the backends do not change. Build
errors keep the existing "why / fix / file:line" shape.

## The device network and API layer (generic)

Prototype: `packages/device-net` (round9/network; full design in its draft, renumbered 0007).

- **The emulator gives the firmware real sockets.** QEMU `-nic` gives open_eth; the firmware gets
  DHCP, DNS, TCP and TLS like on a real board. Measured through QEMU's NAT: DHCP 1.0 s, a server on
  the Mac 13 to 96 ms, `http://example.com` 34 to 122 ms, `https://example.com` 300 to 810 ms.
- **A Wi-Fi shim**, link-time only in the simulation build: wraps `esp_wifi_*` so an unmodified
  `WiFi.begin()` + `HTTPClient` sketch brings up the emulated Ethernet and receives the usual
  connected / got-IP events. Stated as a fidelity gap: radio ❌, sockets ✅.
- **One gateway owns all policy** (the device never sees a key): fake-IP DNS so every connection
  maps back to a host name; per-project mode `offline` / `mock` (default) / `internet` with an allow
  list; TLS inspected with a per-project sandbox CA (the firmware trusts it in the sim build) or
  passed through; HTTP, WebSocket, MQTT and raw TCP recognised from the first bytes; answers from
  mocks, then cassettes, then the real host.
- **Secrets are added by the proxy, never compiled into firmware.** A project declares a secret by
  name (value from the environment or `.env`, never in `jumper.json`); an allow entry says which
  host gets it (`Authorization: Bearer {{secret:NAME}}`). Redacted in the device's view, logs,
  `read_network`, cassettes and the factory pack. Literal keys in config are refused with why and fix.
- **Mock APIs and cassettes**: HTTP routes (status, body, streamed chunks, delays), scripted
  WebSocket frames, an MQTT broker; record real exchanges once, replay offline in tests.
- **Faults**: HTTP error, latency, timeout, Wi-Fi drop, all from the agent and scenarios.
- **Agent tools**: `read_network`, `add_mock_api`, `inject_network_fault`; scenario step
  `{"request": …}`.
- **Adapter to the emulators** (not built): a small Go sidecar using gVisor netstack (Apache-2.0)
  that takes QEMU's raw frames (`-netdev stream`) and hands each DNS query and TCP flow to the
  gateway over `JUMPER-FLOW/1`. Until then, QEMU's own NAT works but bypasses the policy.
- The existing pet AI network (`services/ai-gateway`, ESP-01 AT part) becomes an ordinary mock +
  internet mode on the same gateway.

Nothing in the gateway knows about audio or AI. **A later AI voice example** is a project, not a
feature: a secret by name, an allow entry for the provider with the secret header, firmware that
streams microphone frames over a WebSocket (or a streaming HTTPS POST) and plays the frames it
receives (I2S in and out, which needs the I2S bridge), and tests that use a WebSocket mock with
recorded frames or a cassette.

## Licensing

- Shipped and linked code stays MIT / Apache-compatible: the TS backends, `device-net` (ws MIT,
  @peculiar/x509 and deps MIT / BSD-3 / Apache-2.0 / 0BSD), the planned gVisor sidecar (Apache-2.0).
- **QEMU (GPL-2.0) runs only as a separate process** in an image built from a public tag plus our
  patch (GPL-2.0, published in `toolchains/qemu-esp/`). Anyone can rebuild it. Disclosed in NOTICE.
- Renode (MIT) runs as a separate process; the ExternalControl client is reimplemented in TS from
  its MIT client.
- Firmware cores are the person's build inputs, not Jumper code: arduino-esp32 / STM32duino /
  Mbed cores LGPL-2.1, ESP-IDF Apache-2.0, the JumperEth library contains Apache-2.0 ESP-IDF files.
  Firmware library hints steer away from GPL-3.0 libraries (e.g. gilmaimon ArduinoWebsockets).
- esptool (GPL-2.0) is a build tool run as a program.

## Milestones (sizes are engineer-days for one agent track, honest ranges)

**M-A. ESP32-S3 and C3 boards end to end in the UI (incl. XIAO ESP32-S3 with its built-in charger).
10 to 15 days.**
- Wire `qemu-esp` into `backendFactory` server-side only, with async prepare and dispose (2 d).
- Runner owns emulator processes; web canvas follows the runner's sim for process backends, inputs
  go back over the live socket; clear "Docker is not running / image missing" errors with fix (3 to 4 d).
- Board parts: ESP32 DevKitC, ESP32-S3 DevKitC, ESP32-C3 SuperMini, **Seeed XIAO ESP32-S3**
  (pin map D0 to D10, user LED, BAT pads; the on-board Li-ion charger modelled with the existing
  charger / battery power model so a LiPo on BAT charges from USB and powers the board) with
  visuals, dimensions, fidelity files and fixture tests (3 d).
- Bridges for what common sketches use: pin interrupts and pin-matrix routing, LEDC PWM, an I2C
  controller model for S3 / C3 in QEMU (the XIAO's I2C is on an S3) (3 to 5 d).
- Build: `esp32:esp32:` in the runner's platforms; image size 6.5 GB, so pull on first ESP build
  with progress (1 d).
- Done when: Blink, a button, an SSD1306 on I2C and serial work on the XIAO ESP32-S3 on the canvas
  at ≥1x real time, deterministically, from an agent over MCP and by hand.

**M-B. Device network sandbox, mock APIs, secrets, and one example that calls a real API.
8 to 12 days.**
- Merge `device-net`; `network` in the project schema; session tool routing; Network panel in the
  web app; scenario `request` step (3 d).
- Gateway delays and faults on the virtual clock (1 d).
- Go netstack sidecar between QEMU `-netdev stream` and `JUMPER-FLOW/1`; sandbox CA trusted by the
  sim build's mbedTLS (3 to 5 d; mbedTLS trust is untested).
- Wi-Fi shim so unmodified `WiFi.begin()` sketches connect (2 d).
- Example project: an ESP32-S3 that fetches a real public API (weather or similar) over HTTPS with
  a key injected by the proxy, a mock and a cassette for its tests, and a Wi-Fi-drop scenario (1 d).
  An AI voice stream can be a later example built from these same pieces plus I2S.
- Migrate the pet AI network onto the gateway (1 to 2 d).

**M-C. Renode: nRF52840 and STM32. 8 to 12 days.**
- Wire `renode` into `backendFactory` (async prepare, `stopAt` at step granularity, firmware swap
  without a new container) (2 d).
- Generic C# Jumper bridge peripheral: I2C transactions and per-byte UART time (3 d).
- Board parts with verified pin maps: Nano 33 BLE (only D13 / D2 checked so far), Blue Pill,
  Nucleo / Black Pill F4, with ADC where the platform has it (G0, RA4M1 Uno R4) and the gap stated
  where it does not (3 to 4 d).
- Network for Renode boards and BLE between two nRF52s, tried and either shipped or written up (2 d).

**M-D. More languages. 3 to 5 days each.** ESP-IDF first (same backend, better networking),
then PlatformIO, Zephyr, Rust, MicroPython (needs the flash filesystem image).

Order: M-A, then M-B (it needs a working ESP board in the UI to be useful), then M-C, then M-D.
M-B's gateway work (schema, panel, virtual-clock delays) can start alongside M-A.

## Still unknown

- ESP32 classic in lockstep is 0.6 to 0.8x real time, below its free-running speed; cause not found.
- Throughput through the network path (only latency was measured); mbedTLS trusting the sandbox CA;
  the netstack sidecar is designed, not built; no emulated firmware has gone through the gateway yet.
- The Wi-Fi shim and the I2S device are designed only. Wi-Fi radio behaviour (RSSI, roaming,
  provisioning) will never be emulated; it is a fidelity gap, not a bug.
- Images and tests on a Linux host and on Intel Macs; Docker Desktop memory with several boards at
  once; Windows not considered.
- Native (non-Docker) runtimes: Espressif's macOS QEMU never run; Renode native needs notarising.
- First-run cost: the ESP build image is 6.5 GB; the STM32 build image is amd64-only (emulated).
- Renode: nRF52 BLE between boards, its networking, the DA16200 Wi-Fi model, ADC on F1 / nRF52.
- How the browser feels when it follows a process backend (input latency through the live socket).
- The XIAO ESP32-S3 charger IC and its exact behaviour (charge current, status LED) to be taken
  from Seeed's schematic, not memory.
