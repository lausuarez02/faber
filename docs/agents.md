# Jumper for agents

Jumper lets an AI agent (Claude Code, Codex, any MCP client, or a shell script) go from a one-line
goal ("a tamagotchi on an OLED with three buttons") to a wired, programmed and **tested** device,
using only Jumper's tools. The same operations are exposed three ways with identical rules:

| Face | Start it | Best for |
| --- | --- | --- |
| **Live server** (canvas + MCP over HTTP) | `pnpm start` in the repo (= `jumper serve`), then `claude mcp add --transport http jumper http://localhost:7780/mcp` | a person watching the agent build, live, on the canvas |
| MCP server (stdio) | `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project <dir>` | Claude Code, Codex, Cursor, any MCP client |
| CLI | `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs <command>` (or `pnpm jumper <command>` inside the repo) | shells, CI, scripts (`--json` for machine output) |
| Browser | `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs serve --project <dir>` | a human watching the agent work live, accepting / rejecting its steps |

Proof it works: Claude Code built a tamagotchi pet (8/8 tests) and a record-and-playback servo arm
(6/6), and Codex an obstacle-avoiding rover (2/2, 0 failed calls), each from a one-line goal with
only these tools. The projects, prompts, numbers and videos are in
[examples/agent-built](../examples/agent-built/README.md); the first round (before the fixes it led
to) is in [media/agent-runs](media/agent-runs/README.md).

The paths below are absolute paths on the maintainer's machine, so they work from any directory.
On another machine replace `/Users/lautaritos/Projects/hardware/jumper` with where you cloned
Jumper. Every tool is documented in [mcp-tools.md](mcp-tools.md) (generated from the tool
definitions).

## Setup

### The one-step way: a live server

```sh
pnpm start                                   # in the Jumper repo; or: jumper serve --project /path/to/my-device
claude mcp add --transport http jumper http://localhost:7780/mcp
```

`jumper serve` is one local server (default port 7780; the next free port when taken, printed at
start) for everything:

| Path | What |
| --- | --- |
| `http://localhost:7780/` | the web app, following the project live (redirects to `?follow=ws://localhost:7780/live`) |
| `http://localhost:7780/mcp` | MCP over Streamable HTTP, bound to the **same session** the canvas shows |
| `ws://localhost:7780/live` | live events: `hello`, `action`, `presence` (connected agents, what each is running) |
| `GET /api/info` | URLs, install snippets for each agent, starter prompt, connected agents |
| `POST /api/launch/claude-code` | the app's "Launch Claude Code here" (needs the page's token; macOS Terminal) |

Every MCP client and the canvas go through one queue on one session, so the canvas run button
continues the agent's simulation, and calls never interleave. Each action-log line records `actor`
(`mcp`, `web`, `cli`), `client` (`claude-code 2.1.319`) and `sid` (which server process). Requests
must come from this machine (`Host` localhost / 127.0.0.1 / ::1, and a localhost `Origin` when a
browser sends one).

Connect any agent (each verified 2026-11-09 against a running `jumper serve`, without touching the
real configs: Claude Code with `CLAUDE_CONFIG_DIR=<temp>`, then a real `claude -p` call; Codex with
`CODEX_HOME=<temp>`, then a real `codex exec -c mcp_servers.jumper.url=…` call):

| Agent | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http jumper http://localhost:7780/mcp`; `claude mcp list` shows `jumper: http://localhost:7780/mcp (HTTP) - ✔ Connected`. One-off: `claude --mcp-config jumper.json` with `{"mcpServers": {"jumper": {"type": "http", "url": "http://localhost:7780/mcp"}}}` |
| Codex | `codex mcp add jumper --url http://localhost:7780/mcp`, i.e. `[mcp_servers.jumper]` + `url = "http://localhost:7780/mcp"` in `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"jumper": {"url": "http://localhost:7780/mcp"}}}` (not verified here: Cursor is not installed on the build machine) |
| Claude Desktop | `claude_desktop_config.json`: `{"mcpServers": {"jumper": {"command": "/absolute/path/to/node", "args": ["/Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs", "mcp", "--attach", "http://localhost:7780"]}}}` (the Install MCP menu fills in your node path; not verified in the app itself, the same stdio bridge is tested with the MCP SDK) |
| Any stdio-only client | `jumper mcp --attach http://localhost:7780`: a stdio server that forwards to the running serve, so its calls also drive the live canvas |

