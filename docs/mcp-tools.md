# Jumper MCP tool reference

<!-- Generated from packages/session/src/catalog.ts by `pnpm --filter @jumper/mcp gen:docs`. Do not edit by hand. -->

60 tools. The same operations are CLI subcommands (`jumper <tool> --json`) and run with the same rules. Setup and a worked example: [agents.md](agents.md).

## Recommended loop (sent as the server's instructions)

```text
Jumper is a hardware sandbox: Arduino boards, parts and wires on a canvas, real compiled firmware, a deterministic simulator. You drive it only through these tools; you never need Jumper's source.

Talk to the person first:
- Plan first. For a new wish call plan_device {goal, constraints} and tell the person the plan in plain words (what it will do, the board, the parts and why, size, battery life, price, and what is simulated exactly, with a stand-in, agent-made or not at all) before placing anything.
- If the wish is ambiguous (plan_device returns a question, or you would have to guess), ask ONE clarifying question and wait.
- Many people are beginners: no jargon unless they use it first (say "the screen", not "SSD1306 over I2C"; explain a resistor as "protects the light"). Answer in the person's language.
- One project per idea: new_project {"folder": true, "name": …} creates a new project folder (or the person opens one with --project); never overwrite the playground or someone's other project.
- Prefer real catalog parts. If one is missing, make it with create_part (agent-made, behavioral) when that tool exists, rather than a stand-in; if you must use a stand-in, call mark_stand_in so exports name the real part.

The loop:
1. get_project (or new_project {folder: true}) to see where you are.
2. search_parts for each thing the device needs, then get_part to learn its pins, wiring and example code.
3. place_part (omit x/y), connect pins ("uno.D13" -> "r1.1"); pass a short why so the human sees your reasoning.
4. check_design and fix every error (LED resistors, power, voltage levels, I2C pins). Battery devices: cell → charger BAT, charger OUT → switch → schottky-diode → the board's 5V (a Pico's VSYS directly); set_power {"usb": false} then run to prove it runs from the battery.
5. write_file firmware/main.ino (Serial.begin(115200) and print what happens); set_libraries if it includes libraries.
6. run {ms} (builds automatically): read serial, pins, part states; read_display for screens; interact / set_sensor_value to play with it.
7. write_scenario for each behaviour of the goal, then run_tests; fix firmware or wiring until all pass (then your pending steps are accepted).
8. inject_fault (disconnect, i2c_nack, noisy, wifi_drop) to check the firmware copes, if it matters. Wi-Fi devices (ESP-01) reach a sandbox network with an AI at http://ai.jumper/v1/pet (add &m=<what the person said> to pass their words): read_network_log shows what they did; set_ai_mode live + run_live lets a real model answer. Boards with Wi-Fi in the emulator (ESP32 family) join Jumper's device network: plain WiFi.begin() / HTTPClient / WebSockets / MQTT sketches work unchanged (write them for the real device, real root CA); set_network (mode mock by default, internet + allow list, secrets by NAME, values in .env), add_mock_api for any API (HTTP, streamed chunks, WebSocket frames, MQTT broker), try_request to check one, read_network for what the device did, inject_network_fault (wifi_drop, weak_signal, latency, http_error, timeout, dns_fail) and scenario steps {"request": ...} / {"network_fault": ...}.
9. Show it: screenshot returns the picture inline (show it) plus its path; record makes an MP4 of your build and the device running; viewer_url gives a link where the person runs it and presses its buttons. Give links and paths, never a terminal command, to people who did not ask for one.
10. fidelity_report: tell the person what was verified and, honestly, what the simulation cannot check (plan_device's cannot_check: real feel, sound, battery life, stand-ins). export when done; delete_file removes stale shots or debug sketches.
11. A real device: when the person wants to hold it (or asks about size, a case, printing or a factory), the flow ends with design_case {"shape": "pebble" | "puck" | "pill" | "rounded-box" | "keychain"} (save: false for side-by-side variants; update_case to change wall, closure, clip). Any other shape the person wants (an egg, a heart, a bean, a character) is shape "custom" with an outline you draw (SVG path in mm, or points with smooth: true) and, if they gave one, size_mm; there is no preset per object. Test it first with check_fit (under a second, no CAD): when the parts do not fit the asked size it lists what misses by how much and smaller parts that would fit (a smaller LiPo cell, a smaller screen or speaker, a board on its edge) or "make it N mm bigger"; tell the person the trade-off and let them choose before design_case. Case choices cost size: do not pin positions (placements x_mm / y_mm / layer / face) unless the person asked for that spot; leave dome_mm and the edges on auto (each mm of dome is a mm of thickness per face); call propose_layout before design_case; every check_fit / propose_layout / design_case / update_case answer has costs (what each of your choices adds, with the update_case call that relaxes it): read it and relax the costly choices unless the person asked for them. Pocket and hand-held devices (an egg, a pet, a remote): aim for 20 mm thick or less. Then show its renders and the measured size and checks (pocket verdict, screen window, button travel, USB access), then export_manufacturing: one folder + zip a supplier or a 3D printer can use (STL / 3MF / STEP, drawing, BOM, wiring, netlists, wire cuts, firmware, numbered assembly steps, test plan). Battery devices: set_assembly "soldered" first. Say honestly that the print and the hand feel were not tested.

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
| [`create_part`](#create_part) | Make a missing part | yes (undoable step) |
| [`update_part`](#update_part) | Change a made part | yes (undoable step) |
| [`list_project_parts`](#list_project_parts) | Made parts | no (read-only) |
| [`plan_device`](#plan_device) | Plan a device before building it | no (read-only) |
| [`record`](#record) | Video of the build | simulation only |
| [`viewer_url`](#viewer_url) | Link to watch and play | no (read-only) |
| [`delete_file`](#delete_file) | Delete a file | yes (undoable step) |
| [`mark_stand_in`](#mark_stand_in) | Mark a part as a stand-in | yes (undoable step) |
| [`restore_version`](#restore_version) | Restore an earlier version | yes (undoable step) |
| [`set_power`](#set_power) | Plug or unplug the board's USB cable | yes (undoable step) |
| [`set_assembly`](#set_assembly) | Say how the device is built (breadboard or soldered) | yes (undoable step) |
| [`design_case`](#design_case) | Design a printable case | yes (undoable step) |
| [`update_case`](#update_case) | Change the case | yes (undoable step) |
| [`check_fit`](#check_fit) | Test a case fit | no (read-only) |
| [`propose_layout`](#propose_layout) | Propose how the parts are distributed | no (read-only) |
| [`get_case`](#get_case) | Case report | no (read-only) |
| [`export_manufacturing`](#export_manufacturing) | Factory pack | simulation only |
| [`read_speech`](#read_speech) | Read what it said | no (read-only) |
| [`read_network`](#read_network) | Device network log | no (read-only) |
| [`add_mock_api`](#add_mock_api) | Add or update a mock API | yes (undoable step) |
| [`inject_network_fault`](#inject_network_fault) | Network fault | simulation only |
| [`set_network`](#set_network) | Network settings | yes (undoable step) |
| [`try_request`](#try_request) | Try a request in the sandbox | simulation only |

### new_project

Start a project from a template. For a new idea pass folder: true (or a folder name): Jumper makes a NEW project folder for it, registers it in the Projects gallery and switches to it, so the person's other projects (and the playground) are never overwritten: {"folder": true, "name": "Plant waterer", "template": "uno"}. Without folder it starts the project in the current folder and refuses to replace existing parts unless overwrite is true. Templates: "blank" (empty), "uno" (Arduino Uno + empty sketch), "nano", "blink" (Uno + resistor + LED + Blink sketch + passing tests; good to learn the loop), plus any board templates listed in the enum. Returns {dir, id, viewer_url (when Jumper's server runs), opened, …project summary}. Skip it if get_project shows the person already started this device.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `template` | string |  | one of `blank`, `uno`, `nano`, `pico`, `xiao-rp2040`, `rp2040-zero`, `xiao-esp32s3`, `xiao-esp32c3`, `esp32-c3-supermini`, `esp32`, `esp32-s3`, `blink`. Default blank. |
| `name` | string |  | Project name (default: folder name). |
| `folder` | boolean \| string |  | true: a new folder named after name; a string: that folder name (slugged, e.g. "plant-waterer"). Created under the server's projects folder; a taken name gets -2, -3… |
| `overwrite` | boolean |  | Replace an existing jumper.json in the current folder (throws the old project away). |

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
| `value` | string \| number \| boolean \| object | yes | The new value. Text props such as a DFPlayer's clips take "N: words" lines or an object {"1": "hi!"}. |
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

Add or replace a deterministic test in jumper.json. Steps run in order, one action per step. Inputs: {"run_ms": 500}, {"press": "btn1", "hold_ms": 50}, {"release": "btn1"}, {"set": "pot1.position", "value": 0.8}, {"serial_write": "feed\n"}, {"inject_fault": "oled1", "kind": "disconnect"} (noisy also takes "field" and "amplitude"). Checks: serial text {"expect_serial": "LED on", "within_ms": 1100}; serial regular expression, with the pattern INSIDE expect_serial: {"expect_serial": {"regex": "hunger=\\d+"}, "within_ms": 1100}; "absent": true forbids the text; a printed number {"expect_serial_value": "energy", "op": ">=", "value": 60, "within_ms": 1500} (reads the latest "energy=64" / "energy: 64", so tests do not break on tick timing); a pin {"expect_pin": "uno.D13", "level": "high", "within_ms": 50} (or "voltage": {"min": 2, "max": 3}); a part state {"expect_part": "buzzer1.on", "op": "==", "value": true, "within_ms": 500} (ops == != > >= < <= contains matches; fields from get_part "state"); a screen {"expect_display": "oled1", "region": [40, 16, 48, 32], "lit": {"min": 20}} or against a golden frame saved with read_display {save_as} {"expect_display": "oled1", "matches": "sad-face", "within_ms": 3000} (tolerance 0.02 = 2% of pixels may differ; animations: within_ms waits for a matching frame); robots {"expect_part": "world.collisions", "op": "==", "value": 0} (world fields: collisions, min_clearance_cm, travelled_cm, x, y, heading, speed, sonar_cm, touching; arm: gripper_x, gripper_y, reached). Assert a real safety margin, e.g. world.min_clearance_cm >= 3, not > 0 (any gap counts as no collision). {"expect_no_errors": true}. Words a talking device (DFPlayer Mini + speaker) said: {"said": "dizzy", "within_ms": 500} (case-insensitive part of the clip's words; {"said": {"regex": "^hi"}}; "part": "df1" picks one DFPlayer; "absent": true forbids it; only clips heard through a wired speaker count, and each said step matches clips after the previous match). Timing: within_ms = keep simulating up to that long until it holds, and it passes the moment it holds, so after an input wait for the side the value moves TOWARD (e.g. "<" when it should drop): a condition that was already true before the input passes at 0 ms and tests nothing (run_tests warns). Without within_ms the check is instant. expect_serial only matches text printed after the previous expect_serial match. Write scenarios from the user's goal, one per behaviour.

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

Write export/BOM.md (quantities, values, buy links), export/WIRING.md (wire table and nets), export/firmware.hex (when built; firmware.bin, the merged flash image built for the real board, on ESP32 boards) and export/TEST-ON-HARDWARE.md (checklist from the fidelity report). Returns the BOM text and an upload command.

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

### create_part

Make a part the catalog does not have (search_parts found nothing that fits), as data: pins, physical facts and one behaviour template. No code runs; the simulator builds the model from the template. behavior.kind: "digital-input" (PIR, IR obstacle, tilt, hall switch: an output pin HIGH/LOW from a boolean field), "analog-sensor" (soil moisture, gas, flex, force: quantity → voltage curve, optional comparator DO pin), "actuator" (drive "load": pump / motor / solenoid between plus and minus with rated_v and rated_ma; drive "logic": relay or MOSFET module with VCC/GND/IN and optional relay contacts), "i2c-device" (address, registers with raw values or physical fields, WHO_AM_I; read with Wire), "uart-device" (SoftwareSerial line protocol: scripted replies, greeting, periodic stream such as NMEA), "display" (reuse the ssd1306 / st7735 / ili9341 controller with your own resolution or round glass). Visual: pass svg (sanitized: no scripts, no external links; then give size and pin x/y) or leave it out for a generated labelled drawing. Example: {"part": {"id": "soil-moisture-sensor", "name": "Capacitive soil moisture sensor v1.2", "category": "sensor", "description": "Analog soil moisture probe; AOUT falls as the soil gets wetter.", "pins": [{"id": "GND", "type": "ground"}, {"id": "VCC", "type": "power", "voltage": {"min": 3.3, "max": 5.5}}, {"id": "AOUT", "type": "analog"}], "behavior": {"kind": "analog-sensor", "output": "AOUT", "quantity": {"id": "moisture", "unit": "%", "min": 0, "max": 100, "default": 40}, "curve": [{"value": 0, "volts": 3.0}, {"value": 100, "volts": 1.2}]}, "current_ma": {"typ": 5, "max": 8}, "price_usd": 2.5, "dimensions_mm": {"w": 98, "h": 23, "d": 4}}}. The id must not be a built-in type. Returns {type, pins, state, fidelity: "agent-made: behavioral, unverified", warnings, next}; then place_part / connect / run / run_tests it like any part. Always tell the person the part is agent-made and unverified.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` | object | yes | The part, format jumper-part/1: pins, physical data and one behavior template. docs/custom-parts.md has an example per behavior kind. |
| `svg` | string |  | Optional SVG drawing (viewBox = part.size, a <circle data-pin="ID"> per pin is recommended). Scripts, event handlers, <foreignObject> and external links are removed. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "the catalog has no soil sensor". Consecutive edits with the same why form one undoable step. |

