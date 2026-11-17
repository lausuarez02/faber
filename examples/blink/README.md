# Blink

The classic first Arduino sketch, and Faber's M0 golden project.

| Part | Id | Notes |
| --- | --- | --- |
| Arduino Uno | `uno` | Runs `firmware/blink.hex` on an emulated ATmega328P (avr8js, 16 MHz). |
| Resistor | `r1` | 220 Ω. Limits the LED current to about 13 mA. |
| LED | `led1` | Red. |

Wiring: `uno.D13 → r1.1`, `r1.2 → led1.A` (anode), `led1.C` (cathode) `→ uno.GND.1`.

The sketch toggles D13 (`LED_BUILTIN`) every 1000 ms with `delay()` and prints `LED on` / `LED off` over serial at 115200 baud on each change. In Faber you should see the LED on for one second of virtual time, then off for one second. The pin and serial trace is the same on every run.

## Files

- `faber.json`: the project (see [docs/project-format.md](../../docs/project-format.md)).
- `firmware/blink/blink.ino`: the source (arduino-cli wants the sketch in a folder of the same name).
- `firmware/blink.hex`: the **golden** build, committed so that tests and the browser demo run without a toolchain. Rebuild it only on purpose, as described in [`firmware/BUILD.md`](firmware/BUILD.md), and commit the new hex together with the reason.

## What this example proves, and what it doesn't

It proves that real compiled AVR code runs, that GPIO drives the circuit solver, and that the LED's brightness comes from the actual current through it.

It does not exercise ADC, external interrupts, PWM, or any bus (I2C/SPI); later examples will. Its `Serial.println` output shows up in the web app's serial console.
