# ESP32-family peripherals in Jumper (round 10, track esp-periph)

Status 2026-11-11: **written, partly verified.** The QEMU side compiled into a dev image and the TS
side is tested against a scripted fake QEMU, but **no new peripheral has run real firmware yet**:
the host disk filled up mid-round, Docker Desktop's content store started returning I/O errors
(`blob sha256:… input/output error`) and the daemon then stopped answering, so the `jb3` image and
the fixture firmware could not be built or run. Every "real firmware" line below is therefore
**not verified**. Nothing about these peripherals may be shown as working in the UI until the
fixture tests listed at the end pass.

## Architecture (generic, any ESP chip)

- **QEMU (GPL-2.0, separate process):** `toolchains/qemu-esp/0002-jumper-peripherals.patch` on top
  of `0001` adds register-level models in `hw/misc/jumper_periph.c` and extends the GPIO block.
  Image tag when built: `jumper/qemu-esp:9.2.2-20260417-jb3` (`QEMU_ESP_IMAGE`).
- **Bridge protocol v3** (one text line per event, `protocol.ts`, `hw/gpio/esp32_gpio.c`): QEMU reports
  what each peripheral was told to do, with virtual time; Jumper draws the pin waveforms itself
  (`waveforms.ts`), so every existing part that decodes pin edges (servo, buzzer, WS2812, DFPlayer,
  ESP-01, GPS-style UART parts) works unchanged.
- **Lockstep:** the step target can now be moved earlier while QEMU waits for any answer (`R` is
  accepted at every blocking point) and pins a part watches (`ctx.watch` → `pinWatched` → `K`)
  park QEMU on every change, so `stopAt` works (HC-SR04-style parts, UART replies on time).
- **Additive API:** `McuBackend.attachI2s?`, `McuBackend.capabilities?`, `PartModel.i2s?`,
  `Simulation.i2s` (`I2sBus` in sim-core), `QemuEspBackend.onUart / writeUart / attachI2cBus /
  routeOf / dispose / stats / bridgeVersion`, `qemuPreflight()` (why / fix for Docker not running,
  image missing). Nothing existing changed shape.

## Per peripheral

| Peripheral | ESP32 | S3 | C3 | How | Unit-tested (fake QEMU) | Real firmware |
| --- | --- | --- | --- | --- | --- | --- |
| GPIO matrix routing | ✓ | ✓ | ✓ | `M` / `N` lines from FUNCn_OUT/IN_SEL | ✓ | not run |
| Pin interrupts (`attachInterrupt`) | ✓ | ✓ | ✓ | GPIO PINn int_type/int_ena, STATUS(+W1TC), PCPU/ACPU_INT, IRQ to the interrupt matrix; edge and level types | n/a (QEMU side) | not run |
| LEDC (`analogWrite`, `ledcWrite`, `tone`, servo 50 Hz) | 16 ch | 8 ch | 6 ch | `L` per channel: period / high / phase in ps from timer clock, divider, resolution, duty, hpoint; hardware fades stepped with `duty_chng_end` interrupt | ✓ (exact edges) | not run |
| I2C | 2 buses | 2 (new model) | 1 (new model) | ESP32 controller model reused with the S3/C3 opcode map (`v2`); bus index on `IS/IW/IR/IP`; repeated START no longer sent as STOP; QEMU's demo tmp105 at 0x48 removed when bridged | ✓ | not run |
| SPI master (SPI2 / SPI3, CPU mode W0–W15) | SPI2+3 | SPI2+3 | SPI2 | `SX` per transaction (command/address/data phases, bit order, duration from the SPI clock); MISO fetched lazily with `SQ` only when the firmware reads the buffer back (writes to displays never block); hardware CS0 drawn on its pin | ✓ | not run |
| RMT TX (NeoPixel / FastLED RMT) | 8 ch | 4 ch | 2 ch | channel RAM read at transmit time, ping-pong threshold interrupt, wrap, end marker, `tx_end`; `RM` symbols drawn as edges | ✓ (WS2812 bit timing) | not run |
| ADC (`analogRead`, `analogReadMilliVolts`) | SAR1+SAR2 (SENS) | SAR1+SAR2 (SENS) | APB_SARADC oneshot | pad voltage from the circuit (`E`), linear, full scale per attenuation (table below) | ✓ (`E` sent) | not run |
| UART1 / UART2 | UART1+2 | UART1+2 | UART1 | bytes `V` drawn as 8N1 frames at the configured baud (`B`, from CLKDIV and the clock source); frames a part drives on the RX pin decoded at the stop bit and fed in (`X`) | ✓ (both ways) | not run |
| I2S TX / RX (round 13, jb6) | I2S0+1, own lldesc DMA | I2S0+1 via GDMA | I2S0 via GDMA | `hw/misc/jumper_i2s.c` (patch 0004): `ST` frames out / `SR` frames in → `I2sBus`; rate from the clock registers; see "I2S" below | ✓ | **verified** (`esp-audio.integration.test.ts`, all three chips) |
| Touch | – | – | – | not bridged | – | not emulated |
| Wi-Fi / BT radio | – | – | – | not emulated (Ethernet MAC instead, round 9) | – | – |