### update_part

Change an agent-made part of this project: pass the whole new definition as part (same id), and/or svg (a new drawing, or null for the generated one). Leave part out to change only the drawing. Refuses to drop pins that wires use (disconnect them first). Placed copies use the new definition from the next run. Undo with undo like any edit.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | The part type id given to create_part. |
| `part` | object |  | The whole new definition (jumper-part/1, same schema as create_part), same id. |
| `svg` | string \| null |  | New SVG, or null to use the generated drawing. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "the catalog has no soil sensor". Consecutive edits with the same why form one undoable step. |

### list_project_parts

The agent-made parts of this project (parts/<id>/part.json): {type, name, behavior, pins, placed}, plus problems when a part file cannot be loaded. Built-in parts are listed by search_parts.

No arguments.

### plan_device

Call this FIRST for a new wish, before placing anything. Turns the goal into a plan to show the person: which board and why, a parts list with one line of why per part, which parts Jumper simulates as themselves ("simulated-exactly"), with a stand-in ("stand-in"), as an agent-made part ("agent-made", via create_part) or not at all ("not-simulated"), a rough size (parts and case in mm), battery life from each part's current and the battery capacity, total price and buy links, plus what the simulation cannot check. Example: {"goal": "a virtual pet that fits in my pocket and beeps when hungry", "constraints": {"pocket": true, "budget_usd": 30}}. Returns {summary, question?, board {type, why}, bom [{type, name, qty, why, source, current_ma, price_usd, buy_links}], size_mm {parts, enclosure}, battery {type, capacity_mah, avg_ma, hours}, size_budget {footprint_mm2, flat_mm, max_thickness_mm, thickest, parts_volume_cm3, choices} (compact plans: each smaller choice and the mm it saves), total_usd, cannot_check, warnings, missing_data, next}. Tell the person the summary in plain words; if question is set, ask it (one question) and wait. Figures a part does not have are listed in missing_data, never guessed.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `goal` | string | yes | The wish in the person's words, e.g. "a night light that plays a song". |
| `constraints` | object |  | Optional limits. |

