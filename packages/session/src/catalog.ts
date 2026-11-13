/**
 * The agent surface: every session op as a tool definition (name, description, JSON Schema).
 * The MCP server, the CLI help and docs/mcp-tools.md are all generated from this list, so the
 * three faces cannot drift apart.
 */
import { renderInstructionsBlock } from "@jumper/agent-skill";
import { NETWORK_TOOLS } from "./network.ts";
import { TEMPLATES } from "./templates.ts";
import { TOOL_MODULES } from "./tools/index.ts";

export interface ToolDef {
  name: string;
  /** Short title for listings. */
  title: string;
  /** When to use it, argument formats with examples, what comes back, common mistakes. */
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Changes the project (recorded as a step, undoable). */
  edits?: boolean;
  /** Read-only (no project or simulation change). */
  readOnly?: boolean;
}

const why = { type: "string", description: 'Short reason shown to the human in the step list, e.g. "add a current-limiting resistor for the LED". Consecutive edits with the same why form one undoable step.' };
const pinRef = (example: string) => ({ type: "string", description: `Pin as "part.pin", e.g. "${example}". Forgiving: "uno.13" → uno.D13, "oled1.gnd" → oled1.GND, "uno.GND" → a free GND pin.` });

export const TOOLS: ToolDef[] = [
  {
    name: "new_project",
    title: "Start a project",
    description:
      'Start a project from a template. For a new idea pass folder: true (or a folder name): Jumper makes a NEW project folder for it, registers it in the Projects gallery and switches to it, so the person\'s other projects (and the playground) are never overwritten: {"folder": true, "name": "Plant waterer", "template": "uno"}. Without folder it starts the project in the current folder and refuses to replace existing parts unless overwrite is true. Templates: "blank" (empty), "uno" (Arduino Uno + empty sketch), "nano", "blink" (Uno + resistor + LED + Blink sketch + passing tests; good to learn the loop), plus any board templates listed in the enum. Returns {dir, id, viewer_url (when Jumper\'s server runs), opened, …project summary}. Skip it if get_project shows the person already started this device.',
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", enum: Object.keys(TEMPLATES), description: "Default blank." },
        name: { type: "string", description: "Project name (default: folder name)." },
        folder: { type: ["boolean", "string"], description: 'true: a new folder named after name; a string: that folder name (slugged, e.g. "plant-waterer"). Created under the server\'s projects folder; a taken name gets -2, -3…' },
        overwrite: { type: "boolean", description: "Replace an existing jumper.json in the current folder (throws the old project away)." },
      },
    },
    edits: true,
  },
  {
    name: "get_project",
    title: "Project summary",
    description:
      'Compact summary of the project: parts ("led1 (led) {\\"color\\":\\"red\\"} @440,-210"), wires ("w1: uno.D13 -> r1.1"), nets with 3+ pins, pins in use per part, firmware (board, sketch, libraries, built: fresh|stale|missing|none), files, scenario ids and pending steps. Call it whenever you are unsure of ids; it is cheap.',
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    name: "search_parts",
    title: "Find parts",
    description:
      'Search the parts catalog by words (id, name, tags, description): "oled", "button", "distance sensor", "motor driver". Every word must match. Optional category: board, output, input, passive, sensor, power, display, motor, communication, misc. Returns up to 25 {type, name, category, fidelity, about}. Empty query lists everything. Use the returned `type` with get_part and place_part.',
    inputSchema: { type: "object", properties: { query: { type: "string", description: 'e.g. "oled" or "push button"' }, category: { type: "string" } } },
    readOnly: true,
  },
  {
    name: "get_part",
    title: "Part details",
    description:
      'Everything needed to wire and program one part type: pins ("SDA: digital i2c-sda - I2C data. Uno: A4"), props with ranges/options, I2C addresses, state fields you can test (expect_part) or read, fidelity gaps, a wiring hint, typical connections for an Uno, the Arduino libraries it needs, and a minimal Arduino example. Read this before connecting a part you have not used; pin ids are case-sensitive in jumper.json (connect is forgiving).',
    inputSchema: { type: "object", properties: { type: { type: "string", description: 'Part type id from search_parts, e.g. "ssd1306-oled-i2c".' } }, required: ["type"] },
    readOnly: true,
  },
  {
    name: "place_part",
    title: "Place a part",
    description:
      'Add a part to the canvas. Omit x/y and Jumper picks a tidy, non-overlapping spot (boards at the origin, parts in a row above the board). Omit id to get a short one: boards "uno"/"nano", then "led1", "btn1", "oled1", "r1", "buzzer1". props sets part properties, e.g. {"resistance": 220} or {"color": "green"} (strings like "10k" work for numbers). Returns {id, pins, wiring hint, typical_connections}: typical_connections names free board pins (a second button gets D3 when the first was told D2), so you can connect them as given. Placing a board when a sketch exists wires up firmware automatically. Common mistake: forgetting the resistor for an LED (check_design catches it).',
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: 'Part type, e.g. "arduino-uno", "led", "resistor", "pushbutton", "ssd1306-oled-i2c", "buzzer".' },
        id: { type: "string", description: "Optional instance id: letter first, then letters/digits/_/- (no dots)." },
        x: { type: "number", description: "Canvas px (20 px = 0.1 in). Omit for auto-layout." },
        y: { type: "number" },
        rotation: { type: "number", enum: [0, 90, 180, 270] },
        props: { type: "object", description: 'e.g. {"resistance": 220}', additionalProperties: true },
        why,
      },
      required: ["type"],
    },
    edits: true,
  },
  {
    name: "move_part",
    title: "Move or rotate a part",
    description: 'Move a part to x/y (canvas px) and/or rotate it (0/90/180/270). Wires follow. Only changes the drawing, never the circuit. Example: {"id": "led1", "x": 480, "y": -200}.',
    inputSchema: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, rotation: { type: "number", enum: [0, 90, 180, 270] }, why }, required: ["id"] },
    edits: true,
  },
  {
    name: "remove",
    title: "Remove a part, wire or test scenario",
    description: 'Remove a part (and every wire touching it), a single wire or a test scenario, by id: {"id": "led2"}, {"id": "w5"} or {"id": "boots"} (e.g. the starter template\'s placeholder test). Removing the firmware board also removes the firmware link (the files stay). Undoable.',
    inputSchema: { type: "object", properties: { id: { type: "string" }, why }, required: ["id"] },
    edits: true,
  },
  {
    name: "connect",
    title: "Wire two pins",
    description:
      'Draw a wire between two pins: {"from": "uno.D13", "to": "r1.1"}. Pin ids come from place_part/get_part ("A"/"C" on an LED, "1"/"2" on a resistor, "1a"/"2a" on a pushbutton, "D0".."D13", "A0".."A5", "5V", "3V3", "GND" on an Uno). Several wires on one pin are fine (that is how you share GND/5V). Returns the wire id, how forgiving names were resolved, design warnings about this connection (e.g. LED without resistor, I2C on the wrong pins) and reminders for the sketch you have not written yet (e.g. INPUT_PULLUP for a button). Refuses a direct 5V-to-GND short. Already-connected pins return the existing wire.',
    inputSchema: { type: "object", properties: { from: pinRef("uno.D13"), to: pinRef("r1.1"), color: { type: "string", description: 'CSS colour, e.g. "#FF4D2E". Default: red for supply, dark for ground, varied for signals.' }, why }, required: ["from", "to"] },
    edits: true,
  },
  {
    name: "disconnect",
    title: "Remove wires",
    description: 'Remove a wire by id ({"wire": "w3"}) or the wires between two pins ({"from": "uno.D13", "to": "r1.1"}), or every wire on one pin ({"from": "uno.D13"}).',
    inputSchema: { type: "object", properties: { wire: { type: "string" }, from: pinRef("uno.D13"), to: pinRef("r1.1"), why } },
    edits: true,
  },
  {
    name: "set_part_property",
    title: "Change a part property",
    description: 'Change a saved part property: {"id": "r1", "prop": "resistance", "value": 330}, {"id": "led1", "prop": "color", "value": "green"}, {"id": "oled1", "prop": "address", "value": "0x3D"}. Validated against the part (ranges, options). A running simulation picks it up live (and run {reset: true} starts from it); the result\'s "simulation" says what happened (parts the robot world uses restart the simulation at 0 ms). For temporary sensor readings during a run use set_sensor_value instead.',
    inputSchema: { type: "object", properties: { id: { type: "string" }, prop: { type: "string" }, value: { type: ["string", "number", "boolean", "object"], description: "The new value. Text props such as a DFPlayer's clips take \"N: words\" lines or an object {\"1\": \"hi!\"}." }, why }, required: ["id", "prop", "value"] },
    edits: true,
  },
  {
    name: "set_libraries",
    title: "Declare Arduino libraries",
    description:
      'Set the Arduino libraries the sketch needs (replaces the list): {"libraries": ["Adafruit SSD1306", "Adafruit GFX Library"]}. Names as in the Arduino Library Manager; "Name@1.2.3" pins a version, a bare name gets Jumper\'s pinned version (dependencies such as Adafruit BusIO are added for you). Preinstalled: Adafruit SSD1306, Adafruit GFX Library, Adafruit BusIO, Servo, U8g2, Adafruit BME280/MPU6050/Unified Sensor, RTClib, LiquidCrystal I2C, LiquidCrystal_PCF8574, MPU6050. Wire, SPI, EEPROM and SoftwareSerial are built in (do not list them). Others install on first build (needs network).',
    inputSchema: { type: "object", properties: { libraries: { type: "array", items: { type: "string" } }, why }, required: ["libraries"] },
    edits: true,
  },
  {
    name: "set_firmware",
    title: "Choose the firmware language",
    description:
      'Pick the language the board\'s firmware is written in: {"language": "micropython"} (also "arduino", "esp-idf", "platformio"). Sets firmware.language, the main file (main.ino, main.py, main/main.c, platformio.ini), the build tool and the artifact, and says which languages this board runs (verified ones only; plan_device lists them too). Writes a starter main file when there is none (keep_files: true never touches files). Options: "firmware": "RPI_PICO@1.29.0" (MicroPython build), "target": "esp32c3" (ESP-IDF), "env": "uno" (PlatformIO).',
    inputSchema: { type: "object", properties: { language: { type: "string", enum: ["arduino", "micropython", "esp-idf", "platformio"] }, board: { type: "string", description: "Board part id (default: the board in the project)." }, firmware: { type: "string" }, target: { type: "string" }, env: { type: "string" }, keep_files: { type: "boolean" }, why }, required: ["language"] },
    edits: true,
  },
  {
    name: "set_world",
    title: "Set the robot's world",
    description:
      'Robots only: the physical world the simulation moves the robot in, saved in jumper.json. Rover: {"world": {"arena": {"width": 300, "height": 200}, "obstacles": [{"id": "crate", "shape": "box", "x": 160, "y": 80, "w": 36, "h": 36, "angle": 15}, {"id": "pillar", "shape": "circle", "x": 240, "y": 150, "r": 12}], "robot": {"chassis": "chassis1", "leftMotor": "motor1", "rightMotor": "motor2", "sonar": "sonar1", "start": {"x": 40, "y": 40, "heading": 0}}}} (cm, degrees; robot part ids are filled in when there is exactly one chassis / two motors / one sonar). The rover needs a robot-chassis-2wd part and two dc-motor parts driven by an l298n; the sonar (hc-sr04) then reads real distances to walls and obstacles. Give the rover a safety margin in tests: {"expect_part": "world.min_clearance_cm", "op": ">=", "value": 3} (any gap above 0 counts as no collision). Servo arm: {"world": {"arm": {"base": {"x": 0, "y": 5}, "links": [10, 8], "joints": [{"servo": "servo1", "zero": 90, "direction": 1, "offset": 90}, …], "targets": [{"id": "cup", "x": 12, "y": 6, "r": 2}]}}}. After run, the result has world {robot {x, y, heading}, collisions, min_clearance_cm, travelled_cm} (arm: {gripper, reached}; scenarios use world.gripper_x, world.gripper_y, world.reached); scenarios check them with {"expect_part": "world.collisions", "op": "==", "value": 0} (the chassis part state has the same pose too); screenshot draws the arena / arm next to the circuit. null removes the world.',
    inputSchema: { type: "object", properties: { world: { type: ["object", "null"], description: "{ arena, obstacles, walls, robot } and/or { arm }" }, why }, required: ["world"] },
    edits: true,
  },
  {
    name: "write_file",
    title: "Write firmware source",
    description:
      'Create or replace a firmware file under firmware/: {"path": "firmware/main.ino", "content": "void setup() {...}"}. The first .ino you write becomes the main sketch and is linked to the board automatically. Extra .h/.cpp files go in the same folder. Write the whole file every time (no patches). Use Serial.begin(115200) and print what happens: serial output is how you (and scenarios) verify behaviour. Other languages (set_firmware picks one): MicroPython writes firmware/main.py plus modules next to it (the first main.py on a board that runs MicroPython switches the project to MicroPython), ESP-IDF writes firmware/CMakeLists.txt + firmware/main/main.c, PlatformIO writes firmware/platformio.ini + firmware/src/main.cpp. Returns notes when something about the layout matters.',
    inputSchema: { type: "object", properties: { path: { type: "string", description: '"firmware/main.ino", "firmware/pet.h"…' }, content: { type: "string" }, why }, required: ["path", "content"] },
    edits: true,
  },
  {
    name: "read_file",
    title: "Read a file",
    description: 'Read a firmware file ("firmware/main.ino"), "jumper.json", or a text file the case and the build pack wrote ("case/PRINT.md", "manufacturing/<pack>/BOM.md", ".../assembly/ASSEMBLY.md", ".../firmware/FLASHING.md": .md, .csv, .txt, .json under case/ or manufacturing/). Use it to look at the line a compiler error points at, or to summarise what to buy, print and assemble.',
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    readOnly: true,
  },
  {
    name: "list_files",
    title: "List firmware files",
    description: "List files under firmware/ and which one is the main sketch.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    name: "build",
    title: "Compile the firmware",
    description:
      'Build the firmware in its language (firmware.language): Arduino with arduino-cli, ESP-IDF with idf.py, PlatformIO with pio run (pinned toolchains in Docker; identical sources are served from cache in milliseconds); MicroPython has no compile step: every .py is syntax-checked with mpy-cross (errors at file:line) and the pinned MicroPython firmware is flashed with a filesystem holding the files. Returns {ok, size "flash 1992/32256 B (6%), ram …", errors: ["firmware/main.ino:12:5: \'foo\' was not declared in this scope (fix: …)"], warnings}. Each error has file:line and a concrete fix hint. If Docker is not running the error says how to start it. run and run_tests build automatically when sources changed, so you rarely need this except to check errors.',
    inputSchema: { type: "object", properties: { force: { type: "boolean", description: "Ignore the cache." } } },
  },
  {
    name: "run",
    title: "Simulate",
    description:
      'Run the simulation for ms of virtual time (deterministic, faster than real time; continues from where the last run stopped unless reset is true or the circuit/firmware changed). Builds first if needed. Returns {t_ms, serial (new output), pins {"D13": "out H 5.00V", "D9": "out pulse 50Hz 1500us" for servo pulses, "D5": "out PWM 490Hz duty 70%"}, parts {"led1": {"brightness": 0.62, "on": true}}, diagnostics (overcurrent, floating inputs…), world (robots: pose, collisions, first_collision {t_ms, x, y, heading, with: [what it hit]}, closest gap; arms: gripper position, targets reached), notes (e.g. a near miss under 2 cm)}. Example: {"ms": 3000}. Then press buttons with interact, change sensors with set_sensor_value, and run again. serial_write types into the console before running (a MicroPython REPL line such as "print(led.value())\\n", or a command an Arduino sketch reads). MicroPython tracebacks come back as errors ["firmware/main.py:9: ValueError: boom"].',
    inputSchema: { type: "object", properties: { ms: { type: "number", description: "Virtual ms to simulate, e.g. 2000 (max 600000)." }, reset: { type: "boolean", description: "Restart from 0 ms first." }, serial_write: { type: "string", description: 'Text sent to the board\'s console before running, e.g. "print(2 + 2)\\n" at a MicroPython REPL.' }, speed: { type: "number", description: "Ignored headless (always as fast as possible); kept for compatibility." }, seed: { type: ["number", "null"], description: "Round 14: seed the board's hardware random numbers (esp_random, random()) so 'random' behaviour repeats; a new seed restarts at 0 ms; null = random again. Scenarios are seeded per test automatically." }, reset_board: { type: "boolean", description: "Round 14: reboot the board before running (reset button / power cycle) without restarting the simulation: what the firmware wrote to flash (LittleFS, SPIFFS, NVS) stays." }, clock: { type: ["string", "null"], description: 'Round 14: the date-time NTP gives the device from now on, e.g. "2026-12-24T09:00:00Z" (advances with virtual time); null = this computer\'s clock. Needs a device network.' } }, required: ["ms"] },
  },
  {
    name: "read_serial",
    title: "Read serial output",
    description: 'Everything the firmware printed since a byte offset: {"since": 0} for all. Returns {text, next}; pass next as since to read only new output.',
    inputSchema: { type: "object", properties: { since: { type: "number" } } },
    readOnly: true,
  },
  {
    name: "read_pin",
    title: "Measure a pin",
    description: 'Voltage, logic level (high/low/undefined) and, for board pins, the firmware pin mode, at the current simulated time: {"pin": "uno.D13"} → {voltage: 5, level: "high", mode: "output", connected_to: ["r1.1"]}.',
    inputSchema: { type: "object", properties: { pin: pinRef("uno.D13") }, required: ["pin"] },
    readOnly: true,
  },
  {
    name: "read_display",
    title: "See a display",
    description: 'The screen of a display part (ssd1306-oled-i2c, lcd1602-i2c, or a colour TFT such as ili9341-tft, where any non-black pixel counts as lit) as ASCII art ("#" lit, "." dark), plus lit_pixels. scale 2 (default) shows a 128x64 OLED as 64x32 characters; scale 1 is exact, 4 is a thumbnail. Run first so the firmware has drawn something. region [x, y, w, h] crops to exact pixels and counts region_lit (e.g. the face area). save_as "sad-face" saves that frame (or region) as a golden snapshot (snapshots/sad-face.json) that scenarios check with {"expect_display": "oled1", "matches": "sad-face", "within_ms": 3000}: the way to regression-test what the screen shows.',
    inputSchema: { type: "object", properties: { part: { type: "string" }, scale: { type: "number" }, region: { type: "array", items: { type: "number" }, description: "[x, y, w, h] in screen pixels; exact (scale 1)." }, save_as: { type: "string", description: 'Save this frame as a golden snapshot for expect_display matches, e.g. "sad-face".' } }, required: ["part"] },
  },
  {
    name: "interact",
    title: "Press / set a control",
    description: 'Act on a part in the running simulation: {"part": "btn1", "action": "press"}, then run, then {"action": "release"}; "click" = press, hold 200 ms of simulated time (hold_ms to change), release, and returns the serial printed meanwhile; "toggle" for switches; "set" with value for knobs (e.g. {"part": "pot1", "action": "set", "value": 0.8}). Not saved to the project. Run afterwards to let the firmware react.',
    inputSchema: { type: "object", properties: { part: { type: "string" }, action: { type: "string", enum: ["press", "release", "click", "toggle", "set"] }, value: { type: ["number", "string", "boolean"] }, key: { type: "string", description: "Which control on multi-control parts (keypad key)." }, hold_ms: { type: "number", description: "click only: how long the press lasts (default 200 ms)." } }, required: ["part", "action"] },
  },
  {
    name: "set_sensor_value",
    title: "Set a sensor reading",
    description: 'Set what a sensor reads in the running simulation: {"part": "ldr1", "field": "lux", "value": 50}, {"part": "pot1", "field": "position", "value": 0.25}, {"part": "sonar1", "field": "distance", "value": 12}. Fields are the part\'s props (get_part lists them with ranges). Not saved to the project (use set_part_property for that).',
    inputSchema: { type: "object", properties: { part: { type: "string" }, field: { type: "string" }, value: { type: ["number", "string", "boolean"] } }, required: ["part", "field", "value"] },
  },
  {
    name: "inject_fault",
    title: "Inject a fault",
    description:
      'Break something on purpose to harden the firmware: "disconnect" (module unplugged: no power, gone from the I2C bus), "noisy" (a sensor value jitters ±5% every 10 ms, deterministic; optional field and amplitude), "i2c_nack" (the device NACKs its address: Wire.endTransmission() returns 2, display.begin() fails), "i2c_nack_data", "i2c_garbage" (reads return 0xFF), "wifi_drop" (on a Wi-Fi module such as an ESP-01: the sandbox access point disappears, the module prints WIFI DISCONNECT and closes its links; survives reset; "clear" on the same part brings it back and the module reconnects), "clear" (remove faults on that part). Not simulated yet (returns an error saying so): brownout, clock_drift, flash_full. Example: {"part": "oled1", "kind": "i2c_nack"}, then run and check that the firmware reports it.',
    inputSchema: { type: "object", properties: { part: { type: "string" }, kind: { type: "string", enum: ["disconnect", "noisy", "i2c_nack", "i2c_nack_data", "i2c_garbage", "clear"] }, field: { type: "string" }, amplitude: { type: "number" } }, required: ["part", "kind"] },
  },
  {
    name: "write_scenario",
    title: "Write a test scenario",
    description:
      'Add or replace a deterministic test in jumper.json. Steps run in order, one action per step. Inputs: {"run_ms": 500}, {"press": "btn1", "hold_ms": 50}, {"release": "btn1"}, {"set": "pot1.position", "value": 0.8}, {"serial_write": "feed\\n"}, {"inject_fault": "oled1", "kind": "disconnect"} (noisy also takes "field" and "amplitude"). Checks: serial text {"expect_serial": "LED on", "within_ms": 1100}; serial regular expression, with the pattern INSIDE expect_serial: {"expect_serial": {"regex": "hunger=\\\\d+"}, "within_ms": 1100}; "absent": true forbids the text; a printed number {"expect_serial_value": "energy", "op": ">=", "value": 60, "within_ms": 1500} (reads the latest "energy=64" / "energy: 64", so tests do not break on tick timing); a pin {"expect_pin": "uno.D13", "level": "high", "within_ms": 50} (or "voltage": {"min": 2, "max": 3}); a part state {"expect_part": "buzzer1.on", "op": "==", "value": true, "within_ms": 500} (ops == != > >= < <= contains matches; fields from get_part "state"); a screen {"expect_display": "oled1", "region": [40, 16, 48, 32], "lit": {"min": 20}} or against a golden frame saved with read_display {save_as} {"expect_display": "oled1", "matches": "sad-face", "within_ms": 3000} (tolerance 0.02 = 2% of pixels may differ; animations: within_ms waits for a matching frame); robots {"expect_part": "world.collisions", "op": "==", "value": 0} (world fields: collisions, min_clearance_cm, travelled_cm, x, y, heading, speed, sonar_cm, touching; arm: gripper_x, gripper_y, reached). Assert a real safety margin, e.g. world.min_clearance_cm >= 3, not > 0 (any gap counts as no collision). {"expect_no_errors": true}. Words a talking device (DFPlayer Mini + speaker) said: {"said": "dizzy", "within_ms": 500} (case-insensitive part of the clip\'s words; {"said": {"regex": "^hi"}}; "part": "df1" picks one DFPlayer; "absent": true forbids it; only clips heard through a wired speaker count, and each said step matches clips after the previous match). Timing: within_ms = keep simulating up to that long until it holds, and it passes the moment it holds, so after an input wait for the side the value moves TOWARD (e.g. "<" when it should drop): a condition that was already true before the input passes at 0 ms and tests nothing (run_tests warns). Without within_ms the check is instant. expect_serial only matches text printed after the previous expect_serial match. Round 14, devices that act at random, cameras, speech APIs, offline queues: each test seeds the board\'s hardware random numbers (esp_random, random()) from its id, so "random" timing repeats ("seed" picks another sequence); "said" also matches the text the firmware sends to a speech API (/v1/audio/speech "input" and similar); pictures {"expect_capture": "cam", "within_ms": 60000} or {"expect_capture": true, "absent": true, "within_ms": 12000}; order and timing {"preceded_by": {"said": "picture in 10", "min_ms": 9000, "max_ms": 11000}} on expect_capture or request (or {"serial": ...}, {"capture": true}, {"request": {"host", "path"}}); what a request carried {"request": {"host", "method", "path", "status", "content_type": "multipart/form-data", "body_json": {"photo.content_type": "image/jpeg", "caption": "?"}, "body_contains": "...", "min_bytes": 1000}}; {"network_fault": {"kind": "wifi_drop"}} then {"network_fault": {"kind": "clear"}} for offline / back online; {"reset_board": true} reboots the board keeping its flash (LittleFS, NVS), so a saved queue survives; {"set_clock": "2026-12-24T09:00:00Z"} (or the scenario\'s "clock") is what NTP answers and what RTC parts (DS3231) read. Round 15, devices that deep-sleep (esp_deep_sleep_start): while the board sleeps no firmware runs, so {"run_ms": 3600000} passes an hour in about a second; it wakes on its timer or a wake pin (press a button, {"set": "reed1.magnet", "value": "away"} for a lid) and boots with RTC memory, the clock and the wake cause kept; {"expect_part": "<board>.asleep", "op": "==", "value": true}. Idle firmware runs about 10x faster than real time, so minutes of virtual time are fine (raise timeout_ms). Write scenarios from the user\'s goal, one per behaviour.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: 'e.g. "feeds-when-button-pressed"' },
        name: { type: "string" },
        description: { type: "string" },
        steps: { type: "array", items: { type: "object" } },
        timeout_ms: { type: "number", description: "Virtual-time limit (default 60000)." },
        seed: { type: "number", description: "Round 14: seed of the board's hardware random numbers (esp_random, random()) for this test. Default: fixed per scenario id, so firmware that acts 'at random' does the same thing every run; another seed tries another sequence." },
        clock: { type: "string", description: 'Round 14: the date-time NTP gives the device when the test starts, e.g. "2026-12-24T09:00:00Z" (advances with virtual time). Default: this computer\'s clock.' },
        why,
      },
      required: ["id", "steps"],
    },
    edits: true,
  },
  {
    name: "run_tests",
    title: "Run test scenarios",
    description: 'Run all scenarios (or one by id/name), each from a fresh simulation at 0 ms. Builds first if needed. Returns {passed, failed, results}; a failure says which step, what was expected, what was seen instead, every step\'s timing and the serial tail. Each result also has visual: one line per check with its virtual time, what it saw and what the device looked like then (screen pixels lit, robot pose and sonar, arm position); the web app\'s Tests panel shows the same checks as a filmstrip. Pass images: true to also get a PNG of the screen at each failing check (or the last check when all pass). Fix the firmware or wiring and run again until all pass.',
    inputSchema: { type: "object", properties: { name: { type: "string" }, images: { type: "boolean", description: "Attach screen PNGs of key checks (default false)." } } },
  },
  {
    name: "check_design",
    title: "Design rule check",
    description:
      "Electrical sanity check: LED without resistor, shorts, supply rails tied together, 5 V on a 3.3 V pin, modules with VCC/GND unconnected, I2C on the wrong pins, shared I2C addresses, missing I2C pull-ups, GPIO wired straight to a rail, two outputs on one net, motors on a GPIO, buttons without pull-up (reads the sketch; while the sketch is still the starter template this is an info reminder), Serial pins in use, power budget of the board's 5V rail (servos, motor drivers fed from it; loads on a battery do not count), pinless parts not used by the world, plus live simulator diagnostics (overcurrent, floating inputs) after a run, and, once a case is built, how the parts go into it (assembly-close, assembly-insert, assembly-solder, assembly-wires, assembly-access, assembly-battery, assembly-screws, assembly-held: get_assembly_plan has the steps). Each issue says what, why and the fix. Run it after wiring and before trusting a design.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    name: "fidelity_report",
    title: "How far to trust the simulation",
    description: "Honesty report: per part (exact/behavioral/stub and weakest areas), per area (logic, timing, analog, power, radio: ok/approx/not simulated, with notes) and a 'test on the real device' checklist. Include its summary and checklist in your final answer to the user.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    name: "screenshot",
    title: "Picture of the canvas",
    description: 'Render the canvas to a PNG (parts, wires, glowing LEDs, OLED pixels, HIGH wires in green; robots also get a panel with the arena from above or the arm from the side) at the current simulated moment: {"path": "shots/pet.png"} (relative to the project; default screenshot.png). Colour TFT screens are drawn with their real pixels. Returns the file path. Run first to capture a live state, or pass view "device" to see the device as a 3D product shot ({"view": "device", "ms": 4000}), or pass scenario (and at_step) to replay a test in a fresh simulation up to that step and picture that exact moment: {"path": "shots/playback.png", "scenario": "playback", "at_step": 12}. A .svg path writes SVG.',
    inputSchema: { type: "object", properties: { path: { type: "string" }, scale: { type: "number", description: "1 = 1 px per canvas px (default)." }, scenario: { type: "string", description: "Scenario id to replay first (fresh simulation)." }, at_step: { type: "number", description: "Stop after this step index (default: the last step)." }, view: { type: "string", enum: ["canvas", "device"], description: 'canvas (default) or device: the physical device in 3D (handheld with its live screen, rover in its arena, arm on its table) rendered from a fresh simulation at ms.' }, ms: { type: "number", description: "view device only: virtual ms to render at (default: the current session time, or 3000)." } } },
  },
  {
    name: "export",
    title: "Export for the real build",
    description: "Write export/BOM.md (quantities, values, buy links), export/WIRING.md (wire table and nets), export/firmware.hex (when built; firmware.bin, the merged flash image built for the real board, on ESP32 boards) and export/TEST-ON-HARDWARE.md (checklist from the fidelity report). Returns the BOM text and an upload command.",
    inputSchema: { type: "object", properties: { dir: { type: "string", description: "Default export/ in the project." } } },
  },
  {
    name: "list_steps",
    title: "Edit history",
    description: "The recent steps (groups of edits with their why) and their status: pending, accepted, rejected, undone.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    name: "undo",
    title: "Undo the last step",
    description: "Undo the last applied step (all its edits, including file writes). redo brings it back.",
    inputSchema: { type: "object", properties: {} },
    edits: true,
  },
  {
    name: "redo",
    title: "Redo",
    description: "Re-apply the last undone step (only possible until the next edit).",
    inputSchema: { type: "object", properties: {} },
    edits: true,
  },
  {
    name: "accept_step",
    title: "Accept steps",
    description: 'Mark a step (or all pending ones, the default) as accepted by the human: {"step": 3} or {}.',
    inputSchema: { type: "object", properties: { step: { type: ["number", "string"] } } },
  },
  {
    name: "reject_step",
    title: "Reject a step",
    description: 'Revert one step by id, even if it is not the last: {"step": 3}. Entities changed again by later steps are kept (the result lists them); if later steps depend on it (e.g. wires on a part it added) it refuses and says which to reject first.',
    inputSchema: { type: "object", properties: { step: { type: "number" } }, required: ["step"] },
    edits: true,
  },
  ...NETWORK_TOOLS,
  // Round 5: each track's tools live in src/tools/<track>.ts (decision 0003, C5).
  ...TOOL_MODULES.flatMap((m) => m.tools),
];

