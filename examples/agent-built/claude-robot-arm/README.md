# Record-and-playback servo arm, built by Claude Code

Built from a one-line goal by Claude Code using only Faber's MCP tools (see the note on tools
below). This folder is the agent's final project, unedited.

<p align="center"><img src="../../../docs/media/agent-claude-robot-arm.gif" alt="Replay of Claude Code building the arm: parts and wires appear, the arm side view follows the knobs, REC and PLAY replay poses and 6 of 6 tests pass" width="720"></p>

Video (35 s at 1440x900, the session replayed at 2x): [`docs/media/agent-claude-robot-arm.mp4`](../../../docs/media/agent-claude-robot-arm.mp4).
Replay it yourself: `pnpm faber replay examples/agent-built/claude-robot-arm/agent-actions.jsonl`.

## The prompt (exact)

> Build a little 2-servo robot arm controlled by two potentiometers on an Arduino Uno, with a button
> that records a pose and another that plays the recorded poses back. Prove it with scenario tests.
> Use the faber MCP tools; the canvas is watched live, explain each step briefly in the step's why.

## The agent and how it ran

- **Agent:** Claude Code 2.1.319, default model, headless (`claude -p`), 2026-11-09.
- **Command:** `claude -p "<prompt>" --mcp-config faber.mcp.json --strict-mcp-config --allowedTools "mcp__faber" --output-format stream-json --verbose --max-turns 200`
- **Note on tools:** this run did not pass `--disallowedTools "Bash Edit Write Read"`, so Claude
  Code's built-in tools were listed (headless mode denies anything not allowed). The transcript shows
  the agent called only `ToolSearch` (twice, to load the Faber tool schemas) and `mcp__faber__*`
  tools. The tamagotchi and rover runs used the strict setup.

| What | Number |
| --- | --- |
| Wall time | 127 s |
| Cost | $0.88 |
| Turns / tool calls | 70 / 62 Faber calls + 2 `ToolSearch` |
| Failed calls | 0 |
| Firmware builds | 1 (inside `run`), compiled the first time (Servo library) |
| Test runs | 2: 5/6 (a wait that already held before the elbow moved, the agent's mistake), then 6/6 |

Tool calls: 16 `connect`, 8 `run`, 8 `set_sensor_value`, 7 `write_scenario`, 6 `place_part`,
5 `interact`, 3 `search_parts`, 3 `get_part`, 2 `run_tests`, and one each of `get_project`,
`new_project`, `set_world`, `write_file`, `set_libraries`, `check_design`, `screenshot`,
`fidelity_report`, `export`. It tried the device by hand (knobs, REC, PLAY) before writing tests.

## What it built

- **Wiring:** shoulder servo signal on D9, elbow on D10, both from the Uno 5V; pots on A0 and A1;
  REC on D2 and PLAY on D3 to GND (`INPUT_PULLUP`).
- **World:** a 10 cm + 8 cm two-link arm (`set_world`), so the side view draws every pose.
- **Firmware** (`firmware/main.ino`, 150 lines, Servo library): knobs drive the joints 0–180° with a
  1° deadband; REC stores up to 10 poses; PLAY visits them at about 100°/s with a 0.5 s pause each,
  then hands control back to the knobs; 30 ms debounce; serial `REC n`, `AT n`, `PLAY done`,
  `PLAY empty`, `REC full`.
- **Tests (6):** `boots`, `knobs-drive-servos` (each knob moves only its joint, full range),
  `record-saves-pose`, `playback-replays-poses` (knobs parked elsewhere; asserts both servo angles and
  `world.gripper_x` at pose 1, then pose 2, then control back to the knobs), `play-with-nothing-recorded`,
  `memory-full` (an 11th REC is refused).

## What was verified (by a person, not the agent)

| Check | Right after the run | 2026-11-09, current `main` |
| --- | --- | --- |
| `faber check` | 0 errors, 0 warnings | **1 warning** (new rule from this run's friction): the two servos can pull about 500 mA from the Uno 5V; power them separately |
| `faber build --force` | OK, Servo 1.3.0, flash 4746 B (15%), RAM 393 B (19%) | OK |
| `faber test` | 6 passed, 0 failed | 6 passed, 0 failed |
| `faber fidelity` | OK | 7 behavioral parts, 12 items to test on hardware |
| `faber screenshot --ms 2000` | `final.png` (idle pose: the CLI starts a fresh simulation) | `screenshot --scenario playback-replays-poses --at-step N` can now picture a recorded pose |

The agent's own mid-playback screenshot is `shots/arm-playback.png`.

## What the simulation does not prove (fidelity)

Logic is exact; timing, analog and power are approximate. On the real arm: power the servos from a
separate 5–6 V supply with a common ground (two SG90s moving at once brown out the Uno 5V); many
SG90s reach only about 170° and buzz at their end stops; real knob readings are noisier near the
ends; holding strength and sag under load. Full list: `export/TEST-ON-HARDWARE.md`.

## Friction this run found (all fixed since)

1. A `within_ms` wait that was already true before the change: `run_tests` now warns, and the tool
   description says to wait on the side the value moves toward.
2. `place_part` suggested the same pin (D9, A0, D2) for the second servo, pot and button: it now
   names the next free pin of the right kind.
3. `set_world` for an arm returned the rover's hint: the hint now depends on the world.
4. Servo pins showed `out L 0.00V` while pulsing: `run` now shows `out pulse 50Hz 903us`.
5. No warning for two servos on the Uno 5V: `check_design` now warns (see the table above).
6. Pull-up warnings while the sketch was still the template: now a reminder until the sketch is yours.
7. Replay cards covered parts: the replay fits the circuit into the free space.
8. The CLI screenshot could only show the idle pose: `--scenario ID --at-step N`.

Still open: the new power-budget warning's fix text suggests "the driver's 12V" as the supply pin,
which fits motors behind a driver but not servos.

## Files

| File | What |
| --- | --- |
| `faber.json` | parts, wires, world, scenarios |
| `firmware/main.ino`, `firmware/main.hex` | the agent's sketch and its build |
| `shots/arm-playback.png` | the agent's screenshot during playback |
| `final.png` | the verifier's `faber screenshot --ms 2000` |
| `export/` | BOM, wiring table, firmware.hex, hardware checklist |
| `agent-actions.jsonl` | the session's action log, agent calls only (67 lines) |
