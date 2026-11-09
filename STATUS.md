# Status: agents, displays and robots (on top of M0)

Last updated 2026-11-09 (fourth pass: new UI, one-step connect, AI pet, Device view). M0 is done (below).
An agent (Claude Code, Codex, any MCP client) goes from a one-line goal to a wired, programmed and
tested device using only Jumper's tools, and a person watches it happen on the canvas and in 3D.

<p align="center"><img src="docs/media/m0-blink.gif" alt="Blink running in Jumper" width="720"></p>

## Round 3 (2026-11-09, fourth pass): UI v2, connect, AI pet, Device view

| Area | What you can do | Check it with |
| --- | --- | --- |
| UI v2 | Full-window canvas with floating containers: title block, top-right actions (Serial, Tests, Device view, Install MCP, Open in Agent, Run pill), left tool rail with the parts library, right panel column, minimap and status bottom-left, agent pill bottom-right; light theme; phone layout with a bottom bar and sheets. Spec: [docs/design/ui-v2.md](docs/design/ui-v2.md) | `e2e/*.spec.ts`, `node apps/web/scripts/ui-shots.mjs <url> <dir>` |
| One-step connect | `pnpm start` serves the canvas, `ws://…/live` and MCP over Streamable HTTP at `http://localhost:7780/mcp`, all on one session. **`claude mcp add --transport http jumper http://localhost:7780/mcp`** (verified with a real Claude Code 2.1.319 run: it placed, wired, wrote and ran Blink and the open canvas showed each step live, labelled "Claude Code"). Codex: `codex mcp add jumper --url http://localhost:7780/mcp`. Stdio clients: `jumper mcp --attach http://localhost:7780`. Local-only (Host/Origin checks) | `apps/cli/test/serve.test.ts`, `e2e/devices.spec.ts` (Install MCP) |
| AI pet | `examples/ai-pet`: Uno + ILI9341 colour TFT + ESP-01 on SoftwareSerial (AT firmware emulated bit by bit) + 3 buttons. The pet asks `http://ai.jumper/v1/pet` on the sandbox Wi-Fi and draws the reply in a speech bubble. Mock AI by default (deterministic); Live = `ANTHROPIC_API_KEY` or the logged-in `claude` CLI (a real Claude reply was shown on the simulated TFT). 5 scenarios. [Decision record](docs/decisions/0002-ai-pet.md) | `pnpm jumper test -p examples/ai-pet`, `packages/session/test/ai-pet-session.test.ts`, `e2e/devices.spec.ts` |
| Parts | 24 (was 21): `ili9341-tft`, `st7735-tft`, `esp01-wifi`, each tested with the real Adafruit library / AT sketch. Build image `jumper/arduino-cli:…-libs2`, runner `jumper/arduino-runner:…-libs2-r1` (adds Adafruit ILI9341 1.7.0, ST7735/ST7789 1.12.0; older sketches build byte-identical) | `pnpm --filter @jumper/parts gen:check` |
| Network tools | `set_ai_mode`, `read_network_log`, `run_live` (37 tools); `inject_fault wifi_drop` is real | `docs/mcp-tools.md` |
| Device view | The Device view button: the project as a physical device in 3D (react-three-fiber). Handheld with the live OLED or colour TFT behind glass, buttons that travel and drive the sim (keys 1-3); rover in an arena built from `jumper.json` with spinning wheels, sonar beam and trail (track / chase / arena cameras, F); arm on a table following the servos. 60 fps measured | `e2e/devices.spec.ts` (pet handheld, rover moving) |
| Visual tests | Tests panel: each scenario as a filmstrip of the device at every check with what the check saw; click a frame to open the 3D device at that exact moment (replayed from the recorded inputs). Fed by `GET /api/visual-report` (the server's latest `run_tests`) or the prebuilt `apps/web/public/reports/<example>.json`. `run_tests` returns `visual` lines per check and, with `images: true`, screen PNGs as MCP images | `packages/session/test/visual-capture.test.ts`, `apps/cli/test/serve.test.ts` |
| Pictures for agents | `screenshot` draws colour TFT pixels; `screenshot {"view": "device", "ms": 6000}` renders the 3D device (Playwright + Vite, about 5 s); CLI `jumper screenshot --view device`, `jumper render-device --ms … / --every … --until …` (frames for a video), `jumper test --visual`, `jumper network` | `packages/session/test/ai-pet-session.test.ts` |

The round-2 open items are fixed (each with a test in `packages/session/test/connect-polish.test.ts`):
press/`hold_ms` failures explain the hidden reaction; no false "already held 0 ms" warning;
timeouts suggest a `timeout_ms`; the compile hint names the real sketch folder; `run` returns
`world.first_collision`; the sonar trigger is no longer "servo-style"; every action-log line has
`actor`, `sid` and `client`, and `jumper replay` / `record` filter by them.

### Checks (round 3, local, 2026-11-09)

| Command | Result |
| --- | --- |
| `pnpm gen` | 24 parts, schema, `docs/mcp-tools.md` (37 tools); running it again changes nothing |
| `pnpm typecheck` | 0 errors |
| `pnpm test` | 69 files, **537 passed**, 2 skipped (live-AI tests, opt-in) |
| `pnpm test:e2e` | **39 passed, 4 skipped** (device-specific): desktop and phone each run Install MCP, AI pet TFT + mock reply bubble, Device view (pet handheld, rover driving), the visual Tests panel, plus every earlier test; the 200-part benchmark holds 60 fps |
| Real Claude Code over HTTP | `pnpm start`, then `claude -p … --mcp-config <{"mcpServers":{"jumper":{"type":"http","url":"http://localhost:7780/mcp"}}}> --strict-mcp-config --allowedTools mcp__jumper`: new project, LED + 220 Ω, 3 wires, Blink sketch, run; 18.6 s, 0 failed calls; the open canvas showed each step and "Connected: Claude Code"; serial `on/off` x3 |

### Known gaps (round 3)

- **Follow mode does not show colour TFT pixels:** the live link streams part states, and TFT frames
  are too big for them. Open `?example=ai-pet` (local simulation) to see the screen live, or use
  `screenshot` / the Device view render.
- **Live AI in the browser** needs the gateway running: `node services/ai-gateway/bin/ai-gateway.mjs`
  (port 8787), then the Network panel's Live switch. Live answers pause while the sim runs faster
  than real time.
- **The Network panel is desktop-only** (on phones it would cover the circuit); phones see the
  exchange in the serial console.
- **`screenshot {"view": "device"}` starts from 0 ms with no inputs** (presses made in the session
  are not replayed); fault steps cannot be replayed in the browser's scrub view yet.
- Claude Desktop and Cursor snippets in the Install MCP menu were not tested with those apps.

## Round 2 (2026-11-09)

| Area | What you can do | Check it with |
| --- | --- | --- |
| MCP server | `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project <dir>`: 34 tools, the recommended loop as server instructions, 3 resources, screenshots returned as images. Verified from outside the repo with Claude Code 2.1.319 (`--mcp-config`) and codex-cli 0.163.0 (`config.toml`) | `packages/mcp/test/mcp.test.ts`, [docs/agents.md](docs/agents.md) |
| CLI | `jumper` with every operation as a subcommand (`--json`), `call <tool>`, `mcp`, `serve` (add `--no-web` for the hub only), `replay`, `record`, `runner` | `apps/cli/test/cli.test.ts` |
| Build service | arduino-cli in Docker, content-hash cache, pinned libraries (Adafruit SSD1306/GFX/BusIO/BME280/MPU6050, RTClib, U8g2, LiquidCrystal_PCF8574, Servo…), compile errors as file:line with a fix | `services/runner/test/runner.test.ts` (Docker build byte-identical to the golden Blink) |
| Session engine | `packages/session`: validated, logged (`.jumper/actions.jsonl`), undoable steps grouped by "why"; design-rule checks; fidelity report; export; fault injection (`disconnect`, `noisy`, `i2c_nack`, `i2c_nack_data`, `i2c_garbage`; faults survive `run {reset: true}`) | `packages/session/test/*.test.ts` |
| Scenarios | `jumper.json` scenarios with press / set / serial / fault / expect_serial / expect_pin / expect_part steps; robots assert on `world.<field>` (collisions, min_clearance_cm, travelled_cm, pose, sonar_cm, gripper, reached) | `packages/session/test/examples.test.ts` runs every example's scenarios |
| I2C / SPI | AVR TWI with real SCL timing, SPI, bus faults, wiring errors that name the exact wire (`i2c-swapped`, `i2c-address-conflict`…) | `packages/sim-core/src/bus.test.ts`, `packages/sim-backends/src/twi.test.ts` |
| PWM | cycle-timed edges on every MCU pin (`sim.pwm(part, pin)`), duty-averaged solving for fast PWM, cycle-exact part events (`pulseIn` works) | `packages/sim-core/src/pwm.test.ts`, [PWM.md](packages/sim-core/PWM.md) |
| Parts | 21 (was 10): SSD1306 OLED, LCD1602 I2C, DS3231, BME280, MPU6050, SG90 servo, DC motor, L298N, HC-SR04, battery pack, 2WD chassis. Each bus part is tested with real compiled firmware and a real Arduino library | `pnpm --filter @jumper/parts gen:check` |
| Physics | `packages/physics`: Rapier 2D rover (motors → wheels, sonar raycast, IMU feed), arm kinematics, stepped every 4 ms on the CPU clock (deterministic: Node and Chromium agree to the last digit) | `packages/physics/src/*.test.ts` |
| Web app | Open any example from the project menu or `?example=tamagotchi` / `rover` / `robot-arm`; OLED and LCD pixels drawn live on the part; a World panel (arena top view or arm side view) for projects with a world; follow mode (`?follow=ws://…`) and replay mode (`?replay=<log>`) | `e2e/robots.spec.ts`, `e2e/follow.spec.ts`, `e2e/live.spec.ts` |
| Headless screenshot | PNG of the canvas with lit LEDs, OLED pixels and, for robots, the arena / arm panel drawn by the same painters as the web app | `packages/session/test/examples.test.ts` |
| Examples | `examples/tamagotchi` (6 scenarios), `examples/rover` (2), `examples/robot-arm` (2), each with golden firmware and a video in `media/` | `pnpm jumper test -p examples/<name>` |
| Agent runs | Round 2 (after the fixes below): Claude Code built the tamagotchi (8/8 tests, 6 min) and the record-and-playback arm (6/6, 2 min), Codex the rover (2/2, 109 s, 0 failed calls), each with only the MCP tools. The projects are kept as the agents left them, with prompts, numbers and 1440x900 replay videos; round 1 is in `docs/media/agent-runs` | [examples/agent-built](examples/agent-built/README.md), `packages/session/test/examples.test.ts` ("agent-built examples") |

### Videos and agent-built examples (2026-11-09, third pass)

| What | Where |
| --- | --- |
| Agent replays, 1440x900 H.264 + GIF: parts appear with the agent's cursor and "why" captions, wires draw, the firmware card, the device running (OLED pet, rover in the arena view, arm side view), tests turning green, ending on a new **fidelity card** (area levels and the first real-device checks) | `docs/media/agent-claude-tamagotchi.mp4` (44 s), `agent-codex-rover.mp4` (37 s), `agent-claude-robot-arm.mp4` (35 s); recorded with `jumper record <log> --speed 2 --size 1440x900` from the agent-only lines of each log, cut at the agent's `fidelity_report` |
| Reference examples running in the web app (feed / play / sleep / neglect on the OLED; the rover 48 virtual seconds at 2x; both knobs swept and the cup reached) | `docs/media/example-{tamagotchi,rover,robot-arm}.mp4` (32 / 25 / 24 s), re-record with `node apps/web/scripts/record-examples.mjs` while `pnpm dev` runs |
| The three agent-built projects, unedited, with README (exact prompt, agent and flags, numbers, what a person verified, fidelity, friction) and the agent-only action log | `examples/agent-built/{claude-tamagotchi,codex-rover,claude-robot-arm}` |
| Replay layout: with a World card the steps list stops above it, the caption moves under the replay bar, and the arena stats line wraps instead of being cut off | `apps/web/src/live/live.css`, `packages/physics/src/paint.ts` (test in `physics.test.tsx`) |

Re-checked on the current `main`: `jumper check`, `test`, `fidelity` on a copy of each agent-built
folder. Tamagotchi 8/8 (1 false-alarm warning, below), rover 2/2, arm 6/6; the arm now gets the new
power-budget warning (two servos on the Uno 5V), as intended.

### Open from the round-2 agent runs (fixed in round 3, see above)

- A `press` step hides reactions shorter than `hold_ms`; the failure message does not say so.
- The "already held 0 ms after press" warning fires even when an earlier step proved the opposite
  value (`examples/agent-built/claude-tamagotchi`, `feed-lowers-hunger`).
- The scenario timeout error has no fix hint; the auto-prototype compile hint says
  `firmware/<sketch folder>/types.h` instead of the real path.
- `run` gives collision totals but no `first_collision` (time, pose, wall); the sonar trigger pulse is
  labelled `(servo-style)`.
- The action log has no session or source per line, so a person's CLI checks land in the agent's
  replay (the committed `agent-actions.jsonl` files keep only `actor: mcp` lines).
- Nothing tells an agent to accept its steps, so replays end with every step "pending".
- The power-budget fix text for servos suggests "the driver's 12V" as the supply pin.
- The round-2 runs were not repeated after the round-1 fixes landed in their final form; the arm run
  listed Claude Code's built-in tools (no `--disallowedTools`) though it called only Jumper's.

### Next (agents)

1. Fix the open round-2 items above (part-specific battery and motor hints first, since one could
   damage hardware), then run all three evals again in the strict setup and re-record.
2. Tag every action-log line with its session and source; `jumper record --actor mcp`.
3. Evaluate a device none of the examples cover (an LCD weather station, a line follower) to find
   friction the reference builds hide.

### Agent-eval fixes (2026-11-09, second pass)

Claude Code (tamagotchi, arm) and Codex (rover) each built their device with only the MCP tools.
Their friction is fixed at the tool, with a regression test each (`packages/session/test/agent-evals.test.ts`):

| Friction | Fix |
| --- | --- |
| 6 failed `write_scenario` calls guessing the regex shape | sibling / standalone `regex` is rewritten into `expect_serial` (reported as `normalized`); unknown keys list the allowed ones and show the nested form |
| `set_part_property battery.voltage` ignored after `run {reset}` | the simulation adopts the saved props (`adoptProps`); robot-world parts restart the sim; the result says which (`simulation`) |
| No way to test what a screen shows | `expect_display` (lit pixels in a region, or a golden frame saved with `read_display {save_as}`) |
| Tests hard-coded tick-dependent numbers | `expect_serial_value` (latest printed `name=value` with an op) |
| Every button told `-> uno.D2`, second servo / pot same pin | `typical_connections` names the next free pin of the same kind |
| Pull-up warnings while the sketch is still the template | an info reminder (`reminders` on connect) until the sketch is yours |
| Chassis "not wired" and USB power-budget false positives; no warning for two servos on 5V | pinless parts checked against the world; the budget counts only what the board's 5V rail feeds (servos moving, drivers' motors at stall) |
| `expect_part` failure without a fix hint; waits that held before the change | "checked once at t ms; add within_ms"; `run_tests` warns about 0 ms waits after an input |
| Arm got the rover's `set_world` hint; servo pins looked idle | per-world `next`; pins show `out pulse 50Hz 903us` / `out PWM … duty` |
| Rover scraped walls at 0.67 cm with passing tests | near-miss note under 2 cm; docs and hints suggest `min_clearance_cm >= 3` |
| CLI screenshot could not show a test's key moment | `screenshot {scenario, at_step}` / `--scenario --at-step` |
| Wires across parts and labels; replay cards over the OLED | orthogonal routing around parts (screenshot and canvas); replay fits the circuit into the space the cards leave |