In the web app, **Install MCP** shows the same snippets with Copy buttons and who is connected;
**Open in Agent** copies a starter prompt (what the project has, that a person is watching, the
loop) or launches Claude Code in a new macOS Terminal: `cd <project> && claude --mcp-config
<temp file pointing at this server>` (only on that click, only from a page served by this server,
which holds the token; the exact command is shown so you can run it yourself).

### Standalone stdio server

Requirements: Node 24, `pnpm install` once at the repo root, and **Docker Desktop running** (firmware
is compiled with arduino-cli in a pinned image; the first build creates the image, a few minutes,
then builds take about a second and identical sources come from a cache in milliseconds).
Simulation, design checks and everything else work without Docker. The device folder (`--project`)
can be anywhere; it is created if missing.

### Claude Code

One command (run it in the folder you work in; `-s user` makes it available everywhere):

```sh
claude mcp add jumper -- node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project /path/to/my-device
```

or a `.mcp.json` next to your work (Claude Code picks it up; also works with `claude --mcp-config .mcp.json`):

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

Headless, for scripts and CI (verified 2026-11-09 with Claude Code 2.1.319 from a folder outside the repo):

```sh
claude -p "Build a tamagotchi on an OLED with three buttons using the jumper tools, with passing tests" \
  --mcp-config .mcp.json --strict-mcp-config --allowedTools "mcp__jumper"
```

`--allowedTools` only pre-approves the Jumper tools; to prove an agent used nothing else (an
evaluation), also pass `--disallowedTools "Bash Edit Write Read"`.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.jumper]
command = "node"
args = ["/Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs", "mcp", "--project", "/path/to/my-device"]
startup_timeout_sec = 30
tool_timeout_sec = 600
default_tools_approval_mode = "approve"   # without it, `codex exec` rejects every tool that edits
```

Then `codex` (interactive) or headless (verified 2026-11-09 with codex-cli 0.163.0):

```sh
codex exec --skip-git-repo-check "Build an obstacle-avoiding rover using the jumper tools, with passing tests"
```

For an evaluation where Codex may use nothing but Jumper, give it its own `CODEX_HOME` whose
`config.toml` has only the `jumper` server and turns off the other tools:

```toml
[features]
shell_tool = false
unified_exec = false
browser_use = false
browser_use_external = false
computer_use = false
apps = false
```

Leave `code_mode_host` on: Codex 0.163 sends MCP tool calls through it, and with it off every call
fails with "code-mode host is disabled".

### Any other MCP client

Command `node`, arguments
`/Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project <dir>` (or set
`JUMPER_PROJECT=<dir>` and drop `--project`), transport stdio. The server sends the recommended loop
as its instructions and offers three resources: `jumper://docs/agents` (this guide),
`jumper://parts` (the catalog) and `jumper://project` (the current `jumper.json`). Screenshots come
back as an image too, so a model with vision can look at the circuit, the OLED and the robot's world.
`packages/mcp/bin/jumper-mcp.mjs --project <dir>` is the same server without the CLI wrapper.

## The loop

1. `get_project` (or `new_project`) to see where you are.
2. `search_parts` for each thing the device needs, then `get_part` for its pins, wiring hint,
   libraries and a minimal Arduino example.
3. `place_part` (leave out x/y: Jumper lays parts out tidily) and `connect` pins written as
   `"part.pin"`. Pass a short `why` with your edits: the human sees it in the step list.
4. `check_design` and fix every error (LED resistors, power, I2C pins, shorts…).
5. `write_file` the sketch (`firmware/main.ino`). Print what happens with `Serial.begin(115200)`:
   serial output is how you and the tests check behaviour. `set_libraries` for library includes.
6. `run {"ms": 3000}`: builds if needed, then simulates and returns serial output, pin levels, part
   states and diagnostics. `read_display` shows a screen as ASCII art. `interact` presses buttons,
   `set_sensor_value` changes what a sensor reads; run again to see the firmware react.
