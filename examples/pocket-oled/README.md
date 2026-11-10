# Pocket OLED (XIAO RP2040)

A pocket board with a screen: the smallest board Jumper simulates driving a 0.96 in OLED.

| Part | Id | Notes |
| --- | --- | --- |
| Seeed XIAO RP2040 | `xiao` | Runs `firmware/main.hex`, a real arduino-pico 6.3.1 build, on rp2040js (133 MHz Cortex-M0+, Jumper's own boot ROM). |
| SSD1306 OLED 128x64 (I2C) | `oled` | Address 0x3C, powered from the XIAO's 3V3 pin. |

Wiring: `oled.SDA → xiao.GP6` (D4), `oled.SCL → xiao.GP7` (D5), `oled.VCC → xiao.3V3`, `oled.GND → xiao.GND.1`.
On the XIAO, `Wire` is I2C1 on D4/D5.

The sketch draws "Pocket", a frame counter and a bar whose length follows `20·sinf(frame / 4)`, every
250 ms, and prints `frame N bar L` on USB serial (`Serial` is the USB port on arduino-pico). The
scenario checks the fourth line (`frame 3 bar 77`) and that the screen is lit.

## Files

- `jumper.json`: the project.
- `firmware/main.ino`: the source (same as `packages/sim-backends/fixtures/xiao_oled/xiao_oled.ino`).
- `firmware/main.hex`: the golden build (Intel HEX, flash at 0x10000000), committed so tests and the
  browser run without Docker. Rebuild with `jumper build` (needs the `jumper/arduino-pico:6.3.1-libs3-r1`
  image, see [docs/rp2040.md](../../docs/rp2040.md)).

What the simulation does not check: see the board's fidelity notes (`jumper fidelity -p .`); core 1
and flash contents across a reset are not simulated.