### Checks (local, 2026-11-09)

| Command | Result |
| --- | --- |
| `pnpm gen` | 21 parts, schema and `docs/mcp-tools.md` written; running it again changes nothing; `gen:check` reports "registry up to date" |
| `pnpm typecheck` | 0 errors |
| `pnpm test` | 54 files, **452 tests passed** (including the three agent-built projects' own scenarios; Docker build tests run when Docker is up) |
| `pnpm test:e2e` | **27 passed, 4 skipped** (device-specific tests on the other device): desktop and phone each run the tamagotchi OLED test, the rover World view test, CLI-driven live follow and replay, plus the M0 tests; the 200-part benchmark still holds 60 fps |
| Outsider smoke test | From a folder outside the repo: `jumper new`, `place`, `connect`, `check`, `write`, `build` (including a compile error with its fix hint), `run`, `test`, `screenshot`; then an MCP SDK client driving a pet build (I2C wired swapped on purpose, fixed from the error text, OLED read back, button click, fault injection, screenshot): 0 failed calls |

### Measured numbers (this round)

| What | Number |
| --- | --- |
| Tamagotchi (heavy I2C traffic), Node | about **2.7× real time** |
| Rover with physics, Node | about **2.5× real time**; 30 s run: 0 collisions, 13.2 m, closest gap 7.47 cm |
| Blink through the MCP server | 5 to 6.8× real time |
| Cached firmware build | about 1 ms; a fresh Blink-sized build about 0.7 to 3 s with a warm image |

### Known gaps (this round)

- **Faults not simulated yet:** brownout, clock drift, flash full (the tool says so). Wi-Fi drop is simulated since round 3.
- **Sonar cone is ±15°** (not ±7.5°), `pulseIn()` reads about 0.6 % short on the emulated chip, wheels do not load the motors, and the motor model assumes continuous current. All in the fidelity files.
- **Servo library** is in the agents' build image (`jumper/arduino-runner:…-r1`, Servo 1.3.0) but not in `toolchains/arduino` (the examples' golden builds); the arm example drives Timer1 directly.
- **The CLI is one process per command**, so simulation state does not carry over between `jumper run` calls (`jumper screenshot --ms N` runs first). The MCP server keeps state.
- **The web app does not build firmware**; it loads the examples' committed hex. Agents build through the CLI / MCP server (Docker).
- **The browser World panel** shows the local simulation and follow / replay; the screenshot only shows the world after a `run` in the same session.
- **`ir-obstacle` and `ws2812`** parts were not done.
- **Videos** add about 38 MB to the repo (`docs/media/agent-runs` 12 MB, `docs/media/agent-*` and `example-*` 23 MB of MP4 and GIF, the agent-built action logs 3 MB); move them to a release or LFS before publishing if size matters.
- **CI** has still not run on GitHub (no remote). The Docker build tests skip when Docker is not available.

