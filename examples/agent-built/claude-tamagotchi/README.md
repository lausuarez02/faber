# Tamagotchi pet, built by Claude Code

Built from a one-line goal by Claude Code with **only Jumper's MCP tools** (no shell, no file
tools, no access to Jumper's source). This folder is the agent's final project, unedited: wiring,
firmware, scenario tests, saved OLED reference images, its own screenshot and its export.

<p align="center"><img src="../../../docs/media/agent-claude-tamagotchi.gif" alt="Replay of Claude Code building the pet: parts appear, wires draw, the firmware is written, the pet animates on the OLED and 8 of 8 tests pass" width="720"></p>

Video (44 s at 1440x900, the session replayed at 2x): [`docs/media/agent-claude-tamagotchi.mp4`](../../../docs/media/agent-claude-tamagotchi.mp4).
Replay it yourself: `pnpm jumper replay examples/agent-built/claude-tamagotchi/agent-actions.jsonl`.

## The prompt (exact)

> Build me a tamagotchi-style AI pet on an Arduino Uno with a 128x64 OLED screen, three buttons
> (feed, play, sleep) and a buzzer. The pet has hunger, happiness and energy that change over time,
> shows an animated face that reflects its mood, beeps when it needs something, and logs its state
> over serial. Prove it works with scenario tests (e.g. pressing feed lowers hunger; ignoring it for
> a while makes it sad and it beeps). Use the jumper MCP tools; the canvas is watched live, explain
> each step briefly in the step's why.

## The agent and how it ran

- **Agent:** Claude Code 2.1.319, default model, headless (`claude -p`), 2026-11-09.
- **Command** (from an empty folder outside the repo):
  `claude -p "<prompt>" --mcp-config jumper.mcp.json --strict-mcp-config --tools "" --allowedTools "mcp__jumper" --disallowedTools "Bash Edit Write Read" --output-format stream-json --verbose`.
  The init event listed exactly 34 `mcp__jumper__*` tools and no built-in tools.
- **MCP config:** `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project <folder>` with `MCP_TOOL_TIMEOUT=600000`.

