<p align="center">
  <img src="brand/wordmark.svg" alt="Fabwright" width="280">
</p>

<p align="center"><strong>Figma for hardware, with a real simulator underneath.</strong></p>

<p align="center"><sub>Formerly <strong>Jumper</strong>. Old projects, scripts and firmware keep working: see <a href="docs/migrating-from-jumper.md">migrating from Jumper</a>.</sub></p>

Fabwright is an open-source browser sandbox for electronics. You place parts on a canvas, wire their pins together, and run the real compiled firmware on an emulated microcontroller. The LED on the canvas lights up because the emulated ATmega328P set its pin high and a small circuit solver pushed current through the resistor and the LED. It is not a drawing of what should happen. Anything a person can do on the canvas, an AI agent will be able to do through the same tools.

**The promise, stated honestly.** If firmware crashes on real hardware, it should also crash in Fabwright. If it runs in Fabwright, it should run on the board, as far as the simulation can tell. Every part says what it simulates exactly, what it only approximates and what it does not simulate at all (see [fidelity](docs/fidelity.md)). Fabwright does not hide those gaps.

<p align="center"><img src="docs/media/hero.png" alt="Fabwright's canvas: an Uno, an ILI9341 colour screen showing the pet Pip with a speech bubble, an ESP-01 Wi-Fi module and three buttons, with the Network panel open on the right" width="900"></p>

## Watch Claude build it

Two unedited live runs (2026-11-09): Claude Code 2.1.319 connected to `pnpm start` over HTTP MCP,
allowed **only Fabwright's tools**, while a browser recorded the canvas the whole time. Each video goes
from the empty canvas through the build, then into the 3D Device view and the Tests filmstrips.

| | |
| --- | --- |
| <a href="docs/media/live-claude-ai-pet.mp4"><img src="docs/media/live-claude-ai-pet.gif" alt="Claude Code builds an AI tamagotchi on a colour screen; real Claude replies appear in its speech bubble in the 3D Device view" width="420"></a> | **AI tamagotchi with a screen.** Uno, ILI9341 colour TFT, ESP-01 Wi-Fi, TALK / FEED / PLAY, buzzer. TALK asks a language model over the sandbox Wi-Fi and shows the answer in a speech bubble; 5 mood faces, hunger and joy bars, an OFFLINE badge and retry when Wi-Fi drops. 9.6 min, $2.69, 98 tool calls (4 failed), 5/5 tests. In the Device view it answered with **real Claude replies** ("Tummy rumbles! Got any snacks for me?"). [Video](docs/media/live-claude-ai-pet.mp4) (90 s) · [project and numbers](examples/agent-built/claude-ai-pet/README.md) |
| <a href="docs/media/live-claude-robot.mp4"><img src="docs/media/live-claude-robot.gif" alt="Claude Code builds an exploring robot with an OLED face; it drives the 3D arena with zero collisions" width="420"></a> | **Exploring robot with a face.** Uno, L298N, 2 DC motors, HC-SR04 sonar, SSD1306 OLED face, 2S LiPo, 2WD chassis. Its first sketch hit obstacles 3 times; Claude saw it in the arena view and fixed it (dodge at 40 cm, weave). 4.6 min, $1.57, 66 tool calls (1 failed), 3/3 tests: 60 s with 0 collisions, 9 cm closest, faces checked pixel by pixel. [Video](docs/media/live-claude-robot.mp4) (90 s) · [project and numbers](examples/agent-built/claude-robot/README.md) |

## Try it

You need Node 24, pnpm 10 (`corepack enable`) and, for firmware builds, either `pnpm fabwright setup` (Fabwright installs its pinned toolchains and emulators natively under `~/.fabwright`, no Docker) or Docker Desktop running. See [docs/native-runtime.md](docs/native-runtime.md).

```sh
pnpm i
pnpm start      # canvas + live link + MCP on one port; prints the URL
```

1. Open the URL it prints (`http://localhost:7780/`, or the next free port). The canvas follows the
   project `projects/playground` live.
2. In another terminal, connect Claude Code (one step), then ask it for a device:
   ```sh
   claude mcp add --transport http fabwright http://localhost:7780/mcp
   claude "Use the fabwright tools to build a plant monitor: soil sensor, OLED, buzzer when it is dry. Write tests."
   ```
