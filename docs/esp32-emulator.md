# ESP32-family boards in Faber: emulator spike (round 9)

Status: spike, prototype backend not wired into the UI. Measured 2026-11-11 on an Apple M4 Max
(16 cores, 48 GB), macOS 15 (Darwin 24.6), Docker Desktop with arm64 Linux containers.

## What runs it

| Piece | Version | Where |
| --- | --- | --- |
| Emulator | Espressif QEMU fork, tag `esp-develop-9.2.2-20260417` (QEMU 9.2.2) + `0001-faber-bridge.patch` | `toolchains/qemu-esp`, image `faber/qemu-esp:9.2.2-20260417-jb2` (216 MB, builds in ~45 s on this machine) |
| Machines | `qemu-system-xtensa -M esp32`, `-M esp32s3`; `qemu-system-riscv32 -M esp32c3` | |
| Build image | arduino-cli 1.5.1 + `esp32:esp32` 3.3.12 (ESP-IDF v5.5.5) + FaberEth | `toolchains/arduino-esp32`, image `faber/arduino-esp32:3.3.12-r2` |
| Backend | `@faber/sim-backends/qemu-esp` (`QemuEspBackend`, an `McuBackend`) | `packages/sim-backends/src/qemu-esp` |

QEMU is GPL-2.0, so it runs as its own process (container), never linked; see NOTICE. Docker was
chosen over Espressif's native macOS arm64 release because the bridge needs a patched build, and
one pinned Linux image runs the same on macOS, Linux and a server. A native build of the same tag
and patch is possible later (`runtime: "native"` in the launcher already builds that command line).

Flash image: the merged 4 MB image (`esptool merge-bin`: bootloader at 0x0 (S3/C3) or 0x1000
(ESP32), partitions 0x8000, boot_app0 0xe000, app 0x10000), padded to 2/4/8/16 MB, booted with
`-drive file=…,if=mtd,format=raw -snapshot` (the snapshot keeps the file read-only). arduino-esp32
3.x writes `<sketch>.ino.merged.bin` itself; the wrapper pads it. Build `FlashMode=dio`.

## The bridge (what the patch adds)