# M0 Foundations (2026-11-08)

## What works (M0)

| Area | What you can do | Check it with |
| --- | --- | --- |
| Monorepo | pnpm 10 workspaces, TypeScript sources exported directly (no inter-package build), Node 24 | `pnpm i && pnpm typecheck` |
| Project format | `jumper.json` with a zod schema, readable errors (`wires[0].to.part: …`), stable git-friendly serialization, exported JSON Schema | `pnpm gen` writes `packages/project-format/jumper.schema.json` |
| Circuit solver | MNA DC solver in `@jumper/sim-core`: resistors, sources, piecewise-linear diodes, switches, floating-node detection (a wired input with nothing driving it gets a `floating-input` warning); re-solves only when something changes | `pnpm vitest run packages/sim-core` |
| Deterministic clock | Virtual time is the MCU cycle count; same project gives the same trace hash whatever the frame slicing | `packages/sim-backends/src/simulation.integration.test.ts`, `packages/parts/src/blink.integration.test.ts` |
| AVR backend | avr8js ATmega328P (Uno and Nano pin maps), GPIO, UART, ADC, timers | `pnpm vitest run packages/sim-backends` |
| Golden firmware | Blink built with arduino-cli 1.5.1 + `arduino:avr@1.8.8` in Docker; byte-identical on arm64 and amd64; committed as `examples/blink/firmware/blink.hex` | `scripts/build-firmware.sh` (see `examples/blink/firmware/BUILD.md`) |
| Parts | 10 parts (Uno, Nano, LED, RGB LED, resistor, pushbutton, slide switch, potentiometer, photoresistor, buzzer), each with `part.json`, `model.ts`, `visual.svg`, `fidelity.json`, `model.test.ts`; codegen registry with a validator | `pnpm gen`, `pnpm --filter @jumper/parts gen:check` |
| Canvas | Pan, zoom, pinch, dot grid, snap, minimap; place from the library (click or drag); wire pin to pin; select, delete, rotate, recolour; undo/redo (top bar and keyboard on desktop, the bottom dock on phones); inspector; light/dark theme; phone layout with a bottom sheet | `pnpm test:e2e` (`e2e/viewport.spec.ts`, `e2e/wire.spec.ts`, `e2e/app.spec.ts`) |
| Live simulation | Blink opens by default. Run lights the LED and the board's L LED from the simulated current, HIGH wires glow, the serial console prints `LED on` / `LED off` | `pnpm test:e2e` (`e2e/blink.spec.ts`) |
| Brand | Logo, wordmark, favicon, social card, `brand/tokens.css` (dark-first, light theme, OS preference) | `brand/README.md` |
| CI | `.github/workflows/ci.yml`: install, generated files up to date, typecheck, unit tests, Playwright desktop + phone, report upload | Not run on GitHub yet (no remote); every step passes locally |