ADC model (raw = mV × (2^bits − 1) / full-scale, clamped): ESP32 0 / 2.5 / 6 / 11 dB → 1100 /
1500 / 2200 / 3900 mV (datasheet nominal with Vref 1.1 V; real silicon is non-linear above ~2.5 V
and saturates near 3.1–3.3 V); S3 950 / 1250 / 1750 / 3100 mV; C3 750 / 1050 / 1300 / 2500 mV
(ESP-IDF measurable ranges). No noise, no non-linearity, no ADC2/Wi-Fi conflict.

Fidelity limits stated for the report: LEDC duty changes apply at the next period (the counter is
not modelled cycle by cycle); SPI and I2C transfer as transactions (no SCK / SDA edges on the
pins, which read idle); I2C transactions take no bus time; RMT loop mode and RX are not modelled;
UART TX FIFO empties instantly in QEMU (the frame timing on the pin is right, the firmware's
`availableForWrite` is optimistic); a part's reaction to a drawn edge (LEDC, RMT, UART TX) can only
stop the MCU at the next park, so it can be late by up to one step (1 ms by default).

## Fixtures written (sources committed, not built)

`packages/sim-backends/fixtures/esp32/` with `build.sh` (all three chips each):
`esp_io` (attachInterrupt, analogWrite, 50 Hz servo, tone, ADC on an ADC1 and an ADC2/second pin,
ledcFade), `esp_bus` (Wire scan / write / repeated-START read, Wire1, SPI 9F 00 00 + 100-byte
write, Serial1 9600 and Serial2 115200 loopback lines), `esp_neopixel` (8 WS2812 via Adafruit
NeoPixel). Pins per chip: `esp_pins.h`.

## To finish (in order)

1. Free host disk, restart Docker Desktop, build `jumper/qemu-esp:9.2.2-20260417-jb3`
   (`docker build -t … toolchains/qemu-esp`) and the fixtures (`fixtures/esp32/build.sh`).
2. Integration tests per fixture × chip (GPIO interrupt count, LEDC period/duty on the pin, servo
   pulse 1.5 → 2.0 ms, tone 2 kHz, ADC raw for known voltages, I2C on both buses, SPI MISO,
   UART loopback with a part, WS2812 colours via the ws2812-strip part); then the library-level
   ones with existing parts (SSD1306 / BME280 / MPU6050 on Wire, ILI9341 / ST7735 / GC9A01 on SPI,
   DFPlayer on Serial1).
3. ~~QEMU I2S device~~ done in round 13 (patch 0004, below).
4. Lockstep speed: profile the ESP32 (0.6–0.8× in round 9); candidates are the second core's idle
   loop under icount and the 1 kHz FreeRTOS tick on both cores. Not started.
5. Browser audio for `max98357a`: done in round 13 (each `run` keeps a WAV of the I2S stream, the
   followed page plays it with WebAudio, muted under test drivers). The browser mic into
   `inmp441.clip_b64` with permission: not started.

## I2S (round 13, track audio): emulated, verified on real firmware

`toolchains/qemu-esp/0004-jumper-i2s.patch` adds `hw/misc/jumper_i2s.c` (bridge v6, image / native
tag `9.2.2-20260417-jb6`). What it models, for ESP-IDF's `i2s_std` / `i2s_pdm` / `i2s_tdm` drivers
and arduino-esp32's `ESP_I2S` (`I2SClass`) on top of them:

| | ESP32 | ESP32-S3 | ESP32-C3 |
| --- | --- | --- | --- |
| Controllers | I2S0 (0x3FF4F000), I2S1 (0x3FF6D000), HW v1 | I2S0 (0x6000F000), I2S1 (0x6002D000), HW v2 | I2S0 (0x6002D000), HW v2 |
| DMA | the I2S block's own (OUT_LINK / IN_LINK, lldesc ring) with its OUT_EOF / IN_SUC_EOF interrupt | the GDMA channel whose PERI_SEL is I2S0 (3) / I2S1 (4); OUT_EOF / IN_SUC_EOF and the EOF descriptor address raised on that channel | same as the S3 |
| Sample rate | PLL_D2 160 MHz / (N + b/a) / BCK div / (2 × bits); APLL assumed at the requested rate | source (XTAL 40 / PLL 160 / PLL 240 MHz) / (N + fractional x,y,z,yn1) / (BCK div + 1) / (slot bits × slots) | same, PLL 160 MHz |
| Formats | 16 / 32-bit, mono or stereo (FIFO mode) | 8 / 16 / 24 / 32-bit, mono (copy), slot masks, TDM slots | same |
| PDM | RX (PDM-to-PCM, ÷64 or ÷128) and TX as PCM | RX (PDM-to-PCM: the XIAO ESP32-S3 Sense's mic, GPIO42 / 41) and TX (PCM-to-PDM) as PCM | raw PDM RX only on the chip: bit rate reported, data are PCM |

How a block moves: on TX start the device walks the descriptor ring; each descriptor takes
`length / (bytes × channels) / rate` of virtual time; when it has played its buffer is read (the
DMA reads progressively, so a firmware filling it just ahead of the DMA is heard in full), sent as
`ST <port> <ns> <rate> <bits> <chans> <hex>` (all-zero blocks as `z<nbytes>`), and the EOF interrupt
returns the buffer to the driver, which is what makes `i2s.write()` block at the sample rate. RX asks
Jumper for the block's frames (`SR …`, answered `Q <hex>` by the first source on the `I2sBus`, e.g.
the `inmp441` part), writes them into the descriptor, sets its length and SUC_EOF and interrupts.
Samples cross as 16-bit (2 bytes) or 24 / 32-bit (4 bytes, sign-extended) little-endian.

Verified (`services/runner/src/lang/esp-audio.integration.test.ts`, fixture `esp_audio` on all three
chips): `begin()` true; a 1 kHz sine at 16 kHz mono 16-bit with the right frequency (±1 %), length
and peak; `write()` returns every byte and blocks for as long as the samples take; `playWAV()` from
flash (440 Hz); 8, 22.05 and 44.1 kHz; 48 kHz stereo 32-bit with the right channel silent; a
microphone read (PDM on the S3, standard I2S elsewhere) returning the source's 500 Hz at its level.
`esp_mp3` (S3, built at test time): `playMP3()` decodes on the device and plays a 1 kHz tone.
`packages/device-net/test/audio-stream.integration.test.ts`: raw PCM (content-length) and a WAV
(chunked, uneven pieces) streamed from a mock API over HTTP into I2S, gap-free, the API's samples.
`packages/session/test/esp32-audio-session.test.ts`: XIAO ESP32-S3 + MAX98357A + 20 mm speaker
through the session (real build): the amp's level is the samples' RMS, the speaker sounds, the run's
recording is the 1 kHz tone. `apps/web/e2e/esp32-audio.spec.ts`: the same on the followed page.

Behaviour reproduced from the drivers, not emulator artefacts (asserted in the tests):
- after a ring ran dry, arduino-esp32's ESP32 (HW v1) mono path writes in 128-frame chunks and
  ESP-IDF gives each chunk a fresh DMA buffer while its queue is nearly full: the first buffer
  plays 128 frames then 112 of silence;
- `configureTX()` / `end()` right after `write()` cut what is still in the DMA ring (up to
  `dma_desc_num × dma_frame_num` = 1440 frames with ESP_I2S's defaults); the tail plays at the new
  rate when the channel starts again. Wait out the ring before reconfiguring.

Not modelled: BCK / WS / data pin edges (the pins are routed but idle), slave mode timing, ETM
start, A-law / u-law, bit order and byte swaps, the ESP32's 16-bit half-word order, the APLL's real
frequency, raw PDM bit streams, I2S interrupts other than the EOFs, TX "stop when FIFO empty". The
emulated CPU runs at 125 MIPS (`-icount shift=3`), slower than a 240 MHz ESP32 / S3: a sketch that
computes every sample (`sinf()` per sample) can underrun in the emulator where the chip might not;
a table (as the fixtures use) is cheap on both. The C3 has no FPU, so per-sample float math is slow
there on the chip as well (not measured on hardware).
