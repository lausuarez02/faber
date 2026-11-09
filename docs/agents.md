# Jumper for agents

Jumper lets an AI agent (Claude Code, Codex, any MCP client, or a shell script) go from a one-line
goal ("a tamagotchi on an OLED with three buttons") to a wired, programmed and **tested** device,
using only Jumper's tools. The same operations are exposed three ways with identical rules:

| Face | Start it | Best for |
| --- | --- | --- |
| MCP server (stdio) | `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project <dir>` | Claude Code, Codex, Cursor, any MCP client |
| CLI | `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs <command>` (or `pnpm jumper <command>` inside the repo) | shells, CI, scripts (`--json` for machine output) |
| Browser | `node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs serve --project <dir>` | a human watching the agent work live, accepting / rejecting its steps |

Proof it works: three unedited runs where Claude Code and Codex built a tamagotchi, a rover and a
servo arm from a one-line goal, with videos and action logs, are in
[media/agent-runs](media/agent-runs/README.md).

The paths below are absolute paths on the maintainer's machine, so they work from any directory.
On another machine replace `/Users/lautaritos/Projects/hardware/jumper` with where you cloned
Jumper. Every tool is documented in [mcp-tools.md](mcp-tools.md) (generated from the tool
definitions).

## Setup

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
  { "expect_part": "world.min_clearance_cm", "op": ">", "value": 3 } ] }
```

World fields: `collisions`, `min_clearance_cm`, `travelled_cm`, `x`, `y`, `heading`, `speed`,
`sonar_cm`, `touching` (rover); `gripper_x`, `gripper_y`, `reached` (arm, a comma list of target ids).
The chassis part's own state (`chassis.x`, `chassis.collisions`…) has the same pose.

**Servo robot arm**: `servo-sg90` parts on PWM pins (`#include <Servo.h>`, `set_libraries ["Servo"]`),
`potentiometer` wipers on `A0`/`A1`; `set_world {"world": {"arm": {"base": {"x": 0, "y": 6},
"links": [12, 10], "joints": [{"servo": "shoulder"}, {"servo": "elbow", "zero": 90}],
"targets": [{"id": "cup", "x": 15, "y": 4, "r": 2}]}}}` gives forward kinematics (gripper position,
targets reached) for `run`, tests and the screenshot's side view.
`set_sensor_value {"part":"pot1","field":"position","value":0.8}` (or a `set` scenario step) moves a
knob; `{"expect_part": "world.reached", "op": "contains", "value": "cup"}` checks the gripper.

Working references: `examples/rover` and `examples/robot-arm` (each with passing scenarios and a
video in `media/`).

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
| serial output | `{"expect_serial": "LED on", "within_ms": 1100}`, `{"expect_serial": {"regex": "t=\\d+"}}`, `"absent": true` |
| pin | `{"expect_pin": "uno.D13", "level": "high"}`, `{"expect_pin": "uno.A0", "voltage": {"min": 2.4, "max": 2.6}}` |
| part state | `{"expect_part": "oled1.lit", "op": ">", "value": 0}`; ops `== != > >= < <= contains matches` |
| robot world | `{"expect_part": "world.collisions", "op": "==", "value": 0}` (see Robots) |
| no damage | `{"expect_no_errors": true}` (overcurrent and similar error diagnostics) |

`expect_serial` only matches text printed after the previous `expect_serial` match, so a sequence
of them checks order. Part state fields are listed by `get_part` (`state`) and shown by `run`.

## Faults

| kind | Effect |
| --- | --- |
| `disconnect` | the part is electrically gone; an I2C device also disappears from the bus |
| `i2c_nack` / `i2c_nack_data` / `i2c_garbage` | the device NACKs its address / NACKs data / reads 0xFF |
| `noisy` | a numeric sensor value jitters ±5 % every 10 ms (deterministic; `field`, `amplitude`) |
| `clear` | remove the faults on that part (faults survive `run {"reset": true}`: they model the hardware) |
| not yet | `brownout`, `wifi_drop`, `clock_drift`, `flash_full` return an error saying so |

## Watching an agent work

- `pnpm jumper serve --project <dir>` (add `--no-web` to start only the live hub for a canvas that is already open) opens the canvas following the folder live: parts pop in,
  wires draw themselves, an agent cursor points at what is being edited, the step list shows each
  `why` with Accept / Reject, and runs stream LEDs, displays and serial. Any process editing the
  folder (MCP server, CLI, another agent) shows up.
- `pnpm jumper replay <dir>/.jumper/actions.jsonl --speed 2` plays a session back in the browser.
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

## Limits (honest)

- AVR boards only (Uno, Nano). No Wi-Fi, no ESP32 yet.
- Headless `run` ignores `speed` (it always runs as fast as possible, about 5× real time).
- The CLI is one process per command: simulation state (time, pressed buttons) does not carry over
  between `jumper run` calls; use the MCP server, `jumper display --ms`, or scenarios for multi-step
  interaction.
- `fidelity_report` lists what the simulation does not model; always include its
  `testOnRealDevice` list in your final answer.