7. `write_scenario` for each behaviour of the goal, then `run_tests`. Fix the firmware or wiring
   until every scenario passes.
8. `inject_fault` (`disconnect`, `i2c_nack`, `noisy`) to see the firmware cope with a broken world.
9. `fidelity_report`: tell the human what was verified and what still has to be tested on the real
   device. `screenshot` and `export` (BOM with buy links, wiring table, firmware.hex) at the end.

## Conventions

- **Ids**: parts get short ids (`uno`, `led1`, `btn2`, `oled1`, `r1`); no dots in ids.
- **Pins**: `"part.pin"`, e.g. `uno.D13`, `r1.1`, `led1.A`, `oled1.SDA`, `uno.GND.2`. `connect` is
  forgiving and says what it resolved: `uno.13` → `uno.D13`, `uno.GND` → a free GND pin,
  `oled1.gnd` → `oled1.GND`. Board pin ids are the Arduino names (`D0`–`D13`, `A0`–`A5`).
- **Time** is virtual and deterministic: the same project and inputs give the same result, and a
  5 s run takes about 1 s.
- **Steps**: edits with the same `why` form one step; `undo`, `redo`, `reject_step` (any step, not
  only the last), `accept_step`. Everything is logged to `<project>/.jumper/actions.jsonl`.
- **Errors** always say what failed, why, and the fix (with "did you mean" suggestions). Act on the
  fix literally.
- **Results are compact** to save tokens: `get_project` lists parts as one line each, `run` drops
  render-only state, long serial output is cut to the last 3000 characters (`read_serial` has it all).

## Worked example: a tamagotchi-style pixel pet

Goal: *"A pocket pet on an Uno: an OLED face, three buttons (feed, play, info), a buzzer. Hunger and
joy go down over time; feeding and playing bring them up."*

```text
search_parts {"query":"oled"}            → ssd1306-oled-i2c (OLED display 128x64, I2C)
get_part {"type":"ssd1306-oled-i2c"}      → pins GND VCC SCL SDA, address 0x3C, libraries
                                            ["Adafruit SSD1306","Adafruit GFX Library"], example sketch
place_part {"type":"arduino-uno","why":"brain"}        → id "uno"
place_part {"type":"ssd1306-oled-i2c","why":"face"}     → id "oled1", typical_connections …
place_part {"type":"pushbutton","why":"buttons"}  ×3    → btn1, btn2, btn3
place_part {"type":"buzzer","why":"voice"}              → buzzer1
connect {"from":"oled1.GND","to":"uno.GND","why":"wiring"}   → resolved uno.GND → uno.GND.1
connect oled1.VCC→uno.5V, oled1.SCL→uno.A5, oled1.SDA→uno.A4,
        btn1.1a→uno.D2, btn1.2a→uno.GND, btn2.1a→uno.D3, btn2.2a→uno.GND,
        btn3.1a→uno.D4, btn3.2a→uno.GND, buzzer1.POS→uno.D8, buzzer1.NEG→uno.GND
check_design                              → ok (it would flag pinMode(…, INPUT) without a pull-up)
write_file {"path":"firmware/pet.ino","content":"…","why":"pet firmware"}
set_libraries {"libraries":["Adafruit SSD1306","Adafruit GFX Library"]}
run {"ms":1000}                           → serial "pet ready", oled1 {on:true, lit:323, frame:4}
read_display {"part":"oled1"}             → the face as ASCII art (64x32 characters)
interact {"part":"btn1","action":"press"}; run {"ms":100} → serial "fed hunger=7"
```

The core of the firmware (complete sketch in `examples/tamagotchi` when present):

```cpp
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
const int BTN_FEED = 2, BTN_PLAY = 3, BTN_INFO = 4, BUZZER = 8;

void setup() {
  Serial.begin(115200);
  pinMode(BTN_FEED, INPUT_PULLUP);   // button to GND, reads LOW when pressed
  pinMode(BTN_PLAY, INPUT_PULLUP);
  pinMode(BTN_INFO, INPUT_PULLUP);
  pinMode(BUZZER, OUTPUT);
  Wire.begin();
  Wire.beginTransmission(0x3C);      // Adafruit's begin() does not notice a missing display: probe it
  if (Wire.endTransmission() != 0 || !display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("oled missing");
    for (;;) {}
  }
  Serial.println("pet ready");
}
```

