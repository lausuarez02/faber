# PWM, pulses and time in the simulation

How `@fabwright/sim-core` handles `analogWrite()`, servo pulses and other fast signals, what parts
can rely on, and what it does not model.

## Measuring: `PwmMeter`

Every MCU GPIO gets a `PwmMeter` the first time it changes. The meter only sees the backend's
`onPinChange(pin, state, cycle)` events, so every number is exact to one CPU cycle (62.5 ns on a
16 MHz Uno) and never depends on wall-clock time or on how `runFor` is sliced.

| Reading (`PwmReading`) | Meaning |
| --- | --- |
| `duty` | HIGH time / period over the last complete period; the steady level (0/1) when not toggling |
| `highUs` | last complete HIGH pulse, rising → falling edge (µs) |
| `periodUs`, `freqHz` | last complete period, rising → rising edge |
| `averaged` | the signal is fast (period < 5 ms, ≥ 200 Hz) and the circuit is solved on its duty, see below |
| `level`, `sinceEdgeUs` | current level, time since the last edge |
| `source` | `"mcu:D5"`, or the id of a driver part that declared it |

Parts read it with `ctx.pwm(pinId)` (the reading of the net that pin is on), agents and tests with
`sim.pwm(partId, pinId)`. Example: `sim.pwm("servo1", "SIG")` → `{ highUs: 1500, periodUs: 20000, averaged: false, … }`.

## Solving: per edge or duty-averaged

* **Slow signals** (period ≥ 5 ms: servo pulses at 50 Hz, software blinking, `digitalWrite`) are
  solved on every edge, as before. A servo reads its pulse width from the meter at the falling edge.
* **Fast PWM** (`analogWrite`: 490 Hz on D3/D9/D10/D11, 976.6 Hz on D5/D6) switches to averaged
  mode after three periods. Edges are still traced and emitted, but they no longer trigger a
  solve. Instead, whenever anything else needs a solve, the Simulation solves the circuit once
  with every averaged pin LOW (`base`) and once per averaged pin with only that pin HIGH (`ri`),
  and hands parts `base + Σ dutyᵢ · (ri − base)` for every voltage and current.
  * For a linear network this is exactly the time average (superposition).
  * For a nonlinear element driven by one PWM pin (an LED behind a resistor) it is also exact,
    because the element is either in the HIGH or the LOW configuration. Measured: `analogWrite(5,
    170)` → LED at 66.4 % of its 12 mA on-current.
  * A nonlinear element fed by several PWM pins at once is approximate.
  * Cost: n + 1 solves when something changes, 0 while the duty is steady. The rover (2 PWM pins
    at 976.6 Hz, ~3900 edges/s) runs ~2.5× real time in Node with motors, sonar and physics.
* The circuit is re-solved when a measured duty moves by more than 0.4 % (`PWM_DUTY_EPSILON`).
* When an averaged pin stops toggling (`analogWrite(pin, 0)`/`255` become plain `digitalWrite`),
  the 1 ms tick notices after 3 periods (≤ 6 ms) and falls back to per-edge solving.

### Logic parts: declare the duty downstream

Averaging cannot flow through a part's logic (an H-bridge reads ENA in `onSolved` and switches its
outputs in the next `stamp`). So a driver reads its inputs' duty with `ctx.pwm("ENA")` and
declares the result on its outputs with `ctx.setPwm("OUT1", { duty, freqHz })`. A DC motor on
that net reads it with `ctx.pwm("A")` and stamps a duty-averaged winding (continuous current:
`I = (duty·V_on − Ke·ω)/R`, battery current `duty·I`). This is how `l298n` + `dc-motor` give
speed ≈ duty × full speed.

## Time hooks for parts

| Hook | Use |
| --- | --- |
| `PartModel.tick(tMs, dtMs)` | called every `TICK_MS` (1 ms) at fixed cycles (`k · 16000` on an Uno): motor inertia, servo slew |
| `ctx.schedule(delayMs, cb)` | one event at an exact cycle; when called during an MCU step, the step is cut short (`McuBackend.stopAt`) so firmware polling the pin sees the change on time (HC-SR04 ECHO for `pulseIn`) |
| `sim.every(periodMs, cb)` | host-level periodic callback at fixed cycles, survives `reset()` (the physics world steps here) |
| `sim.interact(id, e, { solve: false })` | feed a value a part only reads in its own logic (sonar distance) without a re-solve |

All of them are deterministic: same project + inputs give the same trace whatever the frame slicing
(tested in `pwm.test.ts` and in the rover integration test, which also matches between Node and
Chromium to the last bit).

## Fidelity and known gaps

* **Timer edge timing (avr8js).** Fast-PWM HIGH time is `OCRnx` timer ticks, the datasheet says
  `OCRnx + 1`: `analogWrite(5, 170)` measures 170/256 instead of 171/256, a Timer1 servo pulse of
  OCR1A = 2922 measures 1461 µs instead of 1461.5 µs. Below any visible effect, documented here.
* **`pulseIn()` reads about 0.6 % short on avr8js** (1159 µs for a 1164.8 µs echo, 17370 for
  17471). Its loop is calibrated at 16 cycles per iteration; the emulated loop takes slightly
  longer. With `µs / 58` this can make a sketch read 1 cm less than the true distance.
* PWM ripple is not simulated: an RC filter on a PWM pin shows the mean, never the ripple.
* Driver switching delays and PWM frequency limits are not modelled (an L298N struggles above
  ~25 kHz on hardware).
* Duty changes take effect at the next complete period (one PWM period, ≤ 2 ms, of lag).
