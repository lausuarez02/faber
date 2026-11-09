<p align="center">
  <img src="brand/wordmark.svg" alt="Jumper" width="280">
</p>

<p align="center"><strong>Figma for hardware, with a real simulator underneath.</strong></p>

Jumper is an open-source browser sandbox for electronics. You place parts on a canvas, wire their pins together, and run the real compiled firmware on an emulated microcontroller. The LED on the canvas lights up because the emulated ATmega328P set its pin high and a small circuit solver pushed current through the resistor and the LED. It is not a drawing of what should happen. Anything a person can do on the canvas, an AI agent will be able to do through the same tools.

**The promise, stated honestly.** If firmware crashes on real hardware, it should also crash in Jumper. If it runs in Jumper, it should run on the board, as far as the simulation can tell. Every part says what it simulates exactly, what it only approximates and what it does not simulate at all (see [fidelity](docs/fidelity.md)). Jumper does not hide those gaps.

<!-- Recorded with apps/web/scripts/record-demo.mjs -->
<p align="center"><img src="docs/media/m0-blink.gif" alt="Arduino Blink running in Jumper: the LED on the canvas turns on and off with pin D13" width="720"></p>

## Quickstart

You need Node 24 and pnpm 10 (`corepack enable` gives you the pinned pnpm).

```sh
pnpm i
pnpm dev        # http://localhost:5173
```

The Blink example opens by default. Press **Run** (or Space) and the LED on the canvas blinks once per second of virtual time, while the serial console prints `LED on` / `LED off`. More detail is in [docs/quickstart.md](docs/quickstart.md).

| Command | What it does |
| --- | --- |
| `pnpm dev` | Starts the web app (Vite). |
| `pnpm typecheck` | Type-checks every package. |
| `pnpm test` | Runs the unit tests (Vitest). |
| `pnpm test:e2e` | Runs the browser tests (Playwright, desktop and phone). |
| `pnpm gen` | Regenerates the parts registry and the project JSON Schema. |

## Use Jumper from your agent

Claude Code, Codex or any MCP client can go from a one-line goal ("a tamagotchi on an OLED with three buttons", "a rover that avoids walls") to a wired, programmed and tested device using only Jumper's tools. Run `pnpm i` once in this repo and keep Docker Desktop running (firmware builds). The device folder can be anywhere.

**Claude Code**

```sh
claude mcp add jumper -- node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project /path/to/my-device
```

or `.mcp.json`:

```json
{
  "mcpServers": {
    "jumper": {
      "command": "node",
      "args": ["/Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs", "mcp", "--project", "/path/to/my-device"],
      "env": { "MCP_TOOL_TIMEOUT": "600000" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.jumper]
command = "node"
args = ["/Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs", "mcp", "--project", "/path/to/my-device"]
startup_timeout_sec = 30
tool_timeout_sec = 600
default_tools_approval_mode = "approve"
```

The paths are absolute so they work from any directory; on another machine use your clone's path. Watch the agent build it live with `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs serve --project /path/to/my-device`. The full guide (loop, scenario steps, robots, faults, troubleshooting) is [docs/agents.md](docs/agents.md); every tool is in [docs/mcp-tools.md](docs/mcp-tools.md). Videos of Claude Code and Codex building a tamagotchi, a rover and a robot arm are in [docs/media/agent-runs](docs/media/agent-runs/README.md).

## What works today

- **Canvas:** pan, zoom, place parts and drag wires between pins, on a breadboard-style dot grid. It also works on a phone. Open the examples from the project menu (or `?example=tamagotchi`, `rover`, `robot-arm`).
- **Parts:** 21 parts, including an SSD1306 OLED, a 16x2 I2C LCD, DS3231, BME280, MPU6050, servo, DC motor, L298N, HC-SR04, battery pack and a 2WD robot chassis. Each one has a spec, a behavioral model, an SVG visual, a fidelity file and tests.
- **Simulation:** Arduino Uno and Nano (ATmega328P) on [avr8js](https://github.com/wokwi/avr8js), running the real `.hex` that arduino-cli builds, with I2C and SPI buses and cycle-timed PWM.
  - A small DC circuit solver sets each LED's brightness from the actual current through it, so an LED wired without a resistor is flagged.
  - Time is counted in MCU cycles, never wall-clock time, so the same project gives the same run every time.
- **Robots:** a deterministic 2D physics world (Rapier) moves a rover with its simulated motors, feeds its sonar real distances, and moves a servo arm; the canvas shows the arena or the arm next to the circuit.
- **Agents:** an MCP server and a CLI with the same 34 operations, scenario tests, design-rule checks, fault injection, a fidelity report, live follow and replay of an agent's session in the browser.
- **Project format:** one `jumper.json` per project, checked by a schema and written so that git diffs stay small. See [docs/project-format.md](docs/project-format.md).
- **Serial console:** the firmware's UART output (Serial.print) shows up live next to the canvas.

What is **not** there yet: building firmware from the browser (builds run through the CLI / MCP server with Docker), boards other than the ATmega328P Uno/Nano, Wi-Fi, and a real-hardware runner. See [STATUS.md](STATUS.md) for the honest list.

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0 Foundations** | Monorepo, brand, project format, canvas (pan/zoom/place/wire), parts spec + 10 parts, avr8js running Blink with a live LED, CI | Done ([STATUS.md](STATUS.md)) |
| **M1 Real Arduino projects** | arduino-cli builds in a container, serial input, I2C/SPI, 25 parts, scenario test runner, `jumper test` CLI, GitHub Action | Mostly done (21 parts; serial input from the browser and the GitHub Action are open) |
| **M2 The agent** | MCP server exposing every canvas and sim action, built-in agent panel, prompt-to-passing-tests demo | MCP server, CLI and demos done; built-in panel open |
| **M3 More boards** | ESP32 (QEMU), Raspberry Pi Pico (rp2040js), STM32 (Renode), 40+ parts, fidelity report, design-rule checks, exports | Planned |
| **M4 Robots** | Physics world, motors/servos/IMU/distance sensors, rover and robot-arm demos | Rover and arm done (pulled forward) |
| **M5 Real hardware** | Device-farm runner, same tests on real boards, sim-vs-real diff | Planned |

## Repository layout

```
apps/web                   the canvas app (Vite + React + React Flow)
packages/project-format    jumper.json schema, parser, stable serializer
packages/sim-core          clock, DC circuit solver, part model contract, simulation loop
packages/sim-backends      MCU emulators behind one interface (avr8js today)
packages/parts             one folder per part + generated registry
packages/physics           robot world: Rapier 2D rover, sonar raycast, arm kinematics, painters
packages/session           the headless engine behind the MCP server and the CLI
packages/mcp               MCP server (stdio)
apps/cli                   the `jumper` CLI (every operation, serve / replay / record)
services/runner            firmware build service (arduino-cli in Docker, cached)
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

[Apache-2.0](LICENSE). Jumper is original work. It does not use or copy assets or code from closed-source simulators. Third-party notices are in [NOTICE](NOTICE).
