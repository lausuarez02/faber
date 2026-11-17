# STM32 and nRF52840 boards (Renode)

Status: round 10, track renode (`round10/renode`). Five boards run real Arduino firmware in
[Renode](https://renode.io) 1.17.0 (MIT), an emulator in another process, driven in lockstep by
Fabwright's clock through the generic `McuBackend` contract. Measured on an Apple M4 Max, macOS 15.

## Boards

| Board | Chip | Core (build image) | Parts library | Fixture test |
| --- | --- | --- | --- | --- |
| STM32 Blue Pill | STM32F103C8, 72 MHz | STM32duino 2.11.0 (`fabwright/arduino-stm32:2.11.0-libs3-r1`, amd64) | available | pins out + in, Wire, SPI, ADC, PWM, IRQ, Serial |
| WeAct Black Pill | STM32F411CE, 100 MHz | STM32duino 2.11.0 | available | all of the above |
| ST Nucleo-F401RE | STM32F401RE, 84 MHz | STM32duino 2.11.0 | **planned**: `attachInterrupt` never fires (cause not found) | pins, Wire, SPI, ADC, PWM, Serial pass |
| Arduino Nano 33 BLE | nRF52840, 64 MHz | arduino:mbed_nano 4.4.1 (`fabwright/arduino-mbed-nano:4.4.1-libs3-r1`) | available | all but Serial1 RX (known gap) |
| Seeed XIAO nRF52840 | nRF52840, 64 MHz | Seeeduino:nrf52 1.1.13, Adafruit core (`fabwright/arduino-nrf52:1.1.13-libs3-r2`) | available | all of the above |

A board part (`packages/parts/src/parts/<type>`) says `availability: {status, reason}`: `planned`
boards show greyed out in the parts library with the reason, `search_parts` lists them apart, and
`place_part` refuses them with what, why and fix. The status only changes when
`packages/sim-backends/src/renode/boards.integration.test.ts` passes for the board.

Verified 2026-11-11 with Renode 1.17.0's native macOS build (`FABWRIGHT_RENODE_RUNTIME=native`). The
Docker image `fabwright/renode:1.17.0-r1` is the same Renode release and runs the same start script;
it could not be re-run that day because Docker Desktop on the test machine was failing (its disk
filled up and containerd reported I/O errors). The round-9 Blue Pill bridge test did pass through
the new bridge in Docker earlier the same day.

## How it works

```
Simulation ── McuBackend.step(cycles) ──► RenodeBackend (TS, synchronous)
                                            │ SyncBridgeLink (worker thread + Atomics.wait)
                                            ▼ one TCP socket, text lines, virtual-ns stamps
                          Renode process ── FabwrightBridge.cs (compiled into Renode at start)
```

`step()` sends `R <ns>`; Renode runs (`EmulationManager.RunFor`) and the bridge sends every event
in emulation order, then `T <ns>` when parked. Everything is time-stamped to the instruction (the
time source only moves every 100 µs quantum; the bridge adds the instructions executed since, at
one instruction per core clock cycle: `PerformanceInMips` = the board clock).

| Signal | How it crosses | Notes |
| --- | --- | --- |
| GPIO out | `G <pin> <level> <o/i> <ns>` from a state hook on every board pin | direction from the port's config writes (F1 CRL/CRH, F4 MODER, nRF DIR / PIN_CNF), so `pinMode` shows even without a level change |
| GPIO in | `I <gpio> <pin> <level>` between steps | applied again after the firmware reconfigures that pin (pull-ups), through the other level on F1 / nRF so the first edge reaches EXTI / GPIOTE |
| Pin interrupts | the chip's own EXTI / GPIOTE models | F4: Fabwright's SYSCFG model muxes ports into EXTI by EXTICR |
| UART | `U <id> <ns> <byte>` per byte; `X` into RX | the board's console UART is `Serial` |
| I2C | Renode's controller + a `FabwrightI2cTarget` per address the project's parts answer (`IW` one way, `IR` waits for `D`) | XIAO: Fabwright's TWIM model asks every address ACK (`IC` → `K`), so NACKs and scanners are real |
| SPI | a `FabwrightSpiTarget` (or the XIAO's SPIM model); `SX` waits for MISO, `SW` one way | one way when no wired device drives MISO (display modules), which keeps screens fast |
| ADC | `A <adc> <ch> <mV>` | F1: Fabwright's ADC model; F4: Renode's STM32_ADC fed by Fabwright; nRF52: Fabwright's SAADC model (gain, reference, resolution as configured) |
| PWM | STM32: the timers' outputs reach the pins in Renode's platform, so they are GPIO edges; nRF52: Fabwright's PWM model reports `P <pin> <period> <high>` and the backend draws the edges | |

Boards are data (`packages/sim-backends/src/renode/boards.ts`): platform file, C# models, console
UART, pin map, ADC channels, Wire / SPI controllers, vector table, boot quirks. The platform files
and models are in `packages/sim-backends/src/renode/platforms`.

Firmware is Intel HEX for every board (what Fabwright keeps for every build); the board says where the
vector table is. Boot details that matter:

- STM32F1 has no RCC model in Renode: Fabwright's minimal RCC / FLASH (round 9) and a DWT cycle
  counter (STM32duino and Mbed busy-wait on `DWT->CYCCNT`).
- Nano 33 BLE: the app is linked at 0x10000 behind Arduino's bootloader. Mbed writes the UICR and
  resets once, and Renode puts `VectorTableOffset` back to 0 on a reset, so the bridge copies the
  app's stack pointer and reset vector to address 0 (what the bootloader would do) and the UICR is
  a flash page that keeps writes across the reset.
- XIAO nRF52840: the Adafruit core needs Nordic's SoftDevice (it calls `sd_*` SVCs). The build image
  writes `<sketch>.ino.sim.hex` = MBR + S140 7.3.0 from the core's bootloader image (without the UF2
  bootloader and its UICR address) + the app; flash is filled with 0xFF first, so the MBR starts the
  SoftDevice, which starts the app, as on a board. FreeRTOS idles in WFE while the SoftDevice masks
  the app's interrupts; Renode does not wake WFE for a masked interrupt, so the bridge sets the CPU's
  event flag on every peripheral interrupt line (SEVONPEND behaviour).

`Serial` is USB CDC on both nRF52 boards. USB is not emulated, so the simulator build prints
`Serial` on `Serial1` (the UART Fabwright reads): Nano 33 BLE through a header the runner
force-includes, XIAO through a two-line prelude in front of the main `.ino` (`#line 1` keeps the
person's line numbers). The factory pack says to build the real board's firmware with its own core.

## Speed (1 ms steps, the Simulation's default)

| Board | Pin probe (idle loop) | Bus probe (I2C + SPI + PWM + ADC every 20 ms) | Start |
| --- | --- | --- | --- |
| Blue Pill | 0.87x | 0.67x | 2.7 s |
| Black Pill F411 | 0.96x | 0.48x | 2.5 s |
| Nucleo-F401RE | 0.97x | 0.55x | 2.5 s |
| Nano 33 BLE | 3.4x | 0.17x (mbed PWM edges and bus round trips) | 2.4 s |
| XIAO nRF52840 | 4.9x | n/m | 2.4 s |

Black Pill + SSD1306 (Adafruit library, a frame every 100 ms) through the full Simulation: 1.5 s of
device time in 4.5 s wall including the 2.5 s start. Start = process start + C# compile + platform +
firmware load + bridge connect, native Renode; Docker adds about 1.5 s (round 9).

## Not emulated or not working (said in each board's fidelity.json)

- **Bluetooth LE / the radio.** Renode 1.17 has an nRF52840 RADIO model, but Fabwright connects it to
  nothing: advertising, scanning and connections do nothing, and `BLE.begin()` /
  `Bluefruit.begin()` may fail. Not tried this round: two nRF52 machines on Renode's wireless medium.
- USB (CDC, HID, mass storage), NFC, QSPI flash, low-power modes and their currents.
- Nucleo-F401RE pin interrupts (the board stays planned); Nano 33 BLE Serial1 RX.
- STM32 I2C NACKs: an absent address costs about 130 ms of virtual time (Renode's STM32F1_I2C
  model with STM32duino's interrupt-driven HAL waits for its timeout), so a full I2C scan is slow.
- A part's reaction to an edge lands at the next step (no `stopAt` inside Renode's RunFor).
- Fast PWM is drawn edge by edge (the XIAO's default analogWrite is 62.5 kHz: 125 000 edges per
  second reach the Simulation).
- Other UARTs than the console, buses on non-default pins, DMA to parts.

## Running it

- Docker (default): build the image once, `docker build -t fabwright/renode:1.17.0-r1 toolchains/renode`.
  Errors say what is missing: Docker not installed / not answering / image missing, with the fix.
- Native: `FABWRIGHT_RENODE_RUNTIME=native FABWRIGHT_RENODE_BIN=/path/to/Renode.app/Contents/MacOS/renode`
  (the macOS build is not notarised; the platform files are copied into the run folder).
- Builds: the runner picks the image from the FQBN (`services/runner/src/config.ts` `PLATFORMS`) and
  builds it on first use. STM32duino has no linux/aarch64 tools, so its image is linux/amd64 and runs
  emulated on Apple silicon.
- In the web app, a Renode board runs in the `fabwright serve` session: Run on the followed page sends
  the session's `run` and the canvas shows that run (3 s of device time per press). A page without
  `fabwright serve` says so instead of failing.
- Tests: `packages/sim-backends/src/renode/backend.test.ts` (protocol, no Docker),
  `boards.integration.test.ts` and `packages/parts/src/renode.integration.test.ts` (skipped with
  the reason when Renode is not available), `apps/web/e2e/renode-board.spec.ts`. Fixtures:
  `node --import tsx scripts/build-renode-fixtures.ts` (needs Docker), see
  `packages/sim-backends/fixtures/BUILD.md`.

## Adding a board

1. Board data in `boards.ts` (platform, console, pins, ADC, buses, vector table).
2. A platform file in `platforms/` if Renode's needs changes (new peripheral models in C#).
3. A part folder with `availability: planned`, pin ids = the backend's.
4. Its pins in `fixtures/renode/pinprobe/pins.h` and `busprobe.ino`, build the fixtures, add it to
   the test's tables, run the integration test, then flip it to available with the evidence.