## Checks (M0, local, 2026-11-08)

| Command | Result |
| --- | --- |
| `pnpm gen` | 10 parts written, schema written; `gen:check` reports "registry up to date" |
| `pnpm typecheck` | 0 errors (TypeScript 7.0.2) |
| `pnpm test` | 21 files, **178 tests passed**, 0 skipped, 0 todo. By package: parts 126 (including the fidelity-vs-backend cross-check), sim-core 26, project-format 11, sim-backends 10, web 5 |
| `pnpm test:e2e` | **17 passed, 4 skipped** (the skips are device-specific tests on the other device): 8 on desktop (1440×900), 8 on phone (iPhone 13 viewport, Chromium), plus the 200-part benchmark, which runs last and alone in full Chromium with the GPU and gates the 60 fps bar (≥ 58 fps and p95 ≤ 17.5 ms, idle and running; CI without a GPU uses a 30 fps / 50 ms floor). Run three times in a row: green each time |

## Measured numbers (M0)

All measured on the dev Mac (Apple Silicon, 16 cores) while other work was running on it, so treat them as lower bounds.

| What | Number |
| --- | --- |
| Blink sim speed, Node 24, full `Simulation` with the real parts | **5.8× to 6.3× real time** (10 s of virtual time in 1.59 to 1.74 s, three runs) |
| Blink sim speed, browser main thread, speed set to 4× | holds **4.00× real time** |
| Blink sim speed, browser main thread, speed set to 8× (labelled `8× max`, best effort) | **4.9× real time** (capped by the 12 ms per-frame budget) |
| Blink at 1× in the browser | holds **1.00× real time** |
| Canvas with 200 parts (Uno + 66 resistor/LED pairs on D13 + 67 other parts, 198 wires), idle | **60 fps** (p95 frame 16.8 ms), three runs |
| Same canvas while Blink runs | **59.2 to 60.0 fps** (p50 16.7 ms, p95 16.7 to 16.8 ms, worst frame 16.8 to 50 ms), three runs. Before the fix: 55 to 57 fps, p95 33 ms |
| Simulation JS per frame at 1× with 200 parts | about **3 ms** (p95 3.6 ms); the rest of the frame is free |
| Determinism | identical trace hash for one 2.1 s run vs 131 frames of 16 ms; `timeMs` differs by less than 1 µs |
| Demo GIF | `docs/media/m0-blink.gif`, 1.0 MB, 5.7 s (still: `docs/media/m0-blink.png`) |