Then the tests, written from the goal:

```json
{ "id": "feeds", "steps": [
  { "expect_serial": "pet ready", "within_ms": 1500 },
  { "expect_part": "oled1.lit", "op": ">", "value": 100, "within_ms": 500 },
  { "press": "btn1", "hold_ms": 60 },
  { "expect_serial": { "regex": "fed hunger=\\d" }, "within_ms": 200 },
  { "expect_pin": "uno.D8", "level": "high", "within_ms": 100 } ] }
{ "id": "gets-hungry", "steps": [ { "run_ms": 6500 }, { "expect_serial": { "regex": "hunger=3" } } ] }
{ "id": "no-oled", "steps": [ { "inject_fault": "oled1", "kind": "i2c_nack" }, { "expect_serial": "oled missing", "within_ms": 1500 } ] }
```

`run_tests` runs each from 0 ms and reports, for a failure, the step, what was expected, what was
seen instead and the serial tail, for example:
`step 1 {"expect_part":"oled1.lit",…} failed: expected oled1.lit > 100 but it is 0` (the face is
drawn after "pet ready" is printed, so the step needs `within_ms`).

## Robots

**Obstacle-avoiding rover**: place `arduino-uno`, `l298n`, two `dc-motor`, `hc-sr04`,
`battery-pack` and `robot-chassis-2wd`; wire the motors to the L298N outputs, ENA/ENB to PWM pins,
IN1–IN4 to GPIOs, the battery to the L298N `12V`/`GND` and the L298N `GND` to the Uno; then
`set_world`:

```json
{ "world": { "arena": { "width": 300, "height": 200 },
             "obstacles": [ { "id": "crate", "shape": "box", "x": 160, "y": 80, "w": 36, "h": 36, "angle": 15 } ],
             "robot": { "start": { "x": 40, "y": 40, "heading": 0 } } } }
```

`run` then moves the robot with real motor speeds, the sonar reads true distances, and the result
has `world: { robot: {x, y, heading}, collisions, min_clearance_cm, travelled_cm, sonar_cm }`.
`screenshot` draws the arena from above next to the circuit (trail, sonar cone, obstacles). Test it
with `world.<field>`:

```json
{ "id": "avoids-walls", "steps": [ { "run_ms": 20000 },
  { "expect_part": "world.collisions", "op": "==", "value": 0 },
  { "expect_part": "world.travelled_cm", "op": ">", "value": 300 },
  { "expect_part": "world.min_clearance_cm", "op": ">=", "value": 3 } ] }
```

Always assert a real margin on `min_clearance_cm` (3 cm or more): the physics counts any gap above
0 as "no collision", so `> 0` passes a rover that scrapes the wall at 2 mm. `run` adds a "near miss"
note when the closest gap is under 2 cm. For turns, check a minimum heading change rather than
`heading != 0`.

World fields: `collisions`, `min_clearance_cm`, `travelled_cm`, `x`, `y`, `heading`, `speed`,
`sonar_cm`, `touching` (rover); `gripper_x`, `gripper_y`, `reached` (arm, a comma list of target ids).
The chassis part's own state (`chassis.x`, `chassis.collisions`…) has the same pose.

**Servo robot arm**: `servo-sg90` parts on digital pins (`#include <Servo.h>`, `set_libraries ["Servo"]`;
two or more servos need their own 5–6 V supply with a common GND, and `check_design` warns otherwise),
`potentiometer` wipers on `A0`/`A1`; `set_world {"world": {"arm": {"base": {"x": 0, "y": 6},
"links": [12, 10], "joints": [{"servo": "shoulder"}, {"servo": "elbow", "zero": 90}],
"targets": [{"id": "cup", "x": 15, "y": 4, "r": 2}]}}}` gives forward kinematics (gripper position,
targets reached) for `run`, tests and the screenshot's side view.
`set_sensor_value {"part":"pot1","field":"position","value":0.8}` (or a `set` scenario step) moves a
knob; `{"expect_part": "world.reached", "op": "contains", "value": "cup"}` checks the gripper.

