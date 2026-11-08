# Status: M0 Foundations

Last updated 2026-11-08. M0 is done: every item in the M0 scope works end to end and every check below is green locally.

<p align="center"><img src="docs/media/m0-blink.gif" alt="Blink running in Jumper" width="720"></p>

## What works

| Area | What you can do | Check it with |
| --- | --- | --- |
| Monorepo | pnpm 10 workspaces, TypeScript sources exported directly (no inter-package build), Node 24 | `pnpm i && pnpm typecheck` |
| Project format | `jumper.json` with a zod schema, readable errors (`wires[0].to.part: …`), stable git-friendly serialization, exported JSON Schema | `pnpm gen` writes `packages/project-format/jumper.schema.json` |
| Circuit solver | MNA DC solver in `@jumper/sim-core`: resistors, sources, piecewise-linear diodes, switches, floating-node detection; re-solves only when something changes | `pnpm vitest run packages/sim-core` |
| Deterministic clock | Virtual time is the MCU cycle count; same project gives the same trace hash whatever the frame slicing | `packages/sim-backends/src/simulation.integration.test.ts`, `packages/parts/src/blink.integration.test.ts` |
| AVR backend | avr8js ATmega328P (Uno and Nano pin maps), GPIO, UART, ADC, timers | `pnpm vitest run packages/sim-backends` |
| Golden firmware | Blink built with arduino-cli 1.5.1 + `arduino:avr@1.8.8` in Docker; byte-identical on arm64 and amd64; committed as `examples/blink/firmware/blink.hex` | `scripts/build-firmware.sh` (see `examples/blink/firmware/BUILD.md`) |
| Parts | 10 parts (Uno, Nano, LED, RGB LED, resistor, pushbutton, slide switch, potentiometer, photoresistor, buzzer), each with `part.json`, `model.ts`, `visual.svg`, `fidelity.json`, `model.test.ts`; codegen registry with a validator | `pnpm gen`, `pnpm --filter @jumper/parts gen:check` |
| Canvas | Pan, zoom, pinch, dot grid, snap, minimap; place from the library (click or drag); wire pin to pin; select, delete, rotate, recolour; undo/redo; inspector; light/dark theme; phone layout with a bottom sheet | `pnpm dev`, then open http://localhost:5173 |
| Live simulation | Blink opens by default. Run lights the LED and the board's L LED from the simulated current, HIGH wires glow, the serial console prints `LED on` / `LED off` | `pnpm test:e2e` (`e2e/blink.spec.ts`) |
| Brand | Logo, wordmark, favicon, social card, `brand/tokens.css` (dark-first, light theme, OS preference) | `brand/README.md` |
| CI | `.github/workflows/ci.yml`: install, generated files up to date, typecheck, unit tests, Playwright desktop + phone, report upload | Not run on GitHub yet (no remote); every step passes locally |

## Checks (local, 2026-11-08)

| Command | Result |
| --- | --- |
| `pnpm gen` | 10 parts written, schema written; `gen:check` reports "registry up to date" |
| `pnpm typecheck` | 0 errors (TypeScript 7.0.2) |
| `pnpm test` | 20 files, **158 tests passed**, 0 skipped, 0 todo. By package: parts 107, sim-core 25, project-format 11, sim-backends 10, web 5 |
| `pnpm test:e2e` | **13 passed**: 6 on desktop (1440×900), 6 on phone (iPhone 13 viewport, Chromium), plus the 200-part benchmark on desktop |

## Measured numbers

All measured on the dev Mac (Apple Silicon, 16 cores) while other work was running on it, so treat them as lower bounds.

| What | Number |
| --- | --- |
| Blink sim speed, Node 24, full `Simulation` with the real parts | **5.8× to 6.3× real time** (10 s of virtual time in 1.59 to 1.74 s, three runs) |
| Blink sim speed, browser main thread, speed set to 8× | **5.1× real time** (capped by the 12 ms per-frame budget) |
| Blink at 1× in the browser | holds **1.00× real time** |
| Canvas with 200 parts (Uno + 66 resistor/LED pairs on D13 + 67 other parts, 198 wires), idle | **60 fps** (p95 frame 16.8 ms) |
| Same canvas while Blink runs | **55 to 57 fps** (p50 16.7 ms, p95 16.8 to 33 ms, worst 50 ms at a blink edge, when 66 LEDs repaint and the 200-node circuit re-solves) |
| Determinism | identical trace hash for one 2.1 s run vs 131 frames of 16 ms; `timeMs` differs by less than 1 µs |
| Demo GIF | `docs/media/m0-blink.gif`, 1.0 MB, 5.7 s (still: `docs/media/m0-blink.png`) |

The benchmark is `apps/web/e2e/perf.spec.ts`; it writes `apps/web/test-results/perf.json`. The demo is re-recorded with `pnpm dev` and then `node apps/web/scripts/record-demo.mjs`.

## Known gaps (honest)

- **200 parts while running is just under 60 fps.** Idle is a steady 60. Frames drop at blink edges, when 66 LEDs repaint and the circuit re-solves on the main thread. The planned fix is moving the simulation into a Web Worker (it runs on the main thread in M0).
- **Browser sim speed tops out around 5× real time** because of the 12 ms per-frame budget on the main thread. A worker would raise it.
- **No SPI or TWI (I2C)** in the AVR backend. Sketches that use `Wire` or `SPI` will not work. This is M1 scope.
- **PWM is one pin change per edge**, so `analogWrite` costs one circuit solve per edge. It is correct but slow at high duty-cycle rates.
- **All ground pins share one node**, even the grounds of two boards that are not wired together.
- **Firmware is not built from the browser.** You load the committed `.hex` or open your own; building happens with `scripts/build-firmware.sh` (Docker).
- **CI has not run on GitHub** because there is no remote yet. Every step of `ci.yml` was run locally.
- **`RESET` and `AREF` are not wired to the emulated CPU.** The ADC always uses AVCC = 5 V as its reference.
- **Contact addresses are placeholders**: `conduct@jumper.dev (TBD)` in `CODE_OF_CONDUCT.md` and `security@jumper.dev (TBD)` in `SECURITY.md`.
- **The Contributor Covenant text was written from memory.** Check it against the official 2.1 text before publishing.

## Next: M1, real Arduino projects

From `docs/brief.md`:

1. arduino-cli builds in a container, triggered from the project (not only from the script).
2. Serial console: input (send to the board), baud rate handling and timestamps. Output already works.
3. I2C/SPI buses in the AVR backend, with bus-level parts.
4. 25 parts.
5. A scenario test runner (`scenarios` in `jumper.json`).
6. A CLI `test` command (`jumper test`).
7. A GitHub Action example.

Also carried over from M0: run the simulation in a Web Worker, publish the CI run once a remote exists.
