# Jumper MCP tool reference

<!-- Generated from packages/session/src/catalog.ts by `pnpm --filter @jumper/mcp gen:docs`. Do not edit by hand. -->

37 tools. The same operations are CLI subcommands (`jumper <tool> --json`) and run with the same rules. Setup and a worked example: [agents.md](agents.md).

## Recommended loop (sent as the server's instructions)

```text
Jumper is a hardware sandbox: Arduino boards, parts and wires on a canvas, real compiled firmware, a deterministic simulator. You drive it only through these tools; you never need Jumper's source.

The loop:
1. get_project (or new_project) to see where you are.
2. search_parts for each thing the device needs, then get_part to learn its pins, wiring and example code.
3. place_part (omit x/y), connect pins ("uno.D13" -> "r1.1"); pass a short why so the human sees your reasoning.
4. check_design and fix every error (LED resistors, power, I2C pins).
5. write_file firmware/main.ino (Serial.begin(115200) and print what happens); set_libraries if it includes libraries.
6. run {ms} (builds automatically): read serial, pins, part states; read_display for screens; interact / set_sensor_value to play with it.
7. write_scenario for each behaviour of the goal, then run_tests; fix firmware or wiring until all pass.
8. inject_fault (disconnect, i2c_nack, noisy, wifi_drop) to check the firmware copes, if it matters. Wi-Fi devices (ESP-01) reach a sandbox network with an AI at http://ai.jumper/v1/pet: read_network_log shows what they did; set_ai_mode live + run_live lets a real model answer.
9. fidelity_report: tell the human what was verified and what must be tested on the real device. screenshot and export when done.

Conventions: pins are "part.pin"; ids have no dots; time is virtual ms; every error says what failed, why, and the fix: do what it says. Full guide: resource jumper://docs/agents.
```

## Tools

