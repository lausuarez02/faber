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
| `ws://localhost:7780/live` | live events: `hello`, `action`, `presence` (connected agents, what each is running), `agent-state` (none / building / idle / done), `firmware` (a new hex, the page reloads it), `auto-run` (after your build / run / run_tests the page starts the device itself), `project` (the active project changed; a `hello` follows), `version` (a new history version) |
| `GET /api/agent-state`, `GET /api/firmware` | the one agent state; the newest built hex with its board and backend (`avr8js` or `rp2040js`) |
| `GET /api/projects`, `GET /api/history` | the Projects gallery and the active project's versions ([projects.md](projects.md)) |
| `GET /v/:id` | the shareable local viewer link (`viewer_url`): opens the project live and runs it |
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

### The hardware skill (any agent)

Jumper's hardware know-how (the design loop, the rules of thumb, how the parts go inside, and how to
answer "what do I need to buy, print and assemble") is written once in `packages/agent-skill` and
reaches every agent without touching your global config:

Design notes: [agent-skill.md](agent-skill.md).

- **Every MCP client**: the server instructions end with a short "Design for assembly" block; the
  prompts `design-device` (argument `goal`), `build-kit` and `design-for-assembly`; the resource
  `jumper://docs/hardware` with the whole guide ([hardware-guide.md](hardware-guide.md)).
- **Claude Code in a project folder**: `<project>/.claude/skills/jumper-hardware/SKILL.md`, which
  Claude Code loads by itself. `new_project`, `jumper new`, Open in Agent → Launch and
  `jumper skill install --project <dir>` write it, `<project>/AGENTS.md` for Codex and others, and
  `<project>/CLAUDE.md`, which imports AGENTS.md so Claude Code always has the guide in context (a
  skill is only loaded when the model picks it).
  A file you wrote yourself is kept unless `--force`; `JUMPER_AGENT_FILES=0` turns it off.
  `jumper skill print [--target skill|agents|guide|instructions]` prints it.
- **Claude Code anywhere**: the plugin in [plugins/jumper](../plugins/jumper/README.md) (the skill
  plus the MCP server of a running Jumper). You install it yourself, e.g.
  `claude --plugin-dir /path/to/jumper/plugins/jumper` for one session.

A test (`packages/session/test/agent-skill-sync.test.ts`) fails when the skill names a tool Jumper
does not have, or when one of its rules contradicts the server instructions or a tool description.

## Talk to the person first

The people asking for a device are often beginners. The server instructions say the same:

- **Plan first.** For a new wish call `plan_device {"goal": "…", "constraints": {"pocket": true,
  "budget_usd": 30, "battery_hours": 8}}` and tell the person the plan in plain words before
  placing anything: what it will do, the board and why, each part and why, the rough size of the
  case, the battery life, the price, and which parts are simulated as themselves, with a stand-in,
  agent-made or not at all. Figures a part does not have are listed in `missing_data`, not guessed.
  For something to hold (pocket, small, tiny, a keychain, any named shape such as an egg) the plan
  is compact by itself (`constraints.compact` forces it either way): the smallest board, screen,
  speaker and LiPo cell for the runtime (3 h when none is asked), no boost converter unless a part
  really needs 5 V, and `size_budget` says the footprint, the thickest part and each smaller
  choice with the mm it saves. `check_design` then flags parts a built device may not need
  (`boost-not-needed`, `board-bigger-than-needed`, `smaller-speaker`, ...).
- **Ask one question** when the wish leaves a real choice open (`plan_device` returns `question`,
  e.g. "should it only tell you the plant is thirsty, or also water it?"), then wait.
- **No jargon** unless the person uses it: "the screen", "a resistor that protects the light".
- **One project per idea:** `new_project {"folder": true, "name": "Plant waterer"}` makes a new
  folder, registers it in the Projects gallery and (on `jumper serve`) switches to it. Never
  overwrite the playground or another project.
- **Real parts first.** If the catalog lacks a part, make it with `create_part` (agent-made,
  behavioral) when that tool exists, rather than a stand-in. If you do use a stand-in, call
  `mark_stand_in {"id": "soil1", "real": "capacitive soil moisture sensor"}`: BOM, WIRING and
  TEST-ON-HARDWARE then print the real part with a STAND-IN note.
