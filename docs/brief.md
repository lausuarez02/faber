# Build brief: open-source AI hardware sandbox ("Figma for hardware, with a real simulator underneath")

> The original brief this project was started from. Decisions that refine or deviate from it live in `docs/decisions/`.

## 1. What we are building

A browser app where a person (or an AI agent) designs, wires, programs and tests a hardware project **without owning the hardware**. When the sandbox says it works, flashing the same firmware to the real board should work out of the box.

Three layers:
1. **Canvas (the UI):** an infinite, Figma-like canvas. Left sidebar holds a parts library (boards, sensors, motors, displays, power, mechanical parts). Users and the AI drag parts onto the canvas, wire pins together, and see everything live: LEDs light up, screens draw, motors turn, the serial console prints.
2. **Simulation engine:** real firmware binaries run on emulated microcontrollers. Emulated peripherals (I2C/SPI/UART/GPIO/ADC/PWM/WiFi) talk to behavioral models of the parts on the canvas. For robots and moving things, a physics world is attached.
3. **AI agent:** a first-class user of the canvas. Given "I want a plant-watering robot that texts me when soil is dry", it picks parts, places and wires them, writes the firmware, builds it, runs it in the sim, reads logs, writes tests, fixes bugs, and loops until the tests pass. Every action it takes is visible on the canvas and can be undone.

The core promise: **"if it doesn't crash here, it won't crash there"**, plus an honest score for how much the sim can actually promise (see section 6).

## 2. Users and the main flow

- Maker or student: "Make an ESP32 weather station with an OLED screen", then watch the AI build it, tweak it, export it.
- Firmware engineer: import an existing PlatformIO/Zephyr/ESP-IDF project, wire the board virtually, run CI on every commit.
- Robot builder: a 2-wheel rover with an IMU and ultrasonic sensor, firmware tested in a physics world (does it avoid the wall? does it fall over?).

Main flow:
1. Prompt or blank canvas.
2. The agent proposes a part list and wiring, then places them on the canvas.
3. The agent writes the firmware and builds it with the real toolchain.
4. Run in the sim: serial output, virtual instruments (logic analyzer, oscilloscope, multimeter, power meter), physics view.
5. Scenario tests run: "soil sensor reads 20% → pump on within 2 s", "WiFi drops → reconnects", "run 24 virtual hours → no crash, no memory leak".
6. Export: firmware binary + source, wiring diagram, BOM with buy links, pinout PDF, KiCad netlist, and flashing instructions per board.
7. (Later) Run the same tests on real boards in a remote device farm.

## 3. Use existing open-source engines, don't reinvent them

Research each before committing, and check licenses (everything we ship must be MIT/Apache-2.0 compatible):
- **AVR (Arduino Uno/Nano/Mega):** `avr8js` (MIT, runs in the browser).
- **RP2040 (Raspberry Pi Pico):** `rp2040js` (MIT, browser).
- **STM32, nRF52, many Cortex-M and RISC-V chips:** **Renode** (MIT). Runs server-side or in a worker container, controlled through its monitor/Robot Framework API.
- **ESP32 / ESP32-C3 / S3:** Espressif's **QEMU fork**. Check how far its WiFi/network emulation goes and document the gaps. ESP32 is the most important board family, so put real effort here.
- **Linux boards (Raspberry Pi class):** QEMU system emulation (later phase).
- **Analog and power circuits:** `ngspice` for parts of the circuit that need real electrical behavior (voltage dividers, RC filters, battery/brownout). Optional per project.
- **Physics for robots:** **MuJoCo** (Apache-2.0, has a WASM build) or Rapier. Motors, wheels, IMU and distance sensors read from and write to the physics world.
- **Toolchains:** PlatformIO, arduino-cli, ESP-IDF, Zephyr, Pico SDK, in reproducible Docker build images.
- **Canvas:** React + **React Flow** (MIT) or a custom canvas on PixiJS/Konva. **Don't use tldraw** (its production license isn't open-source friendly). Pick for performance with 200+ parts and live animation.

Don't use or copy Wokwi's closed-source parts or assets. Being an open alternative is the point.

## 4. Architecture (propose and refine)

- `apps/web`: Next.js or Vite + React canvas app. Parts library, wiring, live view, instruments, console, test results, agent chat panel.
- `packages/parts`: **the part spec**, the heart of the project. Every part is a folder with:
  - `part.json`: id, name, category, pins (name, type, voltage, protocols), electrical limits, footprint, buy links.
  - `model.ts`: behavioral model (e.g. a BME280 answers I2C register reads with temperature, which the user or a test scenario can set).
  - `visual.svg` + animation states.
  - `fidelity.json`: what the model does and doesn't emulate (timing accuracy, noise, failure modes).
  - Tests that prove the model matches the datasheet.
  Write a contributor guide so the community can add parts fast. Ship at least 40 parts in v1 (the common Arduino/ESP32 kit: LEDs, buttons, pots, DHT22, BME280, MPU6050, HC-SR04, SSD1306 OLED, ILI9341 TFT, WS2812, servo, DC motor + L298N, stepper + A4988, relay, buzzer, SD card, GPS NEO-6M, soil moisture sensor, LDR, PIR, IR receiver, keypad, rotary encoder, LCD1602 I2C, RTC DS3231, HX711 load cell, MAX7219, batteries/regulators, etc.).