/** The recommended loop, used as MCP server instructions and in the docs. */
export const AGENT_LOOP = `Jumper is a hardware sandbox: Arduino boards, parts and wires on a canvas, real compiled firmware, a deterministic simulator. You drive it only through these tools; you never need Jumper's source.

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
5. write_file firmware/main.ino (Serial.begin(115200) and print what happens); set_libraries if it includes libraries. Other languages: set_firmware {"language": "micropython"} (Pico / XIAO RP2040: firmware/main.py, print() goes to the Serial panel, which is also the REPL), "esp-idf" or "platformio"; plan_device says which languages the board runs.
6. run {ms} (builds automatically): read serial, pins, part states; read_display for screens; interact / set_sensor_value to play with it.
7. write_scenario for each behaviour of the goal, then run_tests; fix firmware or wiring until all pass (then your pending steps are accepted).
8. inject_fault (disconnect, i2c_nack, noisy, wifi_drop) to check the firmware copes, if it matters. Wi-Fi devices (ESP-01) reach a sandbox network with an AI at http://ai.jumper/v1/pet (add &m=<what the person said> to pass their words): read_network_log shows what they did; set_ai_mode live + run_live lets a real model answer. Boards with Wi-Fi in the emulator (ESP32 family) join Jumper's device network: plain WiFi.begin() / HTTPClient / WebSockets / MQTT sketches work unchanged (write them for the real device, real root CA); set_network (mode mock by default, internet + allow list, secrets by NAME, values in .env), add_mock_api for any API (HTTP, streamed chunks, WebSocket frames, MQTT broker), try_request to check one, read_network for what the device did, inject_network_fault (wifi_drop, weak_signal, latency, http_error, timeout, dns_fail) and scenario steps {"request": ...} / {"network_fault": ...} / {"network_mock": {mock}} (another answer for one test only, e.g. a dry forecast next to the rainy one in mocks.json; a mock path may carry a query, "/v1/forecast?lat=51.5*"). An API that needs a key (an AI, vision, speech, any service): the firmware calls that API at its real host through the relay (#include "JumperRelay.h", jumperRelayUrl(host, path); get_part on the board, field network, has the pattern), set_network allows the host with its secret, add_mock_api mocks the same host; never invent a backend of your own for the person to write (jumper relay init generates the real relay from jumper.json).
9. Show it: screenshot returns the picture inline (show it) plus its path; record makes an MP4 of your build and the device running; viewer_url gives a link where the person runs it and presses its buttons. Give links and paths, never a terminal command, to people who did not ask for one.
10. fidelity_report: tell the person what was verified and, honestly, what the simulation cannot check (plan_device's cannot_check: real feel, sound, battery life, stand-ins). export when done; delete_file removes stale shots or debug sketches.
11. A real device: when the person wants to hold it (or asks about size, a case, printing or a factory), the flow ends with design_case {"shape": "pebble" | "puck" | "pill" | "rounded-box" | "keychain"} (save: false for side-by-side variants; update_case to change wall, closure, clip). Any other shape the person wants (an egg, a heart, a bean, a character) is shape "custom" with an outline you draw (SVG path in mm, or points with smooth: true) and, if they gave one, size_mm; there is no preset per object. Test it first with check_fit (under a second, no CAD): when the parts do not fit the asked size it lists what misses by how much and smaller parts that would fit (a smaller LiPo cell, a smaller screen or speaker, a board on its edge) or "make it N mm bigger"; tell the person the trade-off and let them choose before design_case. Case choices cost size: do not pin positions (placements x_mm / y_mm / layer / face) unless the person asked for that spot; leave dome_mm and the edges on auto (each mm of dome is a mm of thickness per face); call propose_layout before design_case; every check_fit / propose_layout / design_case / update_case answer has costs (what each of your choices adds, with the update_case call that relaxes it): read it and relax the costly choices unless the person asked for them. Pocket and hand-held devices (an egg, a pet, a remote): aim for 20 mm thick or less. Then show its renders and the measured size and checks (pocket verdict, screen window, button travel, USB access). Then get_assembly_plan: Jumper works out how it goes together for that case (what to buy, what to print, which shell each part goes into and in what order, when each wire is soldered, the battery last and insulated, a test before closing) with a picture per step; tell the person in plain words what to buy and print and walk them through the steps, and fix what its checks flag (assembly-*: a part that cannot go in, wires that do not fit, a port out of reach when closed, foam tape where a clip would do) before the factory pack. Then export_manufacturing: one folder + zip a supplier or a 3D printer can use (STL / 3MF / STEP, drawing, BOM, wiring, netlists, wire cuts, firmware, the assembly steps with their pictures, test plan). Battery devices: set_assembly "soldered" first. Say honestly that the print and the hand feel were not tested. When the person will build it themselves ("what do I buy", "what do I print", "how do I put it together", "everything I need"), call get_build_kit: one kit with the shopping list (exact variants, store links, totals per store, the things people forget), the print list (material, orientation, grams, time), the tools, the assembly plan's steps with their pictures and wire cut lengths, flashing and troubleshooting; give them kit.html (or the Build it button in the Case view) and tell them the total to buy and the time in plain words.

${renderInstructionsBlock({ tools: TOOLS.map((t) => t.name) })}

Conventions: pins are "part.pin"; ids have no dots; time is virtual ms; every error says what failed, why, and the fix: do what it says. Full guide: resource jumper://docs/agents.`;
