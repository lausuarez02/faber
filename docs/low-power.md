# Low-power devices: deep sleep, always-on screens, lids and day counters (round 15)

A device that sits in a pocket for weeks, shows something all the time and counts what happens to
it (a lid opened, a button pressed) per day. Every piece below is general: any board, any screen of
these kinds, any object with a lid.

## Deep sleep, simulated

`esp_deep_sleep_start()` on an ESP32 / S3 / C3 now sleeps in the simulator:

- The simulation build links **JumperSleep** (`toolchains/arduino-esp32/libraries/JumperSleep`, MIT,
  simulation builds only; the device build uses ESP-IDF's sleep code unchanged). It wraps the sleep
  API at link time: the timer (`esp_sleep_enable_timer_wakeup`, `esp_deep_sleep`), `ext0`, `ext1`
  and the C3's `esp_deep_sleep_enable_gpio_wakeup`.
- When the firmware sleeps, the shim saves what the chip keeps (every `RTC_DATA_ATTR` /
  `RTC_NOINIT_ATTR` variable and the system time) in a record in the last 8 KB of flash and prints
  one console line, `[jumper:sleep] {"mode":"deep","us":...,"pins":[{"gpio":3,"level":0}],"any":true,"src":"gpio"}`.
- The simulation (`packages/sim-core/src/sleep.ts`) stops running the firmware. Virtual time then
  jumps from one part event to the next (parts tick once a second), so **an hour passes in about a
  second**. The board's pins keep their configuration (the pull-up that holds a wake pin).
- It wakes on the timer, or as soon as a wake pin's net reaches its level (a reed switch closing, a
  button), writes the cause and the time slept into the record, and reboots the board with its
  flash kept. At boot the shim restores RTC memory, moves the clock on, and
  `esp_sleep_get_wakeup_cause()`, `esp_reset_reason()` (`ESP_RST_DEEPSLEEP`),
  `esp_sleep_get_ext1_wakeup_status()` and `esp_sleep_get_gpio_wakeup_status()` answer as on the chip.
- The board's state has `asleep`, `sleeps` and `wakes`: `{"expect_part": "xiao.asleep", "op": "==", "value": true}`.
  `reset_board` while it sleeps is a reset button (a plain boot).

Not emulated: the RTC slow clock's drift (the timer is exact), the ULP, touch wake-up, the boot time
after a wake, light sleep (runs as normal execution). AVR, RP2040, STM32 and nRF52 boards have no
sleep shim yet (the simulation side is general: a backend only has to print the line).

Proof: `packages/session/test/deep-sleep.integration.test.ts` (real arduino-esp32 firmware in QEMU on
a XIAO ESP32-C3: counts lid openings across deep sleeps, wakes on the pin and on a 1 h timer in about
a second of wall time; an e-paper face drawn over raw SPI survives the sleep).

## Always-on screens

| Part | What it is | Power | Simulated |
| --- | --- | --- | --- |
| `epaper-154-ssd1681` | 1.54 in 200 x 200 e-paper (GDEY0154D67, Waveshare V2) | ~8 mA for a 2 s full / 0.5 s partial refresh, 1 µA asleep, nothing to keep the image | the SSD1681 command set (RAM windows, entry modes, the two RAMs, update control, master activation, deep sleep), BUSY timing, partial refresh ghosting when the previous-image RAM is stale, the image staying without power |
| `sharp-memory-lcd-128` | Sharp LS013B7DH03, 1.28 in 128 x 128 memory-in-pixel LCD | about 2 µA for a still image, 17 µA writing | line writes, clear, VCOM frames, the active-high chip select (`spi-cs-high`), DISP, a warning when VCOM is not toggled about once a second |