- `packages/sim-core`: one bus abstraction (GPIO, I2C, SPI, UART, ADC, PWM, CAN, network) that connects any CPU emulator to any part model. A deterministic clock (same input = same run, so tests are reproducible), time scaling (faster than real time for long tests), snapshots and replay.
- `packages/sim-backends`: adapters for avr8js, rp2040js, Renode, QEMU-ESP32, QEMU-Linux. Browser-native where possible, worker containers otherwise.
- `packages/physics`: MuJoCo/Rapier bridge for robots.
- `packages/project-format`: one open file format (JSON + firmware folder) for a whole project: parts, positions, wires, firmware, test scenarios. Git-friendly diffs.
- `packages/agent`: the AI layer (section 5).
- `services/runner`: build + simulation workers (Docker), job queue, used by both the UI and CI.
- `cli`: `<name> run`, `<name> test`, `<name> export`, so it works headless in GitHub Actions.
- (Phase 4) `services/device-farm`: real boards attached to runners (look at labgrid), same test scenarios, compared with sim results.

## 5. The AI agent

- Expose every canvas and sim action as tools through an **MCP server**, so any agent (Claude, Gemini, Codex, local models) can drive the sandbox: `search_parts`, `place_part`, `move_part`, `connect(pinA, pinB)`, `remove`, `set_part_property`, `write_file`, `build`, `flash`, `run(duration, speed)`, `read_serial`, `read_pin`, `set_sensor_value`, `inject_fault`, `screenshot_canvas`, `run_tests`, `export`.
- Include a built-in agent in the app with pluggable model providers. Default to Gemini on Vertex AI, and support Anthropic and OpenAI-compatible endpoints.
- Agent loop: understand the goal → propose a BOM and wiring (with a short "why") → place → write firmware → build → simulate → write scenario tests from the goal → fix until green → summarize what was verified and what was **not** (fidelity gaps).
- Design rule checks the agent (and humans) get warned about: 5 V into a 3.3 V pin, too much current from a GPIO, shared I2C addresses, missing pull-ups, power budget over the regulator's limit, boot-strapping pins misused (ESP32 GPIO0/2/12/15), pin conflicts.
- Everything the agent does streams onto the canvas live (cursor, highlights), can be undone, and is grouped into steps the user can accept or reject.

## 6. Honesty: the fidelity score

The sandbox must never pretend. Every project shows a **"real-world confidence" report**:
- Per part: Exact / Behavioral / Stub (from `fidelity.json`).
- Per area: logic ✅, timing ⚠️, analog ⚠️, radio ❌, power ⚠️, with a plain-language explanation.
- A list of "test these on the real device" items generated from the gaps.
Fault injection to harden firmware: sensor disconnect, noisy readings, I2C NACK, brownout, WiFi drop, clock drift, flash full.

## 7. Milestones (ship each one working end to end before starting the next)

**M0, foundations (week 1):** monorepo, brand, project format, canvas with pan/zoom/place/wire, parts spec + 10 parts, avr8js running Arduino Blink with a live LED. CI green.
**M1, real Arduino projects:** arduino-cli builds in a container, serial console, I2C/SPI bus, 25 parts, scenario test runner, CLI `test` command, GitHub Action example.
**M2, the agent:** MCP server + built-in agent panel. Demo: "build a temperature display with an alarm" goes from prompt to passing tests with no human edits.
**M3, ESP32 + Pico + STM32:** QEMU-ESP32 (incl. networking where possible, a mock MQTT/HTTP server inside the sandbox), rp2040js, Renode backend. 40+ parts, fidelity report, design rule checks, exports (BOM, netlist, firmware).
**M4, robots:** physics world, motors/servos/IMU/distance sensors bound to physics, a 2-wheel obstacle-avoiding rover demo and a robot-arm demo.
**M5, real hardware:** device-farm runner, same tests on real boards, sim-vs-real diff report.

## 8. Quality bar

- Determinism: the same project + seed gives an identical run. Tests prove it.
- Performance: canvas stays at 60 fps with 200 parts. Arduino sims run at ≥1× real time in the browser.
- Every backend and part has automated tests. Golden-firmware tests (known projects with known serial output) run in CI.
- Check every UI change in a real browser with Playwright on desktop and mobile viewports (the canvas must at least be viewable and runnable on a phone).
- Docs site: quickstart, "add a part in 15 minutes", "add a board backend", MCP tool reference, fidelity philosophy.
- License: Apache-2.0. CONTRIBUTING.md, code of conduct, issue templates, good-first-issue labels for parts.

## 9. Non-goals for v1

PCB layout/routing (export a netlist to KiCad instead), FPGA simulation, cycle-exact emulation of every chip, user accounts and billing, a hosted marketplace.

## 10. How to work

- Before coding each milestone, write a short design note in `docs/decisions/` (options, choice, why).
- Keep a `STATUS.md` at the repo root: what works, what's next, known gaps. Update it at the end of every work session.
- Prefer boring, proven libraries. When an emulator can't do something (e.g. real ESP32 WiFi), document the gap and ship a clear mock rather than faking fidelity.
- Commit small, with clear messages. Never commit secrets.
- When you finish a milestone, record a short demo video/GIF of the canvas doing the thing and put it in the README.