Working references: `examples/rover` and `examples/robot-arm` (each with passing scenarios and a
video in `media/`).


When the rover hits something, `run` reports `world.first_collision`: `{t_ms, x, y, heading, with: ["crate"]}` (time within 50 ms), and a failing `world.collisions` check quotes it, so you know which turn to fix.

## Wi-Fi and the pet AI

An `esp01-wifi` module (Espressif AT firmware, on SoftwareSerial) joins a sandbox Wi-Fi called
`JumperNet` and can reach one host: `http://ai.jumper/v1/pet?a=talk&f=68&j=68&e=79&n=Pip`, which
answers `mood|text` (60 characters max). `examples/ai-pet` is the reference: an Uno draws a pet on an
ILI9341 colour TFT and shows the reply in a speech bubble.

| Tool | Use |
| --- | --- |
| `read_network_log` | What the device did: Wi-Fi joins, DNS, TCP and every HTTP request with status, latency, provider and body. Empty means the module never joined (check TX/RX wiring and the divider on its RX). |
| `set_ai_mode {"mode": "live"}` | A real model (claude-haiku-5-5 through `ANTHROPIC_API_KEY`, else the logged-in `claude` CLI) answers. Fails with the reason when neither exists. |
| `run_live {"ms": 8000}` | Runs at real time so the live answer arrives while the firmware waits. Not deterministic. `run` and `run_tests` always use the deterministic mock. |

Screenshots draw colour TFT screens with their real pixels. `screenshot {"view": "device", "ms": 6000}`
renders the project as a physical device in 3D instead (the pet as a handheld, a rover in its
arena, an arm on its table), from a fresh simulation run to `ms`.

## Scenario steps

One action per step. `within_ms` = keep simulating up to that long until it holds; without it the
check is instant.

| Step | Example |
| --- | --- |
| advance time | `{"run_ms": 500}` (or `wait_ms`) |
| buttons | `{"press": "btn1", "hold_ms": 50}`, `{"release": "btn1"}` (a loop that redraws a display or calls `delay()` can miss presses shorter than one loop; hold 100–300 ms like a finger) |
| sensor / prop | `{"set": "pot1.position", "value": 0.8}` |
| serial input | `{"serial_write": "feed\n"}` |
| fault | `{"inject_fault": "oled1", "kind": "i2c_nack"}` |
| serial output | `{"expect_serial": "LED on", "within_ms": 1100}`, regex INSIDE expect_serial: `{"expect_serial": {"regex": "t=\\d+"}, "within_ms": 1100}`, `"absent": true` |
| printed number | `{"expect_serial_value": "energy", "op": ">=", "value": 60, "within_ms": 1500}` (latest `energy=64` / `energy: 64`; robust to tick timing) |
| screen | `{"expect_display": "oled1", "region": [40, 16, 48, 32], "lit": {"min": 20}}`, or a golden frame: `read_display {"part": "oled1", "save_as": "sad-face"}` then `{"expect_display": "oled1", "matches": "sad-face", "within_ms": 3000}` (2 % of pixels may differ; `tolerance` changes it) |
| pin | `{"expect_pin": "uno.D13", "level": "high"}`, `{"expect_pin": "uno.A0", "voltage": {"min": 2.4, "max": 2.6}}` |
| part state | `{"expect_part": "oled1.lit", "op": ">", "value": 0}`; ops `== != > >= < <= contains matches` |
| robot world | `{"expect_part": "world.collisions", "op": "==", "value": 0}` (see Robots) |
| no damage | `{"expect_no_errors": true}` (overcurrent and similar error diagnostics) |

`expect_serial` only matches text printed after the previous `expect_serial` match, so a sequence
of them checks order. A `within_ms` check passes the moment it holds, so after an input wait for the
side the value moves toward (`"<"` when it should drop): a condition that was already true before the
input passes at 0 ms and tests nothing, and `run_tests` warns about it. Part state fields are listed by `get_part` (`state`) and shown by `run`.

## Faults