Libraries: GxEPD2 (`GxEPD2_154_GDEY0154D67`) and Adafruit_EPD (`ThinkInk_154_Mono_D67`) drive the
e-paper, Adafruit_SharpMem the memory LCD. None of them is in Jumper's pinned library set yet
(GxEPD2 is GPL-3.0, so it would only ever be a build input of the person's firmware, as Adafruit
NeoPixel is); the protocol models are tested with raw SPI and with byte-exact benches. Diagnostics say
what went wrong: drawn but not refreshed, bytes sent while BUSY, a refresh with the panel supplies
off, asleep until a reset, ghosting, supplies left on.

## Lids and magnets

| Part | Draw | Output |
| --- | --- | --- |
| `reed-switch` | nothing (its pull-up draws VCC / R while closed) | contacts close above `pull_in_mT` |
| `hall-switch-drv5032` | 0.69 µA (FB) to 1.6 µA | LOW above B_OP, sampled at 5 or 20 Hz (the output latency), push-pull or open-drain per version |
| `bump-switch` (lever micro switch) | nothing | NO / NC contacts |

The magnet is the switch's props: `magnet_mm` (distance on the axis), `magnet_d_mm`, `magnet_t_mm`,
`magnet_grade` (N35 / N42 / N52 / ferrite); the field is that of an axially magnetised disc. The
state has `closes_at_mm` / `detects_at_mm` for the magnet you chose. In the UI: hold the reed switch
(magnet near = lid closed) or move the "Magnet distance" slider; in a test: `{"set": "lid.magnet", "value": "away"}`
(or `"near"`, or `{"set": "lid.magnet_mm", "value": 25}`), `press` / `release`.

Place the sensor next to the object it watches: the case's `held[].sensor` checks the gap
(`held-sensor`), see [enclosures.md](enclosures.md#things-the-case-holds-round-15).

## Days

- An RTC part (DS3231) now follows the test clock: a scenario's `clock` and `set_clock` set it as
  well as the sandbox's NTP, so `{"clock": "2026-11-13T23:59:57Z"}` then `{"expect_serial": "2026-11-14"}`
  tests a midnight rollover, with or without a network.
- Which RTC (round 17). The common ZS-042 DS3231 board (`ds3231-rtc`, 38 x 22 x 14 mm with its
  CR2032) has a power LED that draws about 2 mA, around 15 times the clock and in round 15's mood
  case 96 % of the battery: desolder it (and set prop `powerLed` false; `estimate_power` then drops
  it and says so), and remove its coin-cell charging diode or fit an LIR2032. Smaller and thinner:

  | Part | Size | Draw | Code |
  | --- | --- | --- | --- |
  | `ds3231-mini-rtc` | 14 x 14 x 12 mm (about 6 mm without its socket) | 0.11 mA | RTClib `RTC_DS3231`, same as the ZS-042 |
  | `rv3028-rtc` | 19 x 19 x 4 mm | 45 nA | plain Wire at 0x52 (the part's example); enable its backup switchover once |

  Both follow a scenario's `clock` and `set_clock`. The RV-3028 ships with the backup switchover off:
  the part says so (`rtc-backup-switchover-off`) until the firmware sets BSM.
- Flat cells for a thin case: `lipo-battery` capacity picks the cell (401730 and 402030 are 4 mm,
  502030 and 503035 5 mm, 603030 6 mm, 523450 5.2 mm; sizes and sources in
  `packages/parts/src/lib/lipoCells.ts`).
- The ESP32's own clock survives deep sleep (the shim moves it on by the time slept); it still has to
  be set once (NTP, an RTC, or a button sequence).

## Battery life in days

`estimate_power` / `set_power` take `wakes_per_day` and `awake_s`. Without them the wakes come from
the firmware's sleep timer (`esp_sleep_enable_timer_wakeup(3600ULL * 1000000ULL)` = 24 a day) or are
measured from the last run's deep sleeps. A board's own sleep current counts (`current_ma.standby_ua`
in part.json: XIAO ESP32-C3 44 µA, XIAO ESP32-S3 14 µA, Seeed's wiki), and a part with an event
(`current_ma.event_ms`, an e-paper refresh) draws its current per wake and microamps otherwise. The
answer has `days`. Datasheet typicals, not measured.
