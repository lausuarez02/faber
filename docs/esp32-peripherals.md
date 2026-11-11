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
| I2S TX / RX | protocol + TS + parts only | same | same | `ST` / `SR` lines → `I2sBus`; **the QEMU I2S + DMA device is not written** (ESP32 lldesc DMA, S3/C3 GDMA) | ✓ (bus, parts) | **not emulated** |
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
3. QEMU I2S device (ESP32 I2S DMA with lldesc; S3/C3 through `esp_gdma`) emitting `ST` / `SR`.
4. Lockstep speed: profile the ESP32 (0.6–0.8× in round 9); candidates are the second core's idle
   loop under icount and the 1 kHz FreeRTOS tick on both cores. Not started.
5. Browser audio for `max98357a` (WebAudio from `I2sBus.onBlock`, muted under test drivers) and
   the browser mic into `inmp441.clip_b64` with permission. Not started.