- **Say what the simulation cannot check** (`plan_device`'s `cannot_check`, `fidelity_report`):
  feel, sound, real battery life, stand-ins.

## The loop

1. `plan_device`, then `get_project` (or `new_project {"folder": true}`) to see where you are.
2. `search_parts` for each thing the device needs, then `get_part` for its pins, wiring hint,
   libraries and a minimal Arduino example.
3. `place_part` (leave out x/y: Jumper lays parts out tidily) and `connect` pins written as
   `"part.pin"`. Pass a short `why` with your edits: the human sees it in the step list.
4. `check_design` and fix every error (LED resistors, power, voltage levels, I2C pins, shorts…).
5. `write_file` the sketch (`firmware/main.ino`). Print what happens with `Serial.begin(115200)`:
   serial output is how you and the tests check behaviour. `set_libraries` for library includes.
6. `run {"ms": 3000}`: builds if needed, then simulates and returns serial output, pin levels, part
   states and diagnostics. `read_display` shows a screen as ASCII art. `interact` presses buttons,
   `set_sensor_value` changes what a sensor reads; run again to see the firmware react.
7. `write_scenario` for each behaviour of the goal, then `run_tests`. Fix the firmware or wiring
   until every scenario passes. When all pass (and `check_design` has no errors) your pending steps
   are accepted (`accepted_by: "tests"`); otherwise the result's `pending_steps.why` says why not.
8. `inject_fault` (`disconnect`, `i2c_nack`, `noisy`) to see the firmware cope with a broken world.
9. **Show it.** `screenshot` returns the picture inline (show it to the person) plus its absolute
   path; `record` makes an MP4 of your build and the device running (your calls only; returns
   `path` and a `url`); `viewer_url` gives a link that opens the project live, running, with
   buttons the person can press. Give paths and links, not terminal commands.
10. `fidelity_report`: tell the human what was verified and what still has to be tested on the real
    device. `export` (BOM with buy links, wiring table, firmware.hex) at the end; `delete_file`
    removes stale screenshots or debug sketches.
11. **A real device** (round 6, when the person wants to hold it, or asks about size, a case, a 3D
    printer or a factory). Battery devices: `set_assembly "soldered"`. Then
    `design_case {"shape": "pebble"}` (or `puck`, `pill`, `rounded-box`, `keychain`; `save: false`
    for a variant to compare, `update_case` for wall, closure, clip, colour, which face a part sits
    on). Round 7: any other shape the person asks for (an egg, a heart, a bean, a character) is
    `{"shape": "custom", "outline": <SVG path in mm, or {"points": [...], "smooth": true}>}`, at a
    `size_mm` if they gave one; there is no preset per object. Test it first with `check_fit` (no CAD,
    under a second): when the parts do not fit the size it lists each miss in mm and tried
    suggestions (a smaller screen, speaker or LiPo cell, a board on its edge, less rounded rims, or
    "make it N mm bigger"); tell the person the trade-off and let them pick. Round 8: Jumper works
    out how the parts go inside by itself (flat first, then layers) and `propose_layout` shows the
    three best ways (`thinnest`, `smallest`, `balanced`, with sizes, layers and reasons); tell the
    person the choice in plain words ("one flat layer: 17.5 mm thick but 131 mm tall; or the cell
    behind the screen: ...") and build it with `design_case` / `update_case {"layout": "<id>"}`
    (default `auto` = balanced; pin a part with `placements` to move it). Show the front and exploded renders it returns, the measured size and the checks (pocket
    verdict, screen window, button travel, USB access). Round 12: then `get_assembly_plan`, how to
    build it for that case: everything to buy (the parts, wire by gauge and length, Kapton, a foam
    pad, screws), everything to print (each STL with its face on the bed), and the steps in an order
    that works (which half each part goes into and when, leads soldered before a part covers its
    pads, the wires between the halves with the case open like a book, the battery last and
    insulated, a test before closing), a picture each. Walk the person through it in plain words and
    fix what its `assembly-*` checks flag. Then `export_manufacturing`: one folder +
    zip with the case (STL, 3MF, STEP, drawing, print notes), BOM, wiring, netlists, wire cuts,
    firmware, the assembly steps with their pictures and the test plan, for a 3D printer or a supplier. Say plainly
    that the print, the plastic and the hand feel were not tested. Guide: [enclosures.md](enclosures.md).
    For a person who builds it themselves, `get_build_kit` (round 12) gives everything in one kit:
    what to buy (exact variants, store links per region, totals per store, the things people
    forget), what to print (material, orientation, supports, grams, time, print-service notes), the
    tools and skill, step-by-step assembly into the case (pictures, wires with cut lengths and
    colours, cautions, checks), flashing and troubleshooting. Give them `kit.html`. Guide:
    [build-kit.md](build-kit.md).

### check_design codes worth knowing

| Code | Meaning |
| --- | --- |
| `led-no-resistor` | No resistor anywhere along the LED's path (either leg, or past another LED in series). |
| `logic-level` | A pin drives a net above what a receiving pin takes (+0.3 V). 3.3 V into a 5 V input is fine; 5 V into a 3.3 V input is not. |
| `overvoltage` / `part-needs-5v` | A supply above a module's rating / a 5 V module on a 3.3 V rail. |
| `parallel-regulators` | Two supply outputs (regulators, a battery) on one net, e.g. an L298N's 5V on the Uno's 5V. |
| `usb-backfeed` | A battery path reaches a board's USB pin (VBUS / 5V) with no diode: put a `schottky-diode` in it, stripe towards the board (round 6, [power.md](power.md)). |
| `no-power-path` | Nothing takes the battery to the board's supply pins (an error with `set_power {"usb": false}`). |
| `ldo-dropout` | The board's 3.3 V regulator runs out of headroom before the cell is empty: says at which cell voltage, so the firmware can sleep in time. |
| `battery-reversed`, `battery-overvoltage` | A cell wired backwards; a full cell on a 3.3 V pin. |
| `rail-3v3-budget` | More current on a board's 3V3 pin than it gives (50 mA Uno/Nano, 300 mA RP2040 boards, or `limits.max3v3mA`). |
| `far-apart` (info) | A part more than 600 px from everything it is wired to: move it closer so the picture is readable. |

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
| `&m=<what the person said>` | Optional, URL-encoded, 60 characters max: the model answers the person's words in character (the mock says it heard them). In the web app, the Network panel's **Say something to the pet** box attaches the typed text to the pet's next request, so a sketch with only TALK / FEED buttons still hears it. |
| `set_ai_mode {"mode": "live"}` | A real model (claude-haiku-5-5 through `ANTHROPIC_API_KEY`, else the logged-in `claude` CLI) answers. Fails with the reason when neither exists. |
| `run_live {"ms": 8000}` | Runs at real time so the live answer arrives while the firmware waits. Not deterministic. `run` and `run_tests` always use the deterministic mock. |

`jumper serve` starts the gateway for the web app's Live mode itself (port `JUMPER_AI_GATEWAY_PORT`,
default 8787, the next free port when taken; `JUMPER_AI_GATEWAY=off` skips it; the page finds it at
`GET /api/ai-gateway`).

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
  (Playwright Chromium + ffmpeg). It keeps only the agent's calls when the log is mixed
  (`--actor all` for everything). Agents call the `record` tool instead: the MP4 lands in
  `<project>/.jumper/media/`, served at `http://localhost:7780/api/media/<file>`.
- `viewer_url` / `GET /v/<project id>` on `jumper serve`: the shareable local link that opens the
  project live and starts it running (`?follow=…&autorun=1`).

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
| `record: cannot record a video here … playwright install chromium` | Run the command it names once (`pnpm --filter @jumper/web exec playwright install chromium`); meanwhile use `screenshot`. |
| `viewer_url: no Jumper server is running` | The agent is on a stdio server: start `pnpm start` and connect to `http://localhost:7780/mcp`. |
| `new_project: … already has N parts` | Pass `folder: true` for a new idea; `overwrite: true` only to throw the project away. |
| A picture of a test's key moment | `screenshot {"path": "shots/x.png", "scenario": "<id>", "at_step": N}` (CLI: `jumper screenshot x.png --scenario <id> --at-step N`). |

## Limits (honest)

- AVR boards only (Uno, Nano). Wi-Fi only through an ESP-01 on the sandbox network (one host, `ai.jumper`); no ESP32 yet.
- Headless `run` ignores `speed` (it always runs as fast as possible, about 5× real time).
- The CLI is one process per command: simulation state (time, pressed buttons) does not carry over
  between `jumper run` calls; use the MCP server, `jumper display --ms`, or scenarios for multi-step
  interaction.
- `fidelity_report` lists what the simulation does not model; always include its
  `testOnRealDevice` list in your final answer.
