# Adding a board backend (draft)

A **backend** is the CPU emulator behind a board part. The simulator core (`@faber/sim-core`)
never talks to an emulator directly; it talks to the `McuBackend` interface, and
`@faber/sim-backends` maps a board's `part.json` `mcu` block to an implementation.

Today there is one: **avr8js** for the ATmega328P (Arduino Uno and Nano), in
`packages/sim-backends/src/avr.ts`. This page is what you need to add another (a different AVR,
an RP2040, an ESP32 via a WASM emulator, ...).

## 1. The contract

`McuBackend` lives in `packages/sim-core/src/mcu.ts`. The rules that matter:

- **Time is cycles.** `cycles` starts at 0 after `load()`/`reset()` and only goes up.
  `cyclesPerSecond` converts it to time. Never read `Date`, `performance.now`, timers or
  `Math.random`: the same firmware must produce the same trace on every machine.
- `step(n)` runs at least `n` cycles and may overshoot by one instruction (or one interrupt entry).
- `onPinChange(cb)` fires **synchronously inside `step()`**, with the cycle at which the change
  happened, whenever a pin's **mode** changes or an **output's level** changes.
- `setPinInput(pin, volts)` is how the circuit drives the chip. It must **not** fire
  `onPinChange` (the Simulation calls it after every solve; firing would loop). Threshold to a
  logic level and, for analog pins, feed the ADC.
- `onSerial(cb)` fires once per byte transmitted on the default UART, inside `step()`, cycle-stamped.
- `readPin` reports `mode` as `output` / `input` / `input_pullup` (from the direction and
  pull-up registers) or `analog` for analog-only pins.
- `pinIds` are the board's silkscreen names (`D13`, `A0`) and must equal the GPIO pin ids in
  the board's `part.json`.

## 2. Pin map

Put the board-name → chip mapping in data, like `src/pins.ts`:

| Uno / Nano pin | ATmega328P |
| --- | --- |
| D0–D7 | PD0–PD7 |
| D8–D13 | PB0–PB5 |
| A0–A5 | PC0–PC5 = ADC0–ADC5 |
| A6, A7 (Nano only) | ADC6, ADC7 (analog only, no GPIO) |

## 3. Implementation checklist (what the avr8js backend does)

1. **Load**: accept Intel HEX text (use `parseIntelHex` from sim-core) or a raw image; pad to
   flash size with `0xFF`; reset.
2. **Build the machine** on every reset: CPU, GPIO ports, timers, UART, ADC, clock prescaler,
   EEPROM, watchdog. Rebuilding is simpler and safer than resetting each peripheral by hand.
   Re-apply the voltages last set with `setPinInput` to the fresh chip (the outside circuit did not reset).
3. **Pin changes**: hook the emulator's port-write notifications; on each, recompute the state of
   every pin on that port and emit only real changes (outputs by level, inputs by mode).
   Use the pin's effective output, including timer compare-output overrides (PWM), not just PORT.
4. **Inputs**: datasheet thresholds with hysteresis (ATmega328P: low ≤ 0.3·VCC, high ≥ 0.6·VCC,
   in between keep the last level). ADC: channel value in volts, reference AVCC = `vcc`.
5. **Serial**: forward UART TX bytes with `cpu.cycles`; `writeSerial` feeds RX.
6. **Factory**: register the backend name in `backendFactory` (`src/index.ts`) and give readable
   errors for unknown backends/chips, naming the board part.

## 4. Firmware for tests

Golden firmware is built reproducibly with `scripts/build-firmware.sh <sketchDir> <fqbn> <outDir>`
(Docker image in `toolchains/arduino/`, pinned arduino-cli and core). Commit the `.hex`, record the
toolchain in the example's `firmware/BUILD.md`.

## 5. Tests every backend needs

See `packages/sim-backends/src/avr.test.ts` and `simulation.integration.test.ts`:

- **Golden timing**: Blink toggles at 1000 ms ± 1 ms, measured in cycles.
- **Golden serial**: exact byte sequence.
- **Determinism**: two runs, and different `step()` slicing, give the same trace hash.
- **Contract**: `setPinInput` never fires `onPinChange`; unknown pin ids throw readable errors.
- **Speed**: log simulated seconds per wall second (avr8js Blink: about 4.5x real time on an
  Apple Silicon laptop in Node 24).
- **Integration**: a `Simulation` with the board, a resistor and an LED; the LED current and the
  serial text come out right.

## 6. Known gaps of the avr8js backend (M0)

- No SPI/TWI (I2C) peripherals attached yet; sketches using `Wire`/`SPI` will hang or misbehave.
- No analog comparator, no sleep-mode power accounting, no brown-out.
- PWM (`analogWrite`) is reported as fast pin toggles, one `onPinChange` per edge; the circuit
  re-solves per edge. A duty-cycle view is future work.
- Only ATmega328P; ATmega2560 (Mega) needs a different pin map and port set (E–L).