The benchmark is `apps/web/e2e/perf.spec.ts`; it writes `apps/web/test-results/perf.json`, including the GPU it ran on. What was costing frames was not the simulation (about 3 ms of JS per frame) but rendering: the clock re-rendered React every frame, and the flowing-dash animation on 132 HIGH wires made the browser re-rasterize every frame. The clock is now written straight to the DOM, and past 32 live wires the dashes hold still while the wires keep glowing. The old benchmark ran in the headless shell, which composites in software; that measured the CPU rasterizer (about 45 to 55 fps whatever the app did), not what a person with a GPU sees. The demo is re-recorded with `pnpm dev` and then `node apps/web/scripts/record-demo.mjs`.

## Known gaps (M0; some are fixed above)

- **The simulation still runs on the main thread.** It costs about 3 ms per frame at 1×, so the 60 fps bar holds, but a heavy sketch or a much bigger circuit would compete with rendering. Moving it into a Web Worker is planned for M1.
- **Browser sim speed is reliable up to 4×.** The `8× max` setting is best effort and reaches about 5× real time (Node manages about 6×), because of the 12 ms per-frame budget on the main thread. The clock always shows the real factor.
- **On machines without a GPU the 200-part canvas renders slower.** In software compositing (for example the Playwright headless shell, or a CI runner) it measures 45 to 55 fps. That is why CI only enforces a 30 fps floor.
- **With more than 32 HIGH wires at once the dashes stop flowing**; the wires still glow. This keeps the frame rate at 60.
- ~~No SPI or TWI (I2C)~~: done this round.
- **Floating inputs read LOW, not random.** The solver ties a node with no DC path to ground through 1 GΩ. A real pin would pick up noise. The board model raises a `floating-input` warning for any wired input with nothing driving it, and the fidelity cards list it, but the web app does not show part diagnostics yet.
- ~~PWM is one solve per edge~~: fast PWM is now solved on duty-averaged values.
- **All ground pins share one node**, even the grounds of two boards that are not wired together.
- **Firmware is not built from the browser.** You load the committed `.hex` or open your own; building happens with `scripts/build-firmware.sh` (Docker).
- **CI has not run on GitHub** because there is no remote yet. Every step of `ci.yml` was run locally.
- **`RESET` and `AREF` are not wired to the emulated CPU.** The ADC always uses AVCC = 5 V as its reference.
- **Contact addresses are placeholders**: `conduct@jumper.dev (TBD)` in `CODE_OF_CONDUCT.md` and `security@jumper.dev (TBD)` in `SECURITY.md`.
- **The Contributor Covenant text was written from memory.** Check it against the official 2.1 text before publishing.

## Next

1. Serial input from the browser console (send to the board), baud handling and timestamps.
2. Build firmware from the web app (call the runner service), so a person can edit code on the canvas.
3. A built-in agent panel in the web app on top of the same session operations.
4. Run the simulation in a Web Worker (raises the browser speed ceiling above about 5×).
5. More parts (`ir-obstacle`, `ws2812`, keypad), a GitHub Action example running `jumper test`, and the first CI run once a remote exists.