### record

Record an MP4 the person can watch: your build replayed from the action log (parts appearing with your "why" captions, wires, the sketch, the device running in each run / run_tests, tests turning green). Only your calls by default (actor "mcp"); "all" adds the person's and the CLI's. Takes about as long as the video (speed is picked for about a minute unless given). Returns {path (absolute), url (open it in a browser), viewer_url (the live project, when Jumper's server runs), duration_s}. Give the person the path or url, not a terminal command. Fails within seconds, saying how to install it, when Chromium is missing. Example: {} or {"speed": 3, "size": "1280x720"}.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `actor` | string |  | one of `mcp`, `all`. Whose calls to show (default "mcp", the agent). |
| `ms` | number |  | Longest video in wall-clock ms (default: long enough for the whole replay). |
| `speed` | number |  | Replay speed-up (default: about a one-minute video). |
| `size` | string |  | Video size, default "1280x720". |

### viewer_url

A link the person opens in their browser on this computer: the project live on the canvas, the device running with its real firmware, buttons and knobs they can press, following every change you make. Needs Jumper's local server (jumper serve / pnpm start); over plain stdio it says how to start one. Returns {url, note}. Give it to the person whenever they ask to see or try the device.

No arguments.

### delete_file

Delete a file inside the project, e.g. a stale screenshot or a debug sketch: {"path": "shots/old.png"} or {"path": "firmware/probe.ino"}. Text files are an undoable step (undo brings them back); images, videos and other binary files are moved to .jumper/trash/ (the result says where). Refuses jumper.json, Jumper's own .jumper/ state and the board's main sketch (overwrite it with write_file instead).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | yes | Relative to the project folder. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "remove the old test shots". |

### mark_stand_in

Say that a placed part stands in for a real part Jumper does not have, so BOM / WIRING exports print the real part with a STAND-IN note instead of the stand-in: {"id": "soil1", "real": "capacitive soil moisture sensor"}. plan_device lists stand-ins in its bom (source "stand-in"). Prefer a real part, or create_part, over a stand-in. {"id": "soil1", "real": null} clears it.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Part id, e.g. soil1. |
| `real` | string \| null | yes | The real part in plain words. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "remove the old test shots". |

### restore_version

Put the project back the way it was at version N of its history (parts, wires, props, scenarios, firmware block and the sketch files). Versions are numbered from 1 in the order changes happened; the web app's History scrubber shows them, and GET /api/history lists them with who made each change and why. Restoring is a new step (undo brings the newer state back), and the firmware is rebuilt on the next run. Example: {"version": 4, "why": "go back to before the buzzer was added"}. Returns {version, step, changes: {added, removed, changed}} (entity keys such as "part:led1", "wire:w3", "file:firmware/main/main.ino").

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | integer | yes | Version number, 1 = the first change in the history. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "back to the working version". |

### set_power

Say whether a USB cable is plugged into the board (jumper.json power.usb; default true, as before). {"usb": false} runs the device only from what is wired to the board's supply pins: check that a pocket device really runs from its battery (cell → charger BAT, charger OUT → switch → schottky-diode → the board's 5V / VBUS, or a Pico's VSYS). Without a battery path the firmware is held in reset (no serial, nothing on the screen) and check_design reports no-power-path. Applies live to a running simulation (unplugging mid-run is a power cut; plugging in boots it from reset). The TP4056 module's own USB socket is separate: set_part_property <charger> usb true plugs a charger into it. Returns {usb, board_powered, supply: {net, volts, from}, battery?: {part, volts, ma, hours_left}} (from the running simulation, or the circuit at 0 ms when nothing ran yet).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `usb` | boolean | yes | true = a USB cable is plugged into the board; false = it runs from its battery path only. |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "check it runs from the battery". |

### set_assembly

How the real device is put together; export follows it. "soldered" = hand-wired point to point (or perfboard) inside a case: export writes WIRE-CUTS.csv (every wire with its length, colour and gauge), ASSEMBLY.md (numbered soldering steps, power path first) and a BOM with hook-up wire and heat-shrink, never breadboards or dupont wires. "breadboard" = a desk prototype with dupont wires. Default: soldered for a project with a case or a pocket board (XIAO, RP2040-Zero), breadboard otherwise. Example: {"style": "soldered", "why": "it goes in a pocket case"}. Returns {style, note}.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `style` | string | yes | one of `breadboard`, `soldered`. breadboard \| soldered |
| `why` | string |  | Short reason shown to the human in the step list, e.g. "check it runs from the battery". |

### design_case

Pack the project's parts into a two-part printable case and write everything needed to make it into <project>/case/: STL per body in print orientation (front, back, button plungers, light pipes), case.3mf (a coloured build plate for slicers), STEP (assembly with the parts as named solids, front, back: what factories ask for), renders (front / back / exploded / inside), an A3 drawing (SVG, PDF when Chromium is installed) with sizes, hole positions, tolerances, material and print settings, and PRINT.md. Shapes: "rounded-box", "pill", "pebble" (organic oval), "puck" (round), "keychain" (tab with a lanyard hole) are starting points; "custom" is ANY outline you draw (an egg, a heart, a bean, a guitar pick ...) with outline, at any size with size_mm: Jumper packs the parts inside that real outline (a narrow end holds less) and, when they do not fit a fixed size, says what misses by how much and which smaller parts would fit (fits: false, misses, suggestions; nothing is saved). Check a fit first in under a second with check_fit (or dry_run: true). Before it: propose_layout (how the parts go inside) and read its costs. Do not pin positions (placements) unless the person asked; leave dome_mm and the edges on auto; a pocket or hand-held device should be 20 mm thick or less. Example: {"shape": "pebble"} or {"shape": "custom", "outline": "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z"} or {"shape": "puck", "params": {"closure": "screws", "color": "#2B3038"}, "placements": {"pet": {"face": "left"}}}. Returns the CaseReport: size_mm (e.g. 70.7 x 94.3 x 19.6), inner_mm, pocket (thickness first: "fits" = comfortable, ≤ 18 mm thick within 110 x 70 mm; "tight" ≤ 22 mm; "no" = bulky), volume_cm3, ok, checks (fits, screen-window, buttons-reachable, connector-access, min-wall, printable, watertight, no-intersection, size-match), files, costs (what each of your choices adds: pins, faces, dome, edges, a fixed size, wall, each with the update_case call that relaxes it, the costliest first, and relax_all), plus the front and exploded renders inline. save: false writes to case/variants/<shape>/ and leaves jumper.json alone (compare shapes). Takes 3 to 30 s (real CAD; a pebble with domed faces is the slowest). What the case cannot check: snap strength and fit on your printer (print the two shells first and test), real tolerances of clone modules (about ±1 mm), drop / water / heat, the route of each wire.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `shape` | string | yes | one of `rounded-box`, `pill`, `pebble`, `puck`, `keychain`, `custom` |
| `outline` | any |  | Shape "custom" only: the FRONT outline of the case in mm, drawn however you like. Either an SVG path string (M L H V C S Q T A Z, absolute or relative; y points DOWN like any SVG) e.g. an egg 56 x 73 mm: "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z", or {"points": [[x, y], ...], "smooth": true} with y UP (the top of the device is +y; smooth = a closed curve through the points). One closed shape that does not cross itself; sharp corners are rounded so they print. Only the proportions matter unless size_mm is given. |
| `size_mm` | object |  | Fixed overall size in mm: {"w": 58, "h": 75, "d": 22} (any of them; the rest auto). The outline is scaled to w x h and the case is exactly that size; parts that do not fit come back as misses with smaller swaps instead of the case growing. Leave it out for auto (the smallest that holds the parts). |
| `params` | object |  | Case parameters (all optional): wall_mm (≥ 1.2, default 1.6), corner_radius_mm (rounded-box / keychain, default 4), color ('#F2EDE4'), lanyard_hole (default true for keychain), belt_clip, closure ('snap' \| 'screws' = M2 into heat-set inserts), tolerance_mm (default 0.2 FDM), process ('fdm' \| 'resin' \| 'injection'), gap_mm (wiring room around parts, default 1.5). 3D finish, any shape (number or "auto"): edge_radius_front_mm / edge_radius_back_mm (round-over of each rim), dome_mm / dome_back_mm (how far the faces bulge; leave auto, about 1 mm: every mm of dome is a mm of thickness per face, over 3 mm is warned), depth_mm (overall thickness). Leave the finish on auto unless the person asked for it. |
| `front` | string |  | Part id whose screen faces out of the front (default: the first display). |
| `placements` | object |  | Only for what the person asked for (Jumper places every part by itself; each pin can cost many mm: read costs). Per part id, where it goes: {"pet": {"face": "right", "y_mm": 4}, "bat": {"face": "inside"}, "xiao": {"on_edge": true}}. face: front \| back \| left \| right \| top \| bottom (as seen holding it, screen towards you) or inside (no opening); x_mm / y_mm from the centre of that face (+x right, +y up looking straight at it); rotation 0 / 90 / 180 / 270; on_edge: stand the board on its edge (narrower, thicker). Parts left out are auto-packed (screen front, USB bottom, buttons on the sides, buzzer / speaker grille at the back; a speaker that should talk through the front: {"spk": {"face": "front"}}). |
| `exclude` | string[] |  | Part ids that are not inside the case. |
| `layout` | string |  | one of `auto`, `thinnest`, `smallest`, `balanced`. How the parts are distributed inside (round 8). Jumper works it out automatically: it lays the parts out flat first (side by side, one layer), then in two or three layers, inside the real outline, and proposes three layouts: "thinnest" (fewest layers), "smallest" (least volume), "balanced" (pocket-friendly: thickness over 18 mm and a footprint over 110 x 70 mm weigh up). "auto" (default) = balanced. See them first with propose_layout. Pin a part with placements ({"bat": {"x_mm": 0, "y_mm": -20}} or {"layer": 1}) and the rest is arranged around it. |
| `dry_run` | boolean |  | true: only test the fit (no CAD, nothing written, under a second): the same answer as check_fit. |
| `save` | boolean |  | Default true: store the case in jumper.json (undoable) and write case/. false: write case/variants/<shape>/ only. |
| `images` | boolean |  | Default true: return the front and exploded renders inline. |
| `costs` | boolean |  | Default true: add costs (what each of your choices adds to the size), a few seconds after the CAD. |
| `why` | string |  | Short reason shown in the step list. |

### update_case

Change the existing case: any of shape, outline, size_mm, params, front, placements, exclude. params, size_mm and placements are merged into what is there; a placement or a size value set to null is removed (back to auto). Example: {"params": {"wall_mm": 2, "closure": "screws"}} or {"placements": {"pet": {"face": "top"}}} or {"shape": "puck"} or {"size_mm": {"w": 64, "h": 84}} or {"outline": {"points": [[0, 40], [24, 16], [28, -4], [13, -32], [-13, -32], [-28, -4], [-24, 16]], "smooth": true}}. Regenerates every file in case/ and returns the CaseReport like design_case (with costs) (or fits: false with misses and suggestions when a fixed size cannot hold the parts; nothing changes then). Fails when there is no case yet (use design_case). What the case cannot check: snap strength and fit on your printer (print the two shells first and test), real tolerances of clone modules (about ±1 mm), drop / water / heat, the route of each wire.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `shape` | string |  | one of `rounded-box`, `pill`, `pebble`, `puck`, `keychain`, `custom` |
| `outline` | any |  | Shape "custom" only: the FRONT outline of the case in mm, drawn however you like. Either an SVG path string (M L H V C S Q T A Z, absolute or relative; y points DOWN like any SVG) e.g. an egg 56 x 73 mm: "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z", or {"points": [[x, y], ...], "smooth": true} with y UP (the top of the device is +y; smooth = a closed curve through the points). One closed shape that does not cross itself; sharp corners are rounded so they print. Only the proportions matter unless size_mm is given. |
| `size_mm` | object |  | Fixed overall size in mm: {"w": 58, "h": 75, "d": 22} (any of them; the rest auto). The outline is scaled to w x h and the case is exactly that size; parts that do not fit come back as misses with smaller swaps instead of the case growing. Leave it out for auto (the smallest that holds the parts). |
| `params` | object |  | Case parameters (all optional): wall_mm (≥ 1.2, default 1.6), corner_radius_mm (rounded-box / keychain, default 4), color ('#F2EDE4'), lanyard_hole (default true for keychain), belt_clip, closure ('snap' \| 'screws' = M2 into heat-set inserts), tolerance_mm (default 0.2 FDM), process ('fdm' \| 'resin' \| 'injection'), gap_mm (wiring room around parts, default 1.5). 3D finish, any shape (number or "auto"): edge_radius_front_mm / edge_radius_back_mm (round-over of each rim), dome_mm / dome_back_mm (how far the faces bulge; leave auto, about 1 mm: every mm of dome is a mm of thickness per face, over 3 mm is warned), depth_mm (overall thickness). Leave the finish on auto unless the person asked for it. |
| `front` | string |  |  |
| `placements` | object |  | Only for what the person asked for (Jumper places every part by itself; each pin can cost many mm: read costs). Per part id, where it goes: {"pet": {"face": "right", "y_mm": 4}, "bat": {"face": "inside"}, "xiao": {"on_edge": true}}. face: front \| back \| left \| right \| top \| bottom (as seen holding it, screen towards you) or inside (no opening); x_mm / y_mm from the centre of that face (+x right, +y up looking straight at it); rotation 0 / 90 / 180 / 270; on_edge: stand the board on its edge (narrower, thicker). Parts left out are auto-packed (screen front, USB bottom, buttons on the sides, buzzer / speaker grille at the back; a speaker that should talk through the front: {"spk": {"face": "front"}}). |
| `exclude` | string[] |  |  |
| `layout` | string |  | one of `auto`, `thinnest`, `smallest`, `balanced`. How the parts are distributed inside (round 8). Jumper works it out automatically: it lays the parts out flat first (side by side, one layer), then in two or three layers, inside the real outline, and proposes three layouts: "thinnest" (fewest layers), "smallest" (least volume), "balanced" (pocket-friendly: thickness over 18 mm and a footprint over 110 x 70 mm weigh up). "auto" (default) = balanced. See them first with propose_layout. Pin a part with placements ({"bat": {"x_mm": 0, "y_mm": -20}} or {"layer": 1}) and the rest is arranged around it. |
| `images` | boolean |  |  |
| `costs` | boolean |  | Default true: add costs (what each of your choices adds to the size), a few seconds after the CAD. |
| `why` | string |  | Short reason shown in the step list. |

### check_fit

Test whether the project's parts fit a case WITHOUT making it (no CAD, nothing written, answers in under a second): any preset or a custom outline, any size. Takes the same arguments as design_case (shape, outline, size_mm, params, placements, exclude, front); with none it tests the saved case. Returns {fits, size_mm (as laid out), needed_mm (what the parts need), asked_mm, misses: [{part, type, dimension: "outline" | "depth", short_mm, where, message}], suggestions: [{kind: "swap" | "smaller-cell" | "on-edge" | "bigger", part, from, to, message, change: [{tool, args}], fits, size_mm, tradeoff}], issues, costs: {base, costs: [{id, choice, with, without, adds_mm, adds_cm3, breaks_fit, message, change}], relax_all, sizes_that_work (a fixed size: the sizes this outline works at, flat and stacked; use one instead of guessing)}, ms}. Relax the costly choices unless the person asked for them. Each suggestion is tried with the same quick layout while about a second lasts (fits says whether it then fits the asked size; untried ones have no fits; try_suggestions: true tries them all, a few seconds). Use it to rethink the pieces before design_case: e.g. {"shape": "custom", "outline": "<egg path>", "size_mm": {"w": 58, "h": 75, "d": 20}}. preview: true adds the front-view geometry (outline, cavity, part footprints with collides) for drawing it.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `shape` | string |  | one of `rounded-box`, `pill`, `pebble`, `puck`, `keychain`, `custom` |
| `outline` | any |  | Shape "custom" only: the FRONT outline of the case in mm, drawn however you like. Either an SVG path string (M L H V C S Q T A Z, absolute or relative; y points DOWN like any SVG) e.g. an egg 56 x 73 mm: "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z", or {"points": [[x, y], ...], "smooth": true} with y UP (the top of the device is +y; smooth = a closed curve through the points). One closed shape that does not cross itself; sharp corners are rounded so they print. Only the proportions matter unless size_mm is given. |
| `size_mm` | object |  | Fixed overall size in mm: {"w": 58, "h": 75, "d": 22} (any of them; the rest auto). The outline is scaled to w x h and the case is exactly that size; parts that do not fit come back as misses with smaller swaps instead of the case growing. Leave it out for auto (the smallest that holds the parts). |
| `params` | object |  | Case parameters (all optional): wall_mm (≥ 1.2, default 1.6), corner_radius_mm (rounded-box / keychain, default 4), color ('#F2EDE4'), lanyard_hole (default true for keychain), belt_clip, closure ('snap' \| 'screws' = M2 into heat-set inserts), tolerance_mm (default 0.2 FDM), process ('fdm' \| 'resin' \| 'injection'), gap_mm (wiring room around parts, default 1.5). 3D finish, any shape (number or "auto"): edge_radius_front_mm / edge_radius_back_mm (round-over of each rim), dome_mm / dome_back_mm (how far the faces bulge; leave auto, about 1 mm: every mm of dome is a mm of thickness per face, over 3 mm is warned), depth_mm (overall thickness). Leave the finish on auto unless the person asked for it. |
| `front` | string |  |  |
| `placements` | object |  | Only for what the person asked for (Jumper places every part by itself; each pin can cost many mm: read costs). Per part id, where it goes: {"pet": {"face": "right", "y_mm": 4}, "bat": {"face": "inside"}, "xiao": {"on_edge": true}}. face: front \| back \| left \| right \| top \| bottom (as seen holding it, screen towards you) or inside (no opening); x_mm / y_mm from the centre of that face (+x right, +y up looking straight at it); rotation 0 / 90 / 180 / 270; on_edge: stand the board on its edge (narrower, thicker). Parts left out are auto-packed (screen front, USB bottom, buttons on the sides, buzzer / speaker grille at the back; a speaker that should talk through the front: {"spk": {"face": "front"}}). |
| `exclude` | string[] |  |  |
| `layout` | string |  | one of `auto`, `thinnest`, `smallest`, `balanced`. How the parts are distributed inside (round 8). Jumper works it out automatically: it lays the parts out flat first (side by side, one layer), then in two or three layers, inside the real outline, and proposes three layouts: "thinnest" (fewest layers), "smallest" (least volume), "balanced" (pocket-friendly: thickness over 18 mm and a footprint over 110 x 70 mm weigh up). "auto" (default) = balanced. See them first with propose_layout. Pin a part with placements ({"bat": {"x_mm": 0, "y_mm": -20}} or {"layer": 1}) and the rest is arranged around it. |
| `preview` | boolean |  | Add the front-view geometry (default false). |
| `costs` | boolean |  | Default true: add costs, what each of your choices (pins, faces, dome, edges, a fixed size, wall) adds to the size, a few seconds. |
| `try_suggestions` | boolean |  | Try every suggestion (a few seconds) instead of the ones that fit in about a second (default false). |

### propose_layout

Work out, automatically, the best ways to distribute the project's parts inside a case of ANY outline and size (no CAD, nothing written, about 1 to 2 s): Jumper lays the parts out flat first (every part side by side in one layer inside the real outline, rotated 0 / 90, a board on its edge where it helps), then in two or three layers (e.g. the cell behind the screen), keeping the screen behind its window, the speaker grille on its face, each USB port / button / switch reaching its wall, the cell flat, wiring room between parts and the rim round-over at each part's depth (heavy parts low in an upright outline). Returns {proposals: [{id: "thinnest" | "smallest" | "balanced", label, size_mm, volume_cm3, pocket, fill_ratio, layers: [{index, z_mm, parts}], placements: {part: {x_mm, y_mm, z_mm, rot, on_edge, layer, face}}, why: [reasons in plain words], misses, warnings, source}], best, chosen, parts_volume_cm3, ms}. Same arguments as check_fit (with none it uses the saved case). Also costs: what each of your choices (a pinned part, a face, the dome, edges, a fixed size, wall) adds in thickness / size / volume, measured by proposing again without it, each with the update_case call that relaxes it, and relax_all. Call it before design_case; relax the costly choices unless the person asked for them; a pocket or hand-held device should be 20 mm thick or less. Then make the one you want with design_case / update_case {layout: "<id>"}; pin a part only where the person asked for it (the rest is arranged around it). views: true adds front and side views (outline + part rectangles per layer) for drawing them. Deterministic: the same project gives the same proposals.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `shape` | string |  | one of `rounded-box`, `pill`, `pebble`, `puck`, `keychain`, `custom` |
| `outline` | any |  | Shape "custom" only: the FRONT outline of the case in mm, drawn however you like. Either an SVG path string (M L H V C S Q T A Z, absolute or relative; y points DOWN like any SVG) e.g. an egg 56 x 73 mm: "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z", or {"points": [[x, y], ...], "smooth": true} with y UP (the top of the device is +y; smooth = a closed curve through the points). One closed shape that does not cross itself; sharp corners are rounded so they print. Only the proportions matter unless size_mm is given. |
| `size_mm` | object |  | Fixed overall size in mm: {"w": 58, "h": 75, "d": 22} (any of them; the rest auto). The outline is scaled to w x h and the case is exactly that size; parts that do not fit come back as misses with smaller swaps instead of the case growing. Leave it out for auto (the smallest that holds the parts). |
| `params` | object |  | Case parameters (all optional): wall_mm (≥ 1.2, default 1.6), corner_radius_mm (rounded-box / keychain, default 4), color ('#F2EDE4'), lanyard_hole (default true for keychain), belt_clip, closure ('snap' \| 'screws' = M2 into heat-set inserts), tolerance_mm (default 0.2 FDM), process ('fdm' \| 'resin' \| 'injection'), gap_mm (wiring room around parts, default 1.5). 3D finish, any shape (number or "auto"): edge_radius_front_mm / edge_radius_back_mm (round-over of each rim), dome_mm / dome_back_mm (how far the faces bulge; leave auto, about 1 mm: every mm of dome is a mm of thickness per face, over 3 mm is warned), depth_mm (overall thickness). Leave the finish on auto unless the person asked for it. |
| `front` | string |  |  |
| `placements` | object |  | Only for what the person asked for (Jumper places every part by itself; each pin can cost many mm: read costs). Per part id, where it goes: {"pet": {"face": "right", "y_mm": 4}, "bat": {"face": "inside"}, "xiao": {"on_edge": true}}. face: front \| back \| left \| right \| top \| bottom (as seen holding it, screen towards you) or inside (no opening); x_mm / y_mm from the centre of that face (+x right, +y up looking straight at it); rotation 0 / 90 / 180 / 270; on_edge: stand the board on its edge (narrower, thicker). Parts left out are auto-packed (screen front, USB bottom, buttons on the sides, buzzer / speaker grille at the back; a speaker that should talk through the front: {"spk": {"face": "front"}}). |
| `exclude` | string[] |  |  |
| `layout` | string |  | one of `auto`, `thinnest`, `smallest`, `balanced`. How the parts are distributed inside (round 8). Jumper works it out automatically: it lays the parts out flat first (side by side, one layer), then in two or three layers, inside the real outline, and proposes three layouts: "thinnest" (fewest layers), "smallest" (least volume), "balanced" (pocket-friendly: thickness over 18 mm and a footprint over 110 x 70 mm weigh up). "auto" (default) = balanced. See them first with propose_layout. Pin a part with placements ({"bat": {"x_mm": 0, "y_mm": -20}} or {"layer": 1}) and the rest is arranged around it. |
| `views` | boolean |  | Add the front and side views per proposal (default false). |
| `costs` | boolean |  | Default true: add costs, what each of your choices (pins, faces, dome, edges, a fixed size, wall) adds to the size, a few seconds. |

### get_case

The current case's CaseReport (sizes, pocket verdict, checks, files). If a part, the wiring of the case config or an undo changed things since the files were written, it regenerates them first (stale: true in the answer). Does not change jumper.json. Fails when there is no case yet.

No arguments.

### export_manufacturing

Write the factory pack to <project>/manufacturing/<name>-v<version>/ and zip it: README.md for the supplier (what it is, how to build, flash and test), README.zh-CN.md (short summary), NOTES.md (honest limits: no PCB layout yet, hand-wired / perfboard; what was only simulated; what to verify on a real unit), BOM.csv (line, refs, qty, name, mpn, manufacturer, lcsc, jlc, package, generic, unit_usd, ext_usd, buy_url, source, notes) + BOM.md, electronics/ (WIRING.md, netlist.csv, jumper.net KiCad netlist, WIRE-CUTS.csv), firmware/ (firmware.hex, firmware.uf2 for RP2040, firmware.bin for ESP32 boards built for the real board, FLASHING.md, source/), enclosure/ (the case files), assembly/ASSEMBLY.md (numbered steps with the renders), test/ (TEST-PLAN.md from the scenarios, TEST-ON-HARDWARE.md), manifest.json (sha256 per file). Example: {} or {"zh_cn": false}. Returns {dir, zip, files, missing: [{item, why, fix}], notes, next}. Build the firmware and design_case first for a complete pack (missing[] says what is absent).

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `dir` | string |  | Folder inside the project (default "manufacturing"). |
| `zip` | boolean |  | Default true: also write <name>-v<version>.zip next to the folder. |
| `zh_cn` | boolean |  | Default true: add README.zh-CN.md. |
| `why` | string |  | Short reason shown in the step list. |

### read_speech

What the device said out loud in the simulation (DFPlayer Mini clips, whose words are its "clips" prop): {"since": 0} for everything. Returns {t_ms, next, said: [{part, t_ms, dur_ms, track, clip, text, heard, volume, missing_words?}], saying_now}. heard is false when no speaker is wired to SPK_1 / SPK_2 (or DAC), so a person would hear nothing and no speech bubble shows. Pass next as since to read only new ones. Length is estimated (2.6 words per second + 0.3 s). Test it in a scenario with {"said": "dizzy", "within_ms": 500}. Run the simulation first (run / run_tests); with nothing run yet it is empty.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `since` | number |  | Index into the list, from a previous next (default 0). |
| `part` | string |  | Only this talking part (e.g. df1). |

### read_network

Everything the simulated device did on the network (any board with Wi-Fi or Ethernet in the emulator, e.g. ESP32): Wi-Fi joins and drops, DHCP, DNS lookups, HTTP(S) requests (method, host, path, status, bytes, ms, who answered: mock / cassette / internet / fault), WebSocket and MQTT sessions with frame counts and samples, and blocked attempts with why and fix. Secrets show as [secret:NAME], never their value. Also returns mode, allow list, mocks, active faults, the secrets the project names (set or missing on this machine, never values) and the boards on the sandbox LAN. {"since": seq} for new entries only, {"kind": "http" | "ws" | "mqtt" | "dns" | "wifi" | "dhcp" | "blocked" | "connect" | "fault" | "udp"}, {"host": "api.example.com"}. (read_network_log is the older ESP-01 / pet-AI log.)

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `since` | number |  |  |
| `limit` | number |  |  |
| `kind` | string |  | one of `dns`, `http`, `ws`, `mqtt`, `connect`, `udp`, `blocked`, `fault`, `wifi`, `dhcp` |
| `host` | string |  |  |

### add_mock_api

Add or replace a mock in network/mocks.json, live (the running device sees it at once). Any API is just a mock: a weather API, an AI stream, a webhook, a broker. HTTP: {"host", "method"?, "path" (exact, or a prefix ending in *), "response": {"status", "headers", "body" (JSON or text) | "body_b64" | "chunks": [{"data" | "b64" | "bytes", "delay_ms"}], "delay_ms"}}. WebSocket: {"kind": "ws", "host", "path", "on_open": [frames], "on_message": [{"match" (substring or "*"), "send": [{"text" | "b64" | "bytes", "delay_ms", "repeat"}], "close"}]}. MQTT broker: {"kind": "mqtt", "host", "on_publish": [{"topic" (+ and # wildcards), "reply": [{"topic", "payload"}]}], "retained": [{"topic", "payload"}]}. Mocks never contain secrets. Check it with try_request.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `mock` | object | yes | One mock (see above). |

### inject_network_fault

Rehearse a bad network while the device runs: {"kind": "wifi_drop"} (the access point disappears: open connections are lost, the firmware sees WL_CONNECTION_LOST and must reconnect once you clear it), {"kind": "weak_signal", "rssi": -85} (WiFi.RSSI() reads it; traffic is not slowed), {"kind": "latency", "ms": 800}, {"kind": "http_error", "status": 503, "host"?, "path"?, "count"?}, {"kind": "timeout", "host"?} (accepted, never answered), {"kind": "dns_fail", "host"?}, {"kind": "clear"}. In a scenario use {"network_fault": {...}}.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `fault` | object | yes | e.g. {"kind": "wifi_drop"} |

### set_network

Change jumper.json "network" (undoable) and apply it live. {"mode": "offline" | "mock" | "internet"} (mock is the default and what run_tests uses; internet reaches only hosts in allow), {"allow": [{"host": "api.example.com", "ports"?: [443], "tls"?: "inspect" | "passthrough", "secrets"?: ["API_KEY"], "headers"?: {"Authorization": "Bearer {{secret:API_KEY}}"}}]}, {"secrets": ["API_KEY"]} (names only: the value goes in the project's .env or the environment, never in jumper.json), {"wifi": {"ssid": "Home", "password"?: "...", "rssi"?: -60}} (the sandbox access point; leave out to accept any SSID), {"cassette": "name", "record": true}. Only the fields you pass change; null removes one. A literal key in a header is refused with the fix.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `mode` | string |  | one of `offline`, `mock`, `internet` |
| `allow` | array \| null |  |  |
| `secrets` | array \| null |  |  |
| `wifi` | object \| null |  |  |
| `cassette` | string \| null |  |  |
| `record` | boolean \| null |  |  |
| `mocks` | string \| null |  | Mocks file relative to jumper.json (default network/mocks.json). |
| `why` | string |  |  |

### try_request

Make one HTTP(S) request from inside the sandbox, exactly as the device would (sandbox DNS, TLS through the sandbox CA, the mode, allow list, mocks, secrets and faults apply): {"url": "https://api.example.com/v1/now", "method"?: "GET", "headers"?: {}, "body"?: "..."}. Returns {ok, status, headers, body (16 KB max, secrets masked), bytes, ms} or {ok: false, error, why, fix}. Use it to check a mock or an allow entry before writing firmware. It shows in read_network with User-Agent jumper-try-request.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes |  |
| `method` | string |  |  |
| `headers` | object |  |  |
| `body` | string |  |  |