| kind | Effect |
| --- | --- |
| `disconnect` | the part is electrically gone; an I2C device also disappears from the bus |
| `i2c_nack` / `i2c_nack_data` / `i2c_garbage` | the device NACKs its address / NACKs data / reads 0xFF |
| `noisy` | a numeric sensor value jitters ±5 % every 10 ms (deterministic; `field`, `amplitude`) |
| `clear` | remove the faults on that part (faults survive `run {"reset": true}`: they model the hardware) |
| `wifi_drop` | the sandbox access point disappears (pass the ESP-01's id as `part`); joined modules print `WIFI DISCONNECT`; `clear` brings it back and modules rejoin after about 2.5 s |
| not yet | `brownout`, `clock_drift`, `flash_full` return an error saying so |

## Watching an agent work

- `pnpm start` / `pnpm jumper serve --project <dir>` (add `--no-web` for the live link and MCP without the web app, `--built` to serve `apps/web/dist`) opens the canvas following the folder live: parts pop in,
  wires draw themselves, an agent cursor points at what is being edited, the step list shows each
  `why` with Accept / Reject, and runs stream LEDs, displays and serial. Any process editing the
  folder (MCP server, CLI, another agent) shows up.
- `pnpm jumper replay <dir>/.jumper/actions.jsonl --speed 2` plays a session back in the browser.
  `--actor mcp` keeps only the agent's calls (a person's CLI checks in the same folder are left
  out), `--client claude` one client, `--session <sid>` one server process; a mixed log prints the
  counts per actor.
- `pnpm jumper record <dir>/.jumper/actions.jsonl out.mp4 --speed 2` renders that replay to a video
  (Playwright Chromium + ffmpeg).

## Troubleshooting

| Message | Do |
| --- | --- |
| `Docker is installed but not running` | Start Docker Desktop (`open -a Docker`), wait for "running", build again. |
| `the 'docker' command was not found` | Install Docker Desktop. Everything except `build` works without it. |
| `Could not install the Arduino library '…'` | Check the exact Library Manager name (case-sensitive); the first install needs network. |
| `jumper.json … is invalid` | The file was edited by hand; the message lists each bad field. |
| A test fails with `it is 0` right after boot | Add `within_ms`: the firmware may not have drawn / switched yet. |
| `run_tests` passes with a warning `already held 0 ms after step N` | The check did not wait for the change; compare toward the new value. |
| `No Jumper server at http://localhost:7780` (`--attach`) | Start it: `pnpm start` in the Jumper repo. |
| `MCP session '…' is not known to this Jumper server` | The server restarted: reconnect the client (Claude Code: `/mcp`, reconnect). |
| `Port 7780 is in use` (with `--strict-port`) | Another serve runs; use it, or pass `--port`. Without `--strict-port` the next free port is used and printed. |
| A test fails right after `{"press": …, "hold_ms": N}` and says the hold hid a reaction | Press without `hold_ms`, check with `within_ms`, then release. |
| `timed out: … Fix: raise the scenario's "timeout_ms"` | Raise it in `write_scenario`, or shorten the waits. |
| `run_tests` failed and you want to see the screen | `run_tests {"images": true}` attaches the screen at each scenario's first failing check; every result also has `visual`, one line per check with what the device looked like then. |
| `read_network_log` is empty | The ESP-01 never joined: TX → the board's RX pin, RX ← the board's TX pin through a divider, CH_PD high, and run at least 3 s. |
| A picture of a test's key moment | `screenshot {"path": "shots/x.png", "scenario": "<id>", "at_step": N}` (CLI: `jumper screenshot x.png --scenario <id> --at-step N`). |

## Limits (honest)

- AVR boards only (Uno, Nano). Wi-Fi only through an ESP-01 on the sandbox network (one host, `ai.jumper`); no ESP32 yet.
- Headless `run` ignores `speed` (it always runs as fast as possible, about 5× real time).
- The CLI is one process per command: simulation state (time, pressed buttons) does not carry over
  between `jumper run` calls; use the MCP server, `jumper display --ms`, or scenarios for multi-step
  interaction.
- `fidelity_report` lists what the simulation does not model; always include its
  `testOnRealDevice` list in your final answer.