3. Watch the parts, wires, firmware and tests appear on the canvas. Press **Run** to run what Claude
   built right there (it also starts by itself after each agent build): press its buttons, turn its
   knobs, tilt its IMU, and open the 3D Device view.

To try the two devices above yourself, `pnpm start --project examples/agent-built/claude-ai-pet`
(or `claude-robot`) and open `http://localhost:7780/?local`. The click-by-click guide, with what to
expect and the known gaps, is [docs/try-it.md](docs/try-it.md).

## Earlier agent builds (replays)

Before the live recordings above, three runs (2026-11-09, stdio MCP) were replayed from the
session's own action log: parts appearing with the agent's "why" for each step, wires drawing, the
firmware, the device running, the scenario tests turning green and the fidelity report at the end.

| | |
| --- | --- |
| <img src="docs/media/agent-claude-tamagotchi.gif" alt="Claude Code builds a tamagotchi pet: OLED face, three buttons, buzzer; 8 of 8 tests pass" width="420"> | **Tamagotchi pet** by Claude Code: Uno, SSD1306 OLED, 3 buttons, buzzer. 6 minutes, 59 tool calls, 8/8 scenario tests (feed, play, neglect makes it sad and beep, sleep, the frown matches a saved OLED image, OLED unplugged). [Video](docs/media/agent-claude-tamagotchi.mp4) (44 s) · [project and numbers](examples/agent-built/claude-tamagotchi/README.md) |
| <img src="docs/media/agent-codex-rover.gif" alt="Codex builds an obstacle-avoiding rover that drives 30 s in the arena with zero collisions" width="420"> | **Obstacle-avoiding rover** by Codex (low reasoning effort): Uno, L298N, 2 DC motors, HC-SR04, battery, 2WD chassis. 109 s, 44 tool calls, 0 failed; 30 s in the arena with 0 collisions and a turn at every wall under 20 cm. [Video](docs/media/agent-codex-rover.mp4) (37 s) · [project and numbers](examples/agent-built/codex-rover/README.md) |
| <img src="docs/media/agent-claude-robot-arm.gif" alt="Claude Code builds a two-servo arm that records poses and plays them back" width="420"> | **Record-and-playback robot arm** by Claude Code: Uno, 2 SG90 servos, 2 knobs, REC and PLAY buttons. 2 minutes, $0.88, 0 failed calls, 6/6 tests (each knob moves its joint, playback visits each recorded pose). [Video](docs/media/agent-claude-robot-arm.mp4) (35 s) · [project and numbers](examples/agent-built/claude-robot-arm/README.md) |

Every run's friction (a wrong hint, a missing fix in an error) went back into the tools; what is
still open is listed in each project's README and in [STATUS.md](STATUS.md). The hand-written
reference builds, running in the web app:
[tamagotchi](docs/media/example-tamagotchi.mp4) · [rover](docs/media/example-rover.mp4) ·
[robot arm](docs/media/example-robot-arm.mp4) (GIFs next to them in `docs/media/`).

## From the simulation to a real device

When the person wants to hold it, the agent finishes with two more calls. `design_case` packs the
parts into a two-part printable case (rounded box, pill, pebble, puck or keychain; snap or M2
screws, lanyard tab, belt clip) and measures it: wall thickness, screen window, button travel, USB
access, overhangs, watertight STLs, and whether it fits a pocket. `export_manufacturing` writes one
folder and zip a 3D printer or a factory can work from:

- **Case:** STL per body, a coloured 3MF for slicers, STEP (shells plus the parts as named solids),
  renders, an A3 drawing with sizes and tolerances, and print settings per body.
- **Electronics:** BOM with MPNs and plain descriptions a supplier can quote from, wiring table,
  netlist (CSV and KiCad), wire cut lengths from the case layout.
- **Firmware:** hex / UF2 with the source and flashing steps.
- **Build and test:** numbered assembly steps with renders, a test plan, a short Chinese summary
  for suppliers, honest notes on what was only simulated, and a checksum manifest.

<p align="center"><img src="docs/media/case-muse-exploded.png" alt="The Pocket Muse's pebble case, exploded: front shell with the round screen window, the XIAO RP2040, LiPo, charger, slide switch and touch button inside, the switch lever through the top wall" width="560"></p>