> Round 13: protocol version 6 (patch `0004-faber-i2s.patch`, tag `…-jb6`) adds the QEMU I2S device
> behind `ST` / `SR` (ESP32 I2S0/1 with their DMA, S3 I2S0/1 and C3 I2S0 through GDMA) and silent
> blocks as `z<nbytes>`; patch `0005-faber-eth-rx.patch` makes the OpenCores Ethernet hold an RX
> frame in QEMU's queue until the driver frees a descriptor (bursts delivered while the CPU is parked
> used to overflow its few RX buffers and cost the sender a 1 s retransmission). See
> `docs/esp32-peripherals.md` ("I2S").
>
> Round 13: the camera port (patch `0006-faber-camera.patch`; native tag `…-jb7` = 0001-0006) adds two
> blocking lines, `CC` (camera command) and `CD` (frame bytes), both answered with `Q`; nothing else
> changes. See [cameras.md](cameras.md#bridge-protocol-qemu-patch-0006).

> Round 10: protocol version 3 (patch `0002-faber-peripherals.patch`, image `…-jb3`) adds GPIO
> matrix routing (`M`/`N`), pin interrupts, LEDC (`L`), SPI (`SX`/`SQ`), RMT (`RM`), ADC (`E`/`AT`),
> UART1/2 (`V`/`B`/`X`), I2C bus index and S3/C3 controllers, watched-pin parks (`K`) and I2S lines
> (`ST`/`SR`, QEMU device not written yet). Full list: `packages/sim-backends/src/qemu-esp/protocol.ts`;
> status and fidelity: `docs/esp32-peripherals.md`. The version-2 lines below are unchanged.

Upstream, the ESP32 GPIO block is a stub (writes dropped, only the strap register reads back),
so nothing outside QEMU can see a pin. The patch makes `esp32.gpio` (and its S3/C3 subclasses)
a working block (OUT/ENABLE with W1TS/W1TC, both banks, IN = output when enabled, else the level
Faber drives) and gives it a `bridge` chardev. One text line per event:

```
QEMU → Faber   H faber-esp32-bridge 2 <type> sync=<0|1>
                G <out0> <out1> <en0> <en1> <ns>     pins changed (virtual ns)
                U <ns> <hex bytes>                   UART0 TX
                IS <addr> <r|w> <ns> / IW / IR / IP  I2C0 start / write / read / stop
                T <ns>                               lockstep: parked at the target
Faber → QEMU   I <gpio> <0|1>   W <hex bytes>   R <ns>   A <0|1>   D <hex>
```

`-global driver=esp32c3.gpio,property=bridge,value=jb` attaches it (the short `-global
esp32.gpio.bridge=` form does not work: QEMU splits the driver name at the first dot).

Lockstep: with `property=sync,value=on` and `-icount shift=3,align=off,sleep=off`, the GPIO block
parks QEMU at every target and reports `T`; Faber answers `R <next>`. Guest time is then a pure
function of executed instructions, inputs land at exact virtual times, and runs repeat bit for
bit. `QemuEspBackend.step()` stays synchronous like the AVR/RP2040 backends: a worker thread owns
the socket and the main thread blocks in `Atomics.wait` until QEMU parks (or asks an I2C question).

## Verified (real runs)

- Boot, all three chips, prebuilt and patched: Blink prints and toggles. Container start to
  first app line: ESP32 ~1.1 s (ROM + 2nd stage ~0.6 s), S3 ~0.26 s, C3 ~0.19 s.
- GPIO out seen outside, GPIO in driven from outside, all three chips (input → firmware →
  output round trip 2-5 ms free-running; exact in lockstep).
- UART0 over the bridge with virtual time stamps. (Plain `-serial stdio` prints nothing when
  stdin is not a terminal; `-nographic` / `mon:stdio` or a socket chardev work.)
- I2C on the ESP32: scan, write and read of a part living in Faber at 0x3C through the bridge,
  plus QEMU's built-in tmp105 at 0x48 (25.00 C). The S3/C3 machines have no I2C controller model.
- Determinism: lockstep runs of the same firmware and input script are identical (ns-exact) on
  ESP32, S3 and C3. Free-running `-icount … sleep=off` is exact on C3 but jitters by ~0.2 µs on
  the dual-core ESP32 when UART0 goes to a separate socket; `sleep=on` is not deterministic.
- Network: `-nic user,model=open_eth` (slirp NAT) + FaberEth: DHCP 10.0.2.15 in ~1.0 s virtual,
  HTTP GET to a server on the Mac (`host.docker.internal`) 13-96 ms, `http://example.com`
  34-122 ms, `https://example.com` (mbedTLS, insecure) 300-810 ms; works free-running and in
  lockstep, on all three chips.
- Tests: `pnpm vitest run packages/sim-backends/src/qemu-esp` (4 unit + 4 Docker integration
  tests; integration skipped without Docker or the image), ~18 s.

## Numbers

| Mode | ESP32 | ESP32-S3 | ESP32-C3 |
| --- | --- | --- | --- |
| Plain TCG (no icount), tight loop of 6 instructions, timed by the guest's own micros() | 4M iterations in 6.7 ms (~3.6 G instr/s, ~14× a 240 MHz chip at 1 IPC; guest time = host time) | 6.4 ms | 4.9 ms |
| `-icount shift=2` (250 MIPS virtual), free-running, CPU-bound | ~960 MIPS host → 3.9× real time | ~990 MIPS | ~1075 MIPS |
| `-icount shift=2,align=on` | paced to real time (93 rounds of 96.8 ms in ~9.5 s) | | |
| Lockstep, 1 ms quantum, Blink | 0.7× real time | 1.9× | 1.8-2.7× |
| Lockstep, 10 ms quantum, Blink | 0.8× | | 5.0× |
| Lockstep, 100 µs quantum | 0.22× | | 0.25× |
| TS backend, C3 fixture: 1 ms / 10 ms / 100 ms steps | | | 1.6-2.2 / 0.4-0.75 / 0.11-0.17 ms wall per virtual ms |
| TS backend `load()` (container start to parked at t=0) | | | 0.7-1.0 s |

One sync round trip through Docker Desktop's `host.docker.internal` costs ~0.4 ms; TCP `nodelay=on`
on the QEMU chardev cut the TS backend's 1 ms step from 2.5 to ~1.6-2.2 ms. Xtensa needs
`shift ≥ 2` (0 and 1 hang at boot).

## Does not work (yet)

- **WiFi / Bluetooth**: not emulated. `WiFi.mode(WIFI_STA)` aborts in `esp_phy_enable`
  (`phy_init.c:336`) on ESP32 and C3, reboot loop. Networking goes through the emulated Ethernet
  (FaberEth). Plan: a WiFi shim in the build (link-time wraps of `esp_wifi_*` that bring up the
  OpenCores MAC and post `WIFI_EVENT_STA_CONNECTED` / `IP_EVENT_STA_GOT_IP`, so unmodified
  `WiFi.begin()` + `HTTPClient` sketches work), not tried in this round.
- **I2S**: modelled since round 13 (jb6); see `docs/esp32-peripherals.md`.
- **Not bridged**: LEDC/PWM (modelled by QEMU on ESP32, levels not exported), RMT (NeoPixel),
  SPI peripherals (only flash/PSRAM), ADC, GPIO interrupts (`attachInterrupt`), pin matrix routing
  (a pin driven by a peripheral is not reported), deep sleep, touch.
- **ESP32 (classic) flake**: plain multi-threaded TCG panicked with "Cache disabled but cached
  memory region accessed" in 2 of ~20 runs, and in 5 of 5 with `-accel tcg,thread=single`; 0 in
  all `-icount` runs. Lockstep (icount) is the mode the backend uses.

## Recommended design for the ESP32 backend

1. **One process per board, lockstep over one socket.** Keep the patched QEMU in its own process
   (container by default, native optional). `-icount shift=3,sleep=off -rtc clock=vm`, sync on.
   Faber owns time, exactly as with avr8js / rp2040js: `step()` sends `R`, handles events until
   `T`. Default quantum = the Simulation's chunk (1 ms); raise to 5-10 ms when no part needs
   tighter timing, since every sync costs ~0.4 ms through Docker Desktop.
2. **Every peripheral the circuit can see goes over the bridge as a time-stamped event**, never
   through QEMU's own chardev/netdev side doors, so ordering and determinism hold. Order of work:
   GPIO interrupts + pin matrix (report which signal drives each pin) → LEDC duty → I2C on S3/C3
   (add the controller model) → SPI device bus (`SS <cs> <mosi> → <miso>`) → RMT → I2S → ADC.
   The bridge is QEMU-side C (~450 lines now); it should become a proper upstreamable device
   (`-device faber-bridge`) with a binary framing once the event set settles.
3. **Networking is generic, not voice-specific**: QEMU user-mode NAT (slirp) behind the OpenCores
   MAC gives the firmware real sockets, DNS, TLS and the internet; the host is reachable at
   `host.docker.internal` (Docker) or 10.0.2.2 (native). Next: the WiFi shim above, and
   per-board `hostfwd` / a Faber-side proxy so the canvas can show and fault-inject traffic.
   Network I/O is real time, so a sim with network is not bit-reproducible (everything else is).
4. **Board ids**: part.json `mcu.backend: "qemu-esp"`, `mcu.chip: esp32|esp32s3|esp32c3`, pin ids
   `GPIO<n>`, `cyclesPerSecond` = the chip's nominal clock (240 / 240 / 160 MHz) as a time base.
   Register it in `backendFactory` only on the server/CLI side (it needs Docker); the browser
   build keeps importing the main entry, which does not pull in the Node-only code
   (`@faber/sim-backends/qemu-esp` is a separate export).
5. **Builds**: `faber/arduino-esp32:3.3.12-r2` (6.5 GB, ~10-20 s per sketch cold) produces the
   merged image; the session build code should pick it by FQBN prefix `esp32:esp32:`.