| What | Number |
| --- | --- |
| Wall time | 358 s |
| Cost | $1.48 |
| Turns / tool calls | 60 / 59 |
| Failed calls | 2: a compile error (fixed with one `read_file` and two `write_file`), and one call to the bare name `write_file` instead of `mcp__jumper__write_file` (a Claude Code naming slip, retried at once) |
| Firmware builds | 2 (1 compile error: Arduino's auto-prototypes above `struct Button`; Jumper's hint named the fix) |
| Test runs | 3: 3/6, then 6/6, then 8/8 (all failures were the agent's own test timing) |
| Workarounds for simulator bugs | none |

Tool calls: 12 `connect`, 14 `write_scenario`, 5 `place_part`, 4 `run`, 4 `read_display`, 3 `get_part`,
3 `run_tests`, 3 `write_file` (+1 slip), 2 `read_file`, and one each of `get_project`, `new_project`,
`search_parts`, `set_libraries`, `check_design`, `fidelity_report`, `screenshot`, `export`.

## What it built

- **Wiring:** OLED VCC→5V, GND→GND, SDA→A4, SCL→A5 (0x3C); FEED / PLAY / SLEEP on D2 / D4 / D7 to GND
  (`INPUT_PULLUP`); active buzzer + on D8.
- **Firmware** (`firmware/main.ino`, 330 lines, Adafruit SSD1306 + GFX; `firmware/pet_types.h`):
  hunger, happiness and energy tick every second; six animated faces (happy bounce and cheeks, sad
  frown and tear, hungry chomp, tired yawn, sleeping zZ; eyes blink and glance); HUN/JOY/NRG bars;
  a double beep every 4 s when a need is unmet; one serial line per second plus `EVENT` and `MOOD`
  lines; keeps running if the OLED is missing.
- **Tests (8):** `boots`, `feed-lowers-hunger` (hunger 40 → ≤10, buzzer silent then chirping),
  `play-raises-happiness`, `neglect-makes-sad-and-beeps` (quiet for 20 s, then `need=food` beep with
  the buzzer actually sounding, hungry face, sad; the frown matches `snapshots/sad-mouth.json`),
  `sleep-restores-energy` (feed ignored while asleep; wakes at 100), `cared-for-pet-stays-quiet`
  (80 s of care, no alert), `care-cheers-up-sad-pet` (smile image back, beeping stops),
  `oled-missing-pet-still-runs` (OLED unplugged by fault injection).

## What was verified (by a person, not the agent)

Right after the run, in the run folder, and again on 2026-11-09 against the current `main` (after
the agent-eval fixes), on a copy of this folder:

| Check | Result |
| --- | --- |
| `jumper check` | 0 errors, 0 warnings |
| `jumper build --force` (right after the run) | OK, not from cache, 1.3 s; flash 19806 / 32256 B, RAM 640 / 2048 B; Adafruit SSD1306 2.5.17, GFX 1.13.0, BusIO 1.17.4 |
| `jumper test` | 8 passed, 0 failed (1 warning, see the open items) |
| `jumper fidelity` | 6 behavioral parts, 13 items to test on real hardware |
| `jumper screenshot --ms 30000` | `final.png`: the hungry face with "food", the stat bars, correct wiring |

The tests check the goal, not just that something ran. Not asserted: the blink and bounce
animation (visible in the video and screenshots, but no test pins them).

## What the simulation does not prove (fidelity)

Logic is simulated exactly; timing, analog and power are approximate. Before trusting it on a real
board: button bounce (the sketch debounces 25 ms; try fast presses), the OLED's address (0x3C vs
0x3D on some modules), daylight readability and OLED current on a battery, the buzzer's loudness (no
audio in the simulator), total pin current. The full list is `export/TEST-ON-HARDWARE.md`. The pet
gets hungry in about 25 s so the tests run fast; a real pet would use a much longer `TICK_MS`.

## Friction this run found

Fixed before this run (found in round 1, when Claude Code built a first pet with 6 failed
`write_scenario` calls): the `regex` shape is accepted where agents put it; `typical_connections`
names a free pin per button; pull-up warnings wait for your sketch; `expect_display` and
`expect_serial_value` exist. Round 2 (this run) had none of those problems.

Still open (all minor, none blocked the agent):

- A `press` step returns after `hold_ms`, so a reaction shorter than the hold (a 120 ms chirp) is
  over before the next `expect_*` step; the failure message does not say so.
- `run_tests` warns "already held 0 ms after step 3 (press)" even when the step before the press
  proved the value was the opposite (a false alarm; it is the 1 warning above).
- The scenario timeout error ("virtual time 60750 ms passed timeout_ms 60000") has no fix hint.
- The auto-prototype compile hint says `firmware/<sketch folder>/types.h` instead of the project's
  real path (`firmware/types.h`).
- The action log does not say which session wrote each line, so a person's CLI checks land in the
  same `.jumper/actions.jsonl` (`agent-actions.jsonl` here has only the agent's `mcp` lines).
- The agent never accepted its steps (nothing told it to), so the replay ends with every step
  "pending".

## Files

| File | What |
| --- | --- |
| `jumper.json` | parts, wires, scenarios |
| `firmware/main.ino`, `firmware/pet_types.h`, `firmware/main.hex` | the agent's sketch and its build |
| `snapshots/happy-mouth.json`, `snapshots/sad-mouth.json` | OLED reference images saved with `read_display {save_as}` |
| `shots/sad-pet.png` | the agent's own screenshot |
| `final.png` | the verifier's `jumper screenshot --ms 30000` |
| `export/` | BOM, wiring table, firmware.hex, hardware checklist (`export` tool) |
| `agent-actions.jsonl` | the session's action log, agent calls only (58 lines) |