| Tool | What | Changes the project |
| --- | --- | --- |
| [`new_project`](#new_project) | Start a project | yes (undoable step) |
| [`get_project`](#get_project) | Project summary | no (read-only) |
| [`search_parts`](#search_parts) | Find parts | no (read-only) |
| [`get_part`](#get_part) | Part details | no (read-only) |
| [`place_part`](#place_part) | Place a part | yes (undoable step) |
| [`move_part`](#move_part) | Move or rotate a part | yes (undoable step) |
| [`remove`](#remove) | Remove a part, wire or test scenario | yes (undoable step) |
| [`connect`](#connect) | Wire two pins | yes (undoable step) |
| [`disconnect`](#disconnect) | Remove wires | yes (undoable step) |
| [`set_part_property`](#set_part_property) | Change a part property | yes (undoable step) |
| [`set_libraries`](#set_libraries) | Declare Arduino libraries | yes (undoable step) |
| [`set_world`](#set_world) | Set the robot's world | yes (undoable step) |
| [`write_file`](#write_file) | Write firmware source | yes (undoable step) |
| [`read_file`](#read_file) | Read a file | no (read-only) |
| [`list_files`](#list_files) | List firmware files | no (read-only) |
| [`build`](#build) | Compile the firmware | simulation only |
| [`run`](#run) | Simulate | simulation only |
| [`read_serial`](#read_serial) | Read serial output | no (read-only) |
| [`read_pin`](#read_pin) | Measure a pin | no (read-only) |
| [`read_display`](#read_display) | See a display | simulation only |
| [`interact`](#interact) | Press / set a control | simulation only |
| [`set_sensor_value`](#set_sensor_value) | Set a sensor reading | simulation only |
| [`inject_fault`](#inject_fault) | Inject a fault | simulation only |
| [`write_scenario`](#write_scenario) | Write a test scenario | yes (undoable step) |
| [`run_tests`](#run_tests) | Run test scenarios | simulation only |
| [`check_design`](#check_design) | Design rule check | no (read-only) |
| [`fidelity_report`](#fidelity_report) | How far to trust the simulation | no (read-only) |
| [`screenshot`](#screenshot) | Picture of the canvas | simulation only |
| [`export`](#export) | Export for the real build | simulation only |
| [`list_steps`](#list_steps) | Edit history | no (read-only) |
| [`undo`](#undo) | Undo the last step | yes (undoable step) |
| [`redo`](#redo) | Redo | yes (undoable step) |
| [`accept_step`](#accept_step) | Accept steps | simulation only |
| [`reject_step`](#reject_step) | Reject a step | yes (undoable step) |
| [`set_ai_mode`](#set_ai_mode) | Mock or live pet AI | simulation only |
| [`read_network_log`](#read_network_log) | Network activity | no (read-only) |
| [`run_live`](#run_live) | Run at real time with the live AI | simulation only |

### new_project

Start a project in the server's project folder from a template. Templates: "blank" (empty), "uno" (Arduino Uno + empty sketch), "nano", "blink" (Uno + resistor + LED + Blink sketch + passing tests; good to learn the loop). Refuses to replace an existing project unless overwrite is true. Returns the project summary. Usually the first call; skip it if get_project shows parts already.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `template` | string |  | one of `blank`, `uno`, `nano`, `blink`. Default blank. |
| `name` | string |  | Project name (default: folder name). |
| `overwrite` | boolean |  | Replace an existing jumper.json. |

### get_project

Compact summary of the project: parts ("led1 (led) {\"color\":\"red\"} @440,-210"), wires ("w1: uno.D13 -> r1.1"), nets with 3+ pins, pins in use per part, firmware (board, sketch, libraries, built: fresh|stale|missing|none), files, scenario ids and pending steps. Call it whenever you are unsure of ids; it is cheap.

No arguments.

### search_parts

Search the parts catalog by words (id, name, tags, description): "oled", "button", "distance sensor", "motor driver". Every word must match. Optional category: board, output, input, passive, sensor, power, display, motor, communication, misc. Returns up to 25 {type, name, category, fidelity, about}. Empty query lists everything. Use the returned `type` with get_part and place_part.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string |  | e.g. "oled" or "push button" |
| `category` | string |  |  |

### get_part

Everything needed to wire and program one part type: pins ("SDA: digital i2c-sda - I2C data. Uno: A4"), props with ranges/options, I2C addresses, state fields you can test (expect_part) or read, fidelity gaps, a wiring hint, typical connections for an Uno, the Arduino libraries it needs, and a minimal Arduino example. Read this before connecting a part you have not used; pin ids are case-sensitive in jumper.json (connect is forgiving).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | string | yes | Part type id from search_parts, e.g. "ssd1306-oled-i2c". |

### place_part

Add a part to the canvas. Omit x/y and Jumper picks a tidy, non-overlapping spot (boards at the origin, parts in a row above the board). Omit id to get a short one: boards "uno"/"nano", then "led1", "btn1", "oled1", "r1", "buzzer1". props sets part properties, e.g. {"resistance": 220} or {"color": "green"} (strings like "10k" work for numbers). Returns {id, pins, wiring hint, typical_connections}: typical_connections names free board pins (a second button gets D3 when the first was told D2), so you can connect them as given. Placing a board when a sketch exists wires up firmware automatically. Common mistake: forgetting the resistor for an LED (check_design catches it).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | string | yes | Part type, e.g. "arduino-uno", "led", "resistor", "pushbutton", "ssd1306-oled-i2c", "buzzer". |
| `id` | string |  | Optional instance id: letter first, then letters/digits/_/- (no dots). |
| `x` | number |  | Canvas px (20 px = 0.1 in). Omit for auto-layout. |
| `y` | number |  |  |
| `rotation` | number |  | one of `0`, `90`, `180`, `270` |
| `props` | object |  | e.g. {"resistance": 220} |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### move_part

Move a part to x/y (canvas px) and/or rotate it (0/90/180/270). Wires follow. Only changes the drawing, never the circuit. Example: {"id": "led1", "x": 480, "y": -200}.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `x` | number |  |  |
| `y` | number |  |  |
| `rotation` | number |  | one of `0`, `90`, `180`, `270` |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### remove

Remove a part (and every wire touching it), a single wire or a test scenario, by id: {"id": "led2"}, {"id": "w5"} or {"id": "boots"} (e.g. the starter template's placeholder test). Removing the firmware board also removes the firmware link (the files stay). Undoable.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### connect

Draw a wire between two pins: {"from": "uno.D13", "to": "r1.1"}. Pin ids come from place_part/get_part ("A"/"C" on an LED, "1"/"2" on a resistor, "1a"/"2a" on a pushbutton, "D0".."D13", "A0".."A5", "5V", "3V3", "GND" on an Uno). Several wires on one pin are fine (that is how you share GND/5V). Returns the wire id, how forgiving names were resolved, design warnings about this connection (e.g. LED without resistor, I2C on the wrong pins) and reminders for the sketch you have not written yet (e.g. INPUT_PULLUP for a button). Refuses a direct 5V-to-GND short. Already-connected pins return the existing wire.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `from` | string | yes | Pin as "part.pin", e.g. "uno.D13". Forgiving: "uno.13" → uno.D13, "oled1.gnd" → oled1.GND, "uno.GND" → a free GND pin. |
| `to` | string | yes | Pin as "part.pin", e.g. "r1.1". Forgiving: "uno.13" → uno.D13, "oled1.gnd" → oled1.GND, "uno.GND" → a free GND pin. |
| `color` | string |  | CSS colour, e.g. "#FF4D2E". Default: red for supply, dark for ground, varied for signals. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### disconnect

Remove a wire by id ({"wire": "w3"}) or the wires between two pins ({"from": "uno.D13", "to": "r1.1"}), or every wire on one pin ({"from": "uno.D13"}).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `wire` | string |  |  |
| `from` | string |  | Pin as "part.pin", e.g. "uno.D13". Forgiving: "uno.13" → uno.D13, "oled1.gnd" → oled1.GND, "uno.GND" → a free GND pin. |
| `to` | string |  | Pin as "part.pin", e.g. "r1.1". Forgiving: "uno.13" → uno.D13, "oled1.gnd" → oled1.GND, "uno.GND" → a free GND pin. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### set_part_property

Change a saved part property: {"id": "r1", "prop": "resistance", "value": 330}, {"id": "led1", "prop": "color", "value": "green"}, {"id": "oled1", "prop": "address", "value": "0x3D"}. Validated against the part (ranges, options). A running simulation picks it up live (and run {reset: true} starts from it); the result's "simulation" says what happened (parts the robot world uses restart the simulation at 0 ms). For temporary sensor readings during a run use set_sensor_value instead.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `prop` | string | yes |  |
| `value` | string \| number \| boolean | yes |  |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### set_libraries

Set the Arduino libraries the sketch needs (replaces the list): {"libraries": ["Adafruit SSD1306", "Adafruit GFX Library"]}. Names as in the Arduino Library Manager; "Name@1.2.3" pins a version, a bare name gets Jumper's pinned version (dependencies such as Adafruit BusIO are added for you). Preinstalled: Adafruit SSD1306, Adafruit GFX Library, Adafruit BusIO, Servo, U8g2, Adafruit BME280/MPU6050/Unified Sensor, RTClib, LiquidCrystal I2C, LiquidCrystal_PCF8574, MPU6050. Wire, SPI, EEPROM and SoftwareSerial are built in (do not list them). Others install on first build (needs network).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `libraries` | string[] | yes |  |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### set_world

Robots only: the physical world the simulation moves the robot in, saved in jumper.json. Rover: {"world": {"arena": {"width": 300, "height": 200}, "obstacles": [{"id": "crate", "shape": "box", "x": 160, "y": 80, "w": 36, "h": 36, "angle": 15}, {"id": "pillar", "shape": "circle", "x": 240, "y": 150, "r": 12}], "robot": {"chassis": "chassis1", "leftMotor": "motor1", "rightMotor": "motor2", "sonar": "sonar1", "start": {"x": 40, "y": 40, "heading": 0}}}} (cm, degrees; robot part ids are filled in when there is exactly one chassis / two motors / one sonar). The rover needs a robot-chassis-2wd part and two dc-motor parts driven by an l298n; the sonar (hc-sr04) then reads real distances to walls and obstacles. Give the rover a safety margin in tests: {"expect_part": "world.min_clearance_cm", "op": ">=", "value": 3} (any gap above 0 counts as no collision). Servo arm: {"world": {"arm": {"base": {"x": 0, "y": 5}, "links": [10, 8], "joints": [{"servo": "servo1", "zero": 90, "direction": 1, "offset": 90}, …], "targets": [{"id": "cup", "x": 12, "y": 6, "r": 2}]}}}. After run, the result has world {robot {x, y, heading}, collisions, min_clearance_cm, travelled_cm} (arm: {gripper, reached}; scenarios use world.gripper_x, world.gripper_y, world.reached); scenarios check them with {"expect_part": "world.collisions", "op": "==", "value": 0} (the chassis part state has the same pose too); screenshot draws the arena / arm next to the circuit. null removes the world.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `world` | object \| null | yes | { arena, obstacles, walls, robot } and/or { arm } |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### write_file

Create or replace a firmware file under firmware/: {"path": "firmware/main.ino", "content": "void setup() {...}"}. The first .ino you write becomes the main sketch and is linked to the board automatically. Extra .h/.cpp files go in the same folder. Write the whole file every time (no patches). Use Serial.begin(115200) and print what happens: serial output is how you (and scenarios) verify behaviour. Returns notes when something about the sketch layout matters.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | yes | "firmware/main.ino", "firmware/pet.h"… |
| `content` | string | yes |  |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### read_file

Read a firmware file ("firmware/main.ino") or "jumper.json". Use it to look at the line a compiler error points at.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | yes |  |

### list_files

List files under firmware/ and which one is the main sketch.

No arguments.

### build

Compile the sketch with arduino-cli (pinned toolchain in Docker; identical sources are served from cache in milliseconds). Returns {ok, size "flash 1992/32256 B (6%), ram …", errors: ["firmware/main.ino:12:5: 'foo' was not declared in this scope (fix: …)"], warnings}. Each error has file:line and a concrete fix hint. If Docker is not running the error says how to start it. run and run_tests build automatically when sources changed, so you rarely need this except to check errors.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `force` | boolean |  | Ignore the cache. |

### run

Run the simulation for ms of virtual time (deterministic, faster than real time; continues from where the last run stopped unless reset is true or the circuit/firmware changed). Builds first if needed. Returns {t_ms, serial (new output), pins {"D13": "out H 5.00V", "D9": "out pulse 50Hz 1500us" for servo pulses, "D5": "out PWM 490Hz duty 70%"}, parts {"led1": {"brightness": 0.62, "on": true}}, diagnostics (overcurrent, floating inputs…), world (robots: pose, collisions, first_collision {t_ms, x, y, heading, with: [what it hit]}, closest gap; arms: gripper position, targets reached), notes (e.g. a near miss under 2 cm)}. Example: {"ms": 3000}. Then press buttons with interact, change sensors with set_sensor_value, and run again.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `ms` | number | yes | Virtual ms to simulate, e.g. 2000 (max 600000). |
| `reset` | boolean |  | Restart from 0 ms first. |
| `speed` | number |  | Ignored headless (always as fast as possible); kept for compatibility. |

### read_serial

Everything the firmware printed since a byte offset: {"since": 0} for all. Returns {text, next}; pass next as since to read only new output.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `since` | number |  |  |

### read_pin

Voltage, logic level (high/low/undefined) and, for board pins, the firmware pin mode, at the current simulated time: {"pin": "uno.D13"} → {voltage: 5, level: "high", mode: "output", connected_to: ["r1.1"]}.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `pin` | string | yes | Pin as "part.pin", e.g. "uno.D13". Forgiving: "uno.13" → uno.D13, "oled1.gnd" → oled1.GND, "uno.GND" → a free GND pin. |

### read_display

The screen of a display part (ssd1306-oled-i2c, lcd1602-i2c, or a colour TFT such as ili9341-tft, where any non-black pixel counts as lit) as ASCII art ("#" lit, "." dark), plus lit_pixels. scale 2 (default) shows a 128x64 OLED as 64x32 characters; scale 1 is exact, 4 is a thumbnail. Run first so the firmware has drawn something. region [x, y, w, h] crops to exact pixels and counts region_lit (e.g. the face area). save_as "sad-face" saves that frame (or region) as a golden snapshot (snapshots/sad-face.json) that scenarios check with {"expect_display": "oled1", "matches": "sad-face", "within_ms": 3000}: the way to regression-test what the screen shows.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` | string | yes |  |
| `scale` | number |  |  |
| `region` | number[] |  | [x, y, w, h] in screen pixels; exact (scale 1). |
| `save_as` | string |  | Save this frame as a golden snapshot for expect_display matches, e.g. "sad-face". |

### interact

Act on a part in the running simulation: {"part": "btn1", "action": "press"}, then run, then {"action": "release"}; "click" = press, hold 200 ms of simulated time (hold_ms to change), release, and returns the serial printed meanwhile; "toggle" for switches; "set" with value for knobs (e.g. {"part": "pot1", "action": "set", "value": 0.8}). Not saved to the project. Run afterwards to let the firmware react.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` | string | yes |  |
| `action` | string | yes | one of `press`, `release`, `click`, `toggle`, `set` |
| `value` | number \| string \| boolean |  |  |
| `key` | string |  | Which control on multi-control parts (keypad key). |
| `hold_ms` | number |  | click only: how long the press lasts (default 200 ms). |

### set_sensor_value

Set what a sensor reads in the running simulation: {"part": "ldr1", "field": "lux", "value": 50}, {"part": "pot1", "field": "position", "value": 0.25}, {"part": "sonar1", "field": "distance", "value": 12}. Fields are the part's props (get_part lists them with ranges). Not saved to the project (use set_part_property for that).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` | string | yes |  |
| `field` | string | yes |  |
| `value` | number \| string \| boolean | yes |  |

### inject_fault

Break something on purpose to harden the firmware: "disconnect" (module unplugged: no power, gone from the I2C bus), "noisy" (a sensor value jitters ±5% every 10 ms, deterministic; optional field and amplitude), "i2c_nack" (the device NACKs its address: Wire.endTransmission() returns 2, display.begin() fails), "i2c_nack_data", "i2c_garbage" (reads return 0xFF), "wifi_drop" (on a Wi-Fi module such as an ESP-01: the sandbox access point disappears, the module prints WIFI DISCONNECT and closes its links; survives reset; "clear" on the same part brings it back and the module reconnects), "clear" (remove faults on that part). Not simulated yet (returns an error saying so): brownout, clock_drift, flash_full. Example: {"part": "oled1", "kind": "i2c_nack"}, then run and check that the firmware reports it.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` | string | yes |  |
| `kind` | string | yes | one of `disconnect`, `noisy`, `i2c_nack`, `i2c_nack_data`, `i2c_garbage`, `clear` |
| `field` | string |  |  |
| `amplitude` | number |  |  |

### write_scenario

Add or replace a deterministic test in jumper.json. Steps run in order, one action per step. Inputs: {"run_ms": 500}, {"press": "btn1", "hold_ms": 50}, {"release": "btn1"}, {"set": "pot1.position", "value": 0.8}, {"serial_write": "feed\n"}, {"inject_fault": "oled1", "kind": "disconnect"} (noisy also takes "field" and "amplitude"). Checks: serial text {"expect_serial": "LED on", "within_ms": 1100}; serial regular expression, with the pattern INSIDE expect_serial: {"expect_serial": {"regex": "hunger=\\d+"}, "within_ms": 1100}; "absent": true forbids the text; a printed number {"expect_serial_value": "energy", "op": ">=", "value": 60, "within_ms": 1500} (reads the latest "energy=64" / "energy: 64", so tests do not break on tick timing); a pin {"expect_pin": "uno.D13", "level": "high", "within_ms": 50} (or "voltage": {"min": 2, "max": 3}); a part state {"expect_part": "buzzer1.on", "op": "==", "value": true, "within_ms": 500} (ops == != > >= < <= contains matches; fields from get_part "state"); a screen {"expect_display": "oled1", "region": [40, 16, 48, 32], "lit": {"min": 20}} or against a golden frame saved with read_display {save_as} {"expect_display": "oled1", "matches": "sad-face", "within_ms": 3000} (tolerance 0.02 = 2% of pixels may differ; animations: within_ms waits for a matching frame); robots {"expect_part": "world.collisions", "op": "==", "value": 0} (world fields: collisions, min_clearance_cm, travelled_cm, x, y, heading, speed, sonar_cm, touching; arm: gripper_x, gripper_y, reached). Assert a real safety margin, e.g. world.min_clearance_cm >= 3, not > 0 (any gap counts as no collision). {"expect_no_errors": true}. Timing: within_ms = keep simulating up to that long until it holds, and it passes the moment it holds, so after an input wait for the side the value moves TOWARD (e.g. "<" when it should drop): a condition that was already true before the input passes at 0 ms and tests nothing (run_tests warns). Without within_ms the check is instant. expect_serial only matches text printed after the previous expect_serial match. Write scenarios from the user's goal, one per behaviour.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | e.g. "feeds-when-button-pressed" |
| `name` | string |  |  |
| `description` | string |  |  |
| `steps` | object[] | yes |  |
| `timeout_ms` | number |  | Virtual-time limit (default 60000). |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step. |

### run_tests

Run all scenarios (or one by id/name), each from a fresh simulation at 0 ms. Builds first if needed. Returns {passed, failed, results}; a failure says which step, what was expected, what was seen instead, every step's timing and the serial tail. Each result also has visual: one line per check with its virtual time, what it saw and what the device looked like then (screen pixels lit, robot pose and sonar, arm position); the web app's Tests panel shows the same checks as a filmstrip. Pass images: true to also get a PNG of the screen at each failing check (or the last check when all pass). Fix the firmware or wiring and run again until all pass.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `images` | boolean |  | Attach screen PNGs of key checks (default false). |

### check_design

Electrical sanity check: LED without resistor, shorts, supply rails tied together, 5 V on a 3.3 V pin, modules with VCC/GND unconnected, I2C on the wrong pins, shared I2C addresses, missing I2C pull-ups, GPIO wired straight to a rail, two outputs on one net, motors on a GPIO, buttons without pull-up (reads the sketch; while the sketch is still the starter template this is an info reminder), Serial pins in use, power budget of the board's 5V rail (servos, motor drivers fed from it; loads on a battery do not count), pinless parts not used by the world, plus live simulator diagnostics (overcurrent, floating inputs) after a run. Each issue says what, why and the fix. Run it after wiring and before trusting a design.

No arguments.

### fidelity_report

Honesty report: per part (exact/behavioral/stub and weakest areas), per area (logic, timing, analog, power, radio: ok/approx/not simulated, with notes) and a 'test on the real device' checklist. Include its summary and checklist in your final answer to the user.

No arguments.

### screenshot

Render the canvas to a PNG (parts, wires, glowing LEDs, OLED pixels, HIGH wires in green; robots also get a panel with the arena from above or the arm from the side) at the current simulated moment: {"path": "shots/pet.png"} (relative to the project; default screenshot.png). Colour TFT screens are drawn with their real pixels. Returns the file path. Run first to capture a live state, or pass view "device" to see the device as a 3D product shot ({"view": "device", "ms": 4000}), or pass scenario (and at_step) to replay a test in a fresh simulation up to that step and picture that exact moment: {"path": "shots/playback.png", "scenario": "playback", "at_step": 12}. A .svg path writes SVG.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string |  |  |
| `scale` | number |  | 1 = 1 px per canvas px (default). |
| `scenario` | string |  | Scenario id to replay first (fresh simulation). |
| `at_step` | number |  | Stop after this step index (default: the last step). |
| `view` | string |  | one of `canvas`, `device`. canvas (default) or device: the physical device in 3D (handheld with its live screen, rover in its arena, arm on its table) rendered from a fresh simulation at ms. |
| `ms` | number |  | view device only: virtual ms to render at (default: the current session time, or 3000). |

### export

Write export/BOM.md (quantities, values, buy links), export/WIRING.md (wire table and nets), export/firmware.hex (when built) and export/TEST-ON-HARDWARE.md (checklist from the fidelity report). Returns the BOM text and an upload command.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `dir` | string |  | Default export/ in the project. |

### list_steps

The recent steps (groups of edits with their why) and their status: pending, accepted, rejected, undone.

No arguments.

### undo

Undo the last applied step (all its edits, including file writes). redo brings it back.

No arguments.

### redo

Re-apply the last undone step (only possible until the next edit).

No arguments.

### accept_step

Mark a step (or all pending ones, the default) as accepted by the human: {"step": 3} or {}.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `step` | number \| string |  |  |

### reject_step

Revert one step by id, even if it is not the last: {"step": 3}. Entities changed again by later steps are kept (the result lists them); if later steps depend on it (e.g. wires on a part it added) it refuses and says which to reject first.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `step` | number | yes |  |

### set_ai_mode

Choose who answers the sandbox AI host (http://ai.jumper/v1/pet) that an ESP-01 Wi-Fi module reaches: "mock" (default; deterministic canned pet replies, 400 to 800 ms virtual latency, always used by run and run_tests) or "live" (a real model, claude-haiku-5-5, through ANTHROPIC_API_KEY or the logged-in claude CLI; used only by run_live, which runs the simulation at real time). Returns the provider that will answer. Fails with the reason when no live provider exists.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `mode` | string | yes | one of `mock`, `live` |

### read_network_log

What the simulated device did on the sandbox network: Wi-Fi joins and drops, DNS lookups, TCP connections and every HTTP request with status, virtual latency, the provider that answered (Mock / Claude CLI / Anthropic API) and the response body. Pass since (a seq from a previous call) to get only new entries. Use it when a Wi-Fi sketch does not get its answer: an empty log means the module never joined.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `since` | number |  | Return entries after this seq. |
| `limit` | number |  | Max entries (default 50, max 200). |

### run_live

Run the simulation for ms at no more than real time with the live AI allowed (set_ai_mode live first), so a real model answers the device's HTTP requests and the virtual latency is the real one. Not deterministic; use run / run_tests for tests. Returns the requests made meanwhile. Press buttons with interact before it (e.g. the pet's TALK button) and read the screen with screenshot after.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `ms` | number | yes | Virtual (= wall) milliseconds, max 60000. |