The Pocket Muse ([example](examples/agent-built/claude-pocket-muse/)) runs from its LiPo through a
slide switch and a Schottky diode (USB unplugged, 11/11 tests, 0 design errors), and its pebble case
measures 70.7 × 94.3 × 19.6 mm (97 cm³, rounded in 3D with domed faces; "tight" for a pocket at
19.6 mm thick); a puck variant (72.7 × 72.7 × 25 mm) sits next to it. In the app, the **Case** button shows the case in 3D with see-through and explode sliders,
the checks, the downloads and **Factory pack (zip)**. The print, the plastic and the hand feel are
not tested. A case can also hold something that is not electronics (`enclosure.held`: a slot, pocket or
snap-in room sized to the object, with a lid sensor checked beside it), and devices that deep-sleep with
an e-paper or memory-LCD screen get battery life in days. Guide: [docs/enclosures.md](docs/enclosures.md); power: [docs/power.md](docs/power.md),
[docs/low-power.md](docs/low-power.md).

## Use Fabwright from your agent

One step: start Fabwright, then add it to your agent. The agent's calls appear on the canvas you are
watching, as it makes them.

```sh
pnpm i          # once, in this repo
pnpm fabwright setup   # once: native toolchains + emulators (or keep Docker Desktop running instead)
pnpm start      # = fabwright serve: canvas + live link + MCP at http://localhost:7780/mcp
```

`pnpm start` opens the canvas at `http://localhost:7780/` (next free port if 7780 is taken; it
prints the one it uses) on the project `projects/playground`; pass `pnpm start --project ../my-device`
for another folder. Then connect your agent (each verified 2026-11-09 against a running server):

| Agent | One step |
| --- | --- |
| **Claude Code** (2.1.319) | `claude mcp add --transport http fabwright http://localhost:7780/mcp` (then `claude`; `/mcp` shows fabwright connected) |
| **Codex** (0.163.0) | `codex mcp add fabwright --url http://localhost:7780/mcp` (or `[mcp_servers.fabwright]` / `url = "http://localhost:7780/mcp"` in `~/.codex/config.toml`) |
| **Cursor** | `~/.cursor/mcp.json`: `{"mcpServers": {"fabwright": {"url": "http://localhost:7780/mcp"}}}` |
| **Claude Desktop** / any stdio client | `{"mcpServers": {"fabwright": {"command": "node", "args": ["/path/to/fabwright/apps/cli/bin/fabwright.mjs", "mcp", "--attach", "http://localhost:7780"]}}}` |

The **Install MCP** menu in the app shows these with Copy buttons and the server's real URL, and
what the agent is doing; the pill bottom-right says "No agent" until a client calls a tool, then
"Claude Code building · place part led1", "idle" or "done". **Open in Agent** copies a starter prompt that describes the project, or
launches Claude Code in a new Terminal in the project folder with Fabwright already connected (macOS,
only on your click; the exact command is shown).

Without the canvas, `fabwright mcp --project <dir>` is still a plain stdio MCP server (the setups the
agent-built examples used, with headless `claude -p` / `codex exec` flags, are in
[docs/agents.md](docs/agents.md)). Record any session with `fabwright record <project>/.fabwright/actions.jsonl
out.mp4 --speed 2 --actor mcp` (`--actor mcp` keeps only the agent's calls). The full guide (loop,
scenario steps, robots, faults, troubleshooting) is [docs/agents.md](docs/agents.md); every tool is in
[docs/mcp-tools.md](docs/mcp-tools.md).

## What works today

