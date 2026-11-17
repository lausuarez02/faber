# Obstacle-avoiding rover, built by Codex

Built from a one-line goal by Codex with **only Faber's MCP tools** (shell, exec, browser and
computer use turned off; no access to Faber's source). This folder is the agent's final project,
unedited.

<p align="center"><img src="../../../docs/media/agent-codex-rover.gif" alt="Replay of Codex building the rover: parts and wires appear, the rover drives in the arena view, the second firmware drives 30 s with zero collisions and both tests pass" width="720"></p>

Video (37 s at 1440x900, the session replayed at 2x): [`docs/media/agent-codex-rover.mp4`](../../../docs/media/agent-codex-rover.mp4).
Replay it yourself: `pnpm faber replay examples/agent-built/codex-rover/agent-actions.jsonl`.

## The prompt (exact)

> Build a small 2-wheel robot that drives around an arena and avoids walls using an ultrasonic
> distance sensor. Use an Arduino Uno, an L298N motor driver, two DC motors on a 2WD chassis and a
> battery pack. Prove with scenario tests that it drives for 30 seconds in the arena without
> colliding and that it turns away when a wall is closer than 20 cm. Use the faber MCP tools; the
> canvas is watched live, explain each step briefly in the step's why.

## The agent and how it ran

- **Agent:** codex-cli 0.163.0, model gpt-6.1-sol, reasoning effort **low**, 2026-11-09.
- **Command:** `CODEX_HOME=<isolated> codex exec --skip-git-repo-check --json -s read-only -C <folder> "<prompt>"`
- **Config** (`$CODEX_HOME/config.toml`; the only MCP server is Faber):

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "low"

[features]            # nothing but the MCP tools
shell_tool = false
unified_exec = false
browser_use = false
browser_use_external = false
computer_use = false
apps = false
# leave code_mode_host on: Codex 0.163 routes MCP calls through it

[mcp_servers.faber]
command = "node"
args = ["/path/to/faber/apps/cli/bin/faber.mjs", "mcp", "--project", "<folder>"]
startup_timeout_sec = 30
tool_timeout_sec = 600
default_tools_approval_mode = "approve"
```

| What | Number |
| --- | --- |
| Wall time | 109 s, 1 turn |
| MCP tool calls | 44, **0 failed, 0 tool errors** |
| Tokens | 371,780 in (312,448 cached), 2,859 out |
| Firmware builds | 2 (both inside `run`; both compiled the first time) |
| Test runs | 1: 2/2 passed |
| Firmware iterations | 1: the first sketch hit walls 49 times in 30 s; brake, pivot, brake fixed it (0 collisions) |

Tool calls: 15 `connect`, 7 `place_part`, 6 `get_part`, 3 `run`, 2 `check_design`, 2 `write_file`,
2 `write_scenario`, and one each of `get_project`, `search_parts`, `set_world`, `run_tests`,
`fidelity_report`, `export`, `screenshot`. Every pin name came from `get_part`; `connect` resolved
`uno.GND` to a free GND pin by itself.

## What it built

- **Wiring:** L298N ENA/ENB on D5/D6 (PWM), IN1..IN4 on D7, D8, D11, D12; motors on OUT1/OUT2 and
  OUT3/OUT4; HC-SR04 TRIG D9, ECHO D10, from the Uno 5V; 2S battery on the L298N 12V terminal and the
  Uno VIN, common ground.
- **World:** a 2 m × 1.5 m walled arena (`set_world`).
- **Firmware** (`firmware/main.ino`, 23 lines): sonar every 65 ms; under 20 cm it brakes, pivots
  right, brakes and measures again; stops safely if there is no echo.
- **Tests (2):** `arena-30-seconds` (30 s: `world.collisions == 0`, `world.min_clearance_cm >= 3`,
  `travelled_cm > 500`, no errors) and `wall-under-20` (drives at a real wall; the measured distance
  drops below 20, bridge B reverses within 400 ms while A stays forward, the heading changes, the
  sonar clears 25 cm, it drives forward again, 0 collisions).

## What was verified (by a person, not the agent)

Right after the run, and again on 2026-11-09 against the current `main` on a copy of this folder:

| Check | Result |
| --- | --- |
| `faber check` | 0 errors, 0 warnings |
| `faber build --force` (right after the run) | fresh compile, hex byte-identical to the agent's; flash 4584 / 32256 B |
| `faber test` | 2 passed, 0 failed |
| `faber fidelity` | 7 behavioral parts, 21 items to test on the real device |
| `faber screenshot --ms 30000` | `final.png`: the circuit next to the arena trace, 7.42 m, 0 collisions, closest gap 7.4 cm |

Weak spot in the tests: only the first wall approach is checked, and there is no near-boundary case
(at 21 cm it should not turn).

## What the simulation does not prove (fidelity)

Logic is exact; timing, analog and power are approximate. The sonar cone is ±15°, wheels do not load
the motors and the motor model assumes continuous current. Before driving it for real: motor trim
(two motors never match), braking and turn timing on your floor, sonar readings on soft or angled
surfaces, L298N temperature, battery protection and brown-outs when both motors start. Full list:
`export/TEST-ON-HARDWARE.md`.

## Friction this run found

Fixed before this run (found in round 1, when Codex built a first rover): a battery voltage change
ignored after `run {reset}`, the chassis "has no wires" warning, a USB power-budget false alarm,
`expect_part` without a fix hint, passing tests at a 0.67 cm gap.

Still open (all minor; the agent worked around none of them, it just ignored the wrong hints):

- After placing the battery, `place_part` hinted `POS → 5V` — wrong and harmful for an 8.4 V pack. **Fixed:** it now says VIN / driver supply and warns never to use 5V.
  The part's description was right (12V terminal or VIN), and the agent followed that.
- The second motor got the same `OUT1/OUT2` hint as the first. **Fixed:** the hint names both pairs.
- `run` gives collision totals but not when or where the first one happened; the agent needed an
  extra 7 s run to find it.
- The 10 µs sonar trigger is labelled `(servo-style)` in the pin summary.
- A person's CLI checks get appended to the same action log (`agent-actions.jsonl` has only the
  agent's lines).

## Files

| File | What |
| --- | --- |
| `faber.json` | parts, wires, world, scenarios |
| `firmware/main.ino`, `firmware/main.hex` | the agent's sketch and its build |
| `shots/arena-30-seconds.png` | the agent's own screenshot |
| `final.png` | the verifier's `faber screenshot --ms 30000` |
| `export/` | BOM, wiring table, firmware.hex, hardware checklist |
| `agent-actions.jsonl` | the session's action log, agent calls only (48 lines) |