- **Canvas:** pan, zoom, place parts and drag wires between pins, on a breadboard-style dot grid. It also works on a phone. Open the examples from the project menu (or `?example=tamagotchi`, `ai-pet`, `rover`, `robot-arm`, `pocket-oled`).
- **Projects and history:** the logo opens a gallery of your projects and the examples (opening an example copies it). Every change is a version you can scrub through and restore: who changed what and why, the code, and how the device looked. A code editor with Save and Build & Run underlines compile errors at the line.
- **Parts:** 43 parts plus 5 boards, including an SSD1306 OLED, ILI9341, ST7735 and round GC9A01 colour TFTs, a WS2812 strip, an ESP-01 Wi-Fi module, a 16x2 I2C LCD, DS3231, BME280, DHT22, MPU6050, PIR, IR obstacle and bump switches, a capacitive soil probe, relay and water pump, a passive buzzer that plays melodies, a LiPo cell with a TP4056 charger, Schottky and signal diodes, MOSFET and NPN / PNP transistors, an LDO and a boost converter, servo, DC motor, L298N, HC-SR04 and a 2WD robot chassis. Each one has a spec, a behavioral model, an SVG visual, a fidelity file, tests, physical data (size, mass, current, price, buy links) and, for the case, mechanical data (footprint, mounting holes, screen, buttons, ports) and sourcing (MPN, plain description).
- **Parts agents make:** when the catalog lacks a part, an agent describes it with `create_part` (pins, physical facts and a behaviour template: digital input, analog sensor, actuator or relay, I2C register map, UART device, or a display on a known controller). No agent code runs; the part is labelled "agent-made: behavioral, unverified" in every report and export. See [docs/custom-parts.md](docs/custom-parts.md).
- **Boards:**

  | Board | Simulator | Toolchain |
  | --- | --- | --- |
  | Arduino Uno R3, Arduino Nano (ATmega328P, 5 V) | [avr8js](https://github.com/wokwi/avr8js) | arduino-cli `arduino:avr` |
  | Raspberry Pi Pico, Seeed XIAO RP2040, Waveshare RP2040-Zero (RP2040, 3.3 V) | [rp2040js](https://github.com/wokwi/rp2040js) with Fabwright's own boot ROM | arduino-pico 6.3.1 ([docs/rp2040.md](docs/rp2040.md)); MicroPython 1.29.0 on the Pico / XIAO |
  | Seeed XIAO ESP32-S3 / ESP32-C3, ESP32-C3 SuperMini, ESP32 DevKitC, ESP32-S3 DevKitC-1 (3.3 V) | Espressif's QEMU 9.2.2 with Fabwright's bridge, on your computer (native or Docker), through `fabwright serve` | arduino-esp32 3.3.12 ([docs/esp32-emulator.md](docs/esp32-emulator.md)) |
  | STM32 Blue Pill, WeAct Black Pill F411, Seeed XIAO nRF52840, Arduino Nano 33 BLE; Nucleo-F401RE planned | [Renode](https://renode.io) 1.17 with Fabwright's bridge, on your computer (Docker or native), through `fabwright serve` | STM32duino 2.11.0, mbed_nano 4.4.1, Seeeduino nRF52 1.1.13 ([docs/renode.md](docs/renode.md)) |

  What each board emulates, peripheral by peripheral, and the test that proves it: [docs/boards.md](docs/boards.md). Wi-Fi and BLE radios are not emulated on any board; ESP32 Wi-Fi sketches run through an emulated Ethernet card and Fabwright's sandbox network ([docs/network.md](docs/network.md)).

- **Simulation:** the real firmware arduino-cli builds, with I2C and SPI buses and cycle-timed PWM; on RP2040 also the ADC, USB serial, UARTs on pins and PIO.
  - A small DC circuit solver sets each LED's brightness from the actual current through it, so an LED wired without a resistor is flagged.
  - Time is counted in MCU cycles, never wall-clock time, so the same project gives the same run every time.
- **Robots:** a deterministic 2D physics world (Rapier) moves a rover with its simulated motors, feeds its sonar real distances, and moves a servo arm; the canvas shows the arena or the arm next to the circuit.
- **Device view:** the project as the physical thing in 3D: a handheld with its live screen, the rover driving in its arena, the arm on a table. The Tests panel shows every scenario as a filmstrip of what the device looked like at each check; click a frame to open that exact moment.
- **AI pet:** `?example=ai-pet` is an Uno with a colour screen that asks a language model what to say through an ESP-01. Tests use a deterministic mock; the Network panel's Live switch (or `set_ai_mode live`) lets Claude answer.
- **Agents:** an MCP server (stdio, or HTTP at `/mcp` from `pnpm start`) and a CLI with the same 52 operations, scenario tests, design-rule checks (including 3.3 V logic levels and rail budgets), fault injection, a fidelity report, live follow and replay of an agent's session in the browser. `plan_device` turns a wish into a parts list with size, battery life and price before anything is placed; `record` gives the person an MP4 and `viewer_url` a link that opens the project live.
- **Run what the agent built:** the page `pnpm start` opens follows the agent live, and Run runs the project there with the agent's latest firmware (auto-run after each agent build); buttons press, knobs turn and sensors slide while it runs. `/?local` still opens a standalone copy.
- **Project format:** one `fabwright.json` per project, checked by a schema and written so that git diffs stay small. See [docs/project-format.md](docs/project-format.md).
- **Serial console:** the firmware's serial output (Serial.print: UART0 on AVR, USB on RP2040) shows up live next to the canvas.

What is **not** there yet: building firmware without `fabwright serve` (Build & Run in the editor goes through the local server, which builds natively or in Docker), running ESP32 / STM32 / nRF52 boards in the page itself (they run in a local emulator through `fabwright serve`), ESP32 SPI over DMA and calibrated ADC millivolts (see [docs/boards.md](docs/boards.md)), BLE and the Wi-Fi radio, the RP2040's second core, and a real-hardware runner. See [STATUS.md](STATUS.md) for the honest list.

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0 Foundations** | Monorepo, brand, project format, canvas (pan/zoom/place/wire), parts spec + 10 parts, avr8js running Blink with a live LED, CI | Done ([STATUS.md](STATUS.md)) |
| **M1 Real Arduino projects** | arduino-cli builds in a container, serial input, I2C/SPI, 25 parts, scenario test runner, `fabwright test` CLI, GitHub Action | Mostly done (48 parts; serial input from the browser and the GitHub Action are open) |
| **M2 The agent** | MCP server exposing every canvas and sim action, built-in agent panel, prompt-to-passing-tests demo | MCP server, CLI and demos done; built-in panel open |
| **M3 More boards** | ESP32 (QEMU), Raspberry Pi Pico (rp2040js), STM32 (Renode), 40+ parts, fidelity report, design-rule checks, exports | RP2040 boards, 48 parts, fidelity report, DRC and exports done; ESP32 planned (decision 0003), STM32 open |
| **M4 Robots** | Physics world, motors/servos/IMU/distance sensors, rover and robot-arm demos | Rover and arm done (pulled forward) |
| **M5 Real hardware** | Device-farm runner, same tests on real boards, sim-vs-real diff | Planned |

## Develop

```sh
pnpm i
pnpm dev        # the web app alone (Vite), http://localhost:5173, Blink open by default
```

| Command | What it does |
| --- | --- |
| `pnpm start` | Canvas, live link and MCP (`/mcp`) on one port; `--project <dir>` for another folder. |
| `pnpm dev` | Starts the web app (Vite). |
| `pnpm typecheck` | Type-checks every package. |
| `pnpm test` | Runs the unit tests (Vitest). |
| `pnpm test:e2e` | Runs the browser tests (Playwright, desktop and phone). |
| `pnpm gen` | Regenerates the parts registry, the project JSON Schema and `docs/mcp-tools.md`. |

More detail in [docs/quickstart.md](docs/quickstart.md). The first demo, Blink, is
`docs/media/m0-blink.gif`.

## Repository layout

```
apps/web                   the canvas app (Vite + React + React Flow)
packages/project-format    fabwright.json schema, parser, stable serializer
packages/sim-core          clock, DC circuit solver, part model contract, simulation loop
packages/sim-backends      MCU emulators behind one interface (avr8js today)
packages/parts             one folder per part + generated registry
packages/physics           robot world: Rapier 2D rover, sonar raycast, arm kinematics, painters
packages/session           the headless engine behind the MCP server and the CLI
packages/mcp               MCP server (stdio)
apps/cli                   the `fabwright` CLI (every operation, serve / replay / record)
services/runner            firmware build service (arduino-cli natively or in Docker, cached)
examples/                  blink, tamagotchi, rover, robot-arm
toolchains/arduino         reproducible arduino-cli build image
brand/                     logo, tokens, brand guide
docs/                      guides and design decisions
```

Read [docs/architecture.md](docs/architecture.md) for how these fit together.

## Contributing

Adding parts is the easiest way to start: see [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/adding-a-part.md](docs/adding-a-part.md). Look for issues labelled `good first issue: part`.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## License

[Apache-2.0](LICENSE). Fabwright is original work. It does not use or copy assets or code from closed-source simulators. Third-party notices are in [NOTICE](NOTICE).
