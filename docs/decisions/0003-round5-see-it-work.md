# 0003 — Round 5: see it work, every project, pocket boards, parts agents can make

Status: accepted · 2026-11-10

The owner asked for four things: the UI must show projects and how they change, it must actually
show the device working, Fabwright must test small "pocket" boards, and agents must be able to create
the parts that are missing. The synthetic user test (`jumper-evals/personas/REPORT.md`) ranks the
same gaps: no code view, Run fails silently, an empty jargon first screen, "agent connected" when
none is, no video for the person, missing beginner parts, stand-ins exported as real parts, and
check_design false positives.

Six tracks build this in parallel worktrees: **live**, **projects**, **rp2040**, **parts**,
**agentparts**, **agent**. This note records each track's choice and, more importantly, the shared
contracts (C1 to C10) their merges must fit. If a track needs to change a contract, it changes the
code and this file in the same commit and says so in its report.

## Choices per track

### live: the followed page runs the device in place

| Option | For | Against |
| --- | --- | --- |
| **Run the sim in the browser with the latest built hex (chosen)** | Same engine as `?local` and examples, 60 fps canvas, real interaction latency, colour TFT pixels for free | Two simulations of one project (agent's in the server, person's in the page); they can diverge |
| Stream frames from the server's sim | One truth | TFT frames are 150 KB; pointer input round-trips; the server sim is paused between agent calls |
| Keep "Run a copy" | Exists | The person loses the live link; the report calls it confusing |

The page's simulation is the person's: the agent's runs do not drive it, they only trigger a reload
and (by default) an auto-run after a successful build / run / run_tests (`auto-run` event, C6).
Interaction (press, knob drag, tilt) goes to the page's sim; it never moves parts while running.
Agent state comes from one place, the server (C6), never from "the websocket is open".

### projects: a gallery, versions, code

- **Projects home** from the server (`GET /api/projects`, C3): repo `projects/`, `examples/`,
  `examples/agent-built/`, plus folders in the registry `$FABWRIGHT_HOME/projects.json` (C3). Opening
  an example **copies it** into `projects/<slug>` (`POST /api/projects {from}`), so it never wipes a
  circuit. Without a server (`pnpm dev`, static build) the gallery shows the bundled examples only.
- **Versions = action-log lines that changed something** (`ok` and `project` or `file`), not the
  undo steps: steps get merged, rejected and undone, while the log is append-only and already holds
  the full project after each change, so version N is cheap to rebuild and never lies. Built hexes
  are kept by hash in `.fabwright/builds/` (done in this commit), so version N can run its firmware.
- **Code editor: CodeMirror 6** (MIT; installed in this commit: `codemirror@6.0.2`,
  `@codemirror/{state@6.7.6,view@6.43.15,lang-cpp@6.0.3,lint@6.9.7}`). Monaco is 5 MB and needs
  workers; a textarea has no highlighting or inline errors. Save = `write_file`, Build = `build`,
  both through the server queue as actor `web`, so the agent, the CLI and the page share one path.
  Compile diagnostics already carry `file/line/column/hint`; they become CodeMirror lint markers.

### rp2040: a second MCU backend

| Option | For | Against |
| --- | --- | --- |
| **rp2040js (MIT, Wokwi's open-source core emulator) (chosen)** | Cortex-M0+ with GPIO, PIO, UART, I2C, SPI, PWM, ADC, timers, USB CDC; runs in Node and the browser; deterministic when we drive its clock | Peripheral gaps (see below); it is a library, not Wokwi's product, so no Wokwi parts/assets are involved |
| QEMU (raspberrypi fork) | Wide coverage | Native binary, no browser, no cycle-exact stepping |
| Write our own | Total control | Months |

Toolchain: **arduino-pico** (earlephilhower, LGPL-2.1 core, like `arduino:avr`; disclosed in
NOTICE) pinned in a Docker image built by `services/runner` like the AVR one, FQBNs per board (C1).
`Serial` on arduino-pico is **USB CDC**, not a UART: the backend's `onSerial` carries the USB CDC
stream (what the console shows); `Serial1`/`Serial2` are UART0/UART1 on GPIO pins and reach parts
through the pins like on hardware.

**ESP32-S3 / C3 plan (not implemented this round).** Espressif's QEMU fork (`qemu-system-xtensa
-M esp32s3`, `qemu-system-riscv32 -M esp32c3`) runs real ESP-IDF / arduino-esp32 binaries with
Wi-Fi replaced by OpenCores Ethernet. Shape: a `qemu-esp32` backend that runs QEMU as a child
process (Node only; the browser shows a server-streamed state), drives GPIO through QEMU's GPIO
chardev / a small QMP shim, maps UART0 to `onSerial`, and bridges the Ethernet NIC to the existing
sandbox network (`ai.fabwright`). Effort: about 3 to 4 weeks for GPIO + UART + I2C + network on C3,
then S3. Gaps: no cycle-exact clock (QEMU icount mode gives determinism at about 10x slowdown),
no ADC / LEDC PWM / RMT models in upstream QEMU for C3 (would need patches), no BLE, no browser
run, a 300 MB binary per OS. Until then the ESP-01 AT sandbox stays the Wi-Fi path.

**What the rp2040 track built (and where it deviates).** Details: [docs/rp2040.md](../rp2040.md).

- **No Raspberry Pi boot ROM (deviation from "the bootrom is bundled as a TS module").** The
  official ROM contains Mark Owen's float library, licensed only for use on an RP2040 chip or under
  GPL-2.0, so it cannot ship in this Apache-2.0 repo. `sim-backends/src/rp2040/rom.ts` lays out the
  documented ROM tables (lookup, float/double, mem, bit, flash) with native TypeScript functions
  behind `BKPT` stubs. Creation stays synchronous, as C1 asks. Fidelity: +, -, *, /, sqrt round
  like IEEE-754, denormals flush to zero like the ROM, sin/cos/exp/ln may differ in the last bit,
  cycle costs are typical values. Each board's fidelity.json says so.
- **PIO on the virtual clock.** rp2040js 1.4.1 runs PIO from `setTimeout` (wall clock, ignores
  clkdiv). The backend steps the state machines itself at clk_sys/clkdiv; `tone()` (a PIO program
  in arduino-pico) gives a 1000 Hz edge train to the microsecond.
- **Bit-level I2C target.** arduino-pico's `Wire` probes addresses (every scanner and
  `Adafruit_I2CDevice::begin()`) by bit-banging SDA/SCL, so a byte-level bus alone made
  `mpu.begin()` fail. `soft-i2c.ts` decodes the bits and ACKs like the device.
- **rp2040js workaround:** an I2C abort never raised TX_EMPTY, so the pico-sdk waited forever
  after a NACK; the backend raises it.
- **Firmware is Intel HEX** (C1); the image's wrapper runs `objcopy -O ihex` on the ELF. Export
  also writes `firmware.uf2` (byte-identical to arduino-pico's) for the BOOTSEL drive.
- `McuBackend` is unchanged (no optional members were needed); `backendFactory` has one branch.

### parts: real pocket parts and physical data

Fourteen new parts (C2 list in the track brief) with original SVG art, each a full part folder.
Every part, old and new, gets `dimensions_mm`, `mass_g`, `current_ma`, `price_usd`, `buy_links`
(C2), which `plan_device` sums. The passive buzzer reports the tone frequency from the PWM period,
so melodies are testable; the active `buzzer` warns when driven with `tone()`.

### agentparts: declarative parts, no code execution

| Option | For | Against |
| --- | --- | --- |
| **Declarative JSON with behaviour templates (chosen)** | Safe (no code runs), validated with zod, diffable, exportable as JSON Schema, renders in the browser without a build | Cannot express every part |
| Agent-written `model.ts` run in a sandbox (vm / QuickJS) | Anything goes | Arbitrary code in a person's tools and browser, determinism not guaranteed, sandbox escapes |
| Only stand-ins | Nothing to build | The report shows stand-ins mislead exports and people |

Templates cover most hobby parts: digital-input, analog sensor, actuator / load, I2C register map,
UART line device, display reusing an existing controller. Fidelity is always
`agent-made: behavioral, unverified` and is printed as such everywhere (C4).

### agent: plan first, show me, fewer false alarms

`plan_device` turns a wish into a BOM with sizes, battery life and price before anything is placed;
server instructions tell agents to show the plan in plain words, ask one question when the wish is
ambiguous, make a new project per idea, and say what the simulation cannot check. `record` gives
the person an mp4; `screenshot` returns the image inline plus its path; a local viewer URL opens
the project live. check_design fixes come from the report (C5 has the codes).

---

## Shared contracts

### C1. Board backends

- A board part declares its simulator in `part.json` `mcu.backend`: **`"avr8js"` or `"rp2040js"`**
  (`BOARD_BACKENDS` / `BoardBackendId` in `@fabwright/sim-core`; the parts validator rejects anything
  else for shipped boards; test fakes may use other ids). The existing id `avr8js` is kept, so no
  part, project or doc changes for AVR.
- RP2040 boards: `mcu = { backend: "rp2040js", chip: "rp2040", clockHz: 125000000, vcc: 3.3, fqbn }`
  with FQBNs `rp2040:rp2040:rpipico`, `rp2040:rp2040:seeed_xiao_rp2040`,
  `rp2040:rp2040:waveshare_rp2040_zero`. Part ids: `raspberry-pi-pico`, `seeed-xiao-rp2040`,
  `waveshare-rp2040-zero`.
- `backendFactory` (`packages/sim-backends/src/index.ts`) dispatches on `mcu.backend`; the rp2040
  track adds one branch and `packages/sim-backends/src/rp2040/**`. Creation stays **synchronous**
  (the bootrom is bundled as a TS module, no fetch), so `Simulation`, the web engine and the session
  need no async change.
- The `McuBackend` interface (`packages/sim-core/src/mcu.ts`) keeps its signatures. The rp2040
  track may add **optional** members only (e.g. `adc?: { bits: number; vref: number }`), so AVR and
  test fakes still compile.
- **RP2040 pin ids are `GP0`…`GP29`** (the arduino-pico pin number is the GPIO number), with the
  silkscreen as `label` (XIAO `"D0/A0"`). Power pins `3V3`, `VBUS` (USB 5 V), `VSYS`, `GND.1…`.
  Bus pins carry the same `protocols` tags as AVR (`i2c-sda`, `spi-sck`, `uart-tx`, `pwm`, `adc`).
- **Firmware artifacts are always Intel HEX text** at `firmware/<sketch>.hex`. For RP2040 the
  runner converts the ELF with `objcopy -O ihex` (absolute 0x10000000 flash addresses, extended
  linear address records). `/api/project`, the web firmware store, the action log, golden fixtures
  and `McuBackend.load(hexText)` are unchanged.
- Determinism: the RP2040 clock is advanced only by `step(cycles)`; no timers, no wall clock.
- DRC for 3.3 V boards is the **agent** track's (C5 codes); the rp2040 track does not edit
  `drc.ts`, it gives its board pins correct `voltage` ranges (`{min: 0, max: 3.3}`) and `mcu.vcc`.

### C2. Part physical data (part.json, snake_case, all in `PartSpecSchema`, done in this commit)

```jsonc
"dimensions_mm": { "w": 21, "h": 17.5, "d": 3.5 },   // outer size of the module as sold; d = height off the board
"mass_g": 3,                                          // grams, without wires
"current_ma": { "typ": 25, "max": 60 },               // supply current the part itself draws; passives {0,0}
"price_usd": 5.4,                                     // typical single-unit price, generic distributor
"buy_links": [{ "vendor": "Seeed", "url": "https://…" }]   // https only; search URLs fine
```

- Optional in the zod schema (so a part can land first); the **parts** track adds a spec test that
  requires all five for every shipped part. The **rp2040** track ships its three boards with all five
  filled in, so that test passes when both are merged.
- `buyLinks` (camelCase, used by no part) is replaced by `buy_links`; `exporter.ts` reads it.
- Instance level (fabwright.json, done in this commit): `parts[].standIn?: string` = the real part a
  stand-in represents ("capacitive soil moisture sensor"). Exports print it (agent track).
- Fidelity (done in this commit): `fidelity.origin?: "builtin" | "agent-made"` (omitted = builtin).

### C3. Server (fabwright serve) HTTP

All endpoints are local-only (Host / Origin checked by serve before any route runs). Routes that
change something require `x-fabwright-token` (from `GET /api/connect`). Errors are
`{ error: "<what failed>. Why: … Fix: …" }`. New endpoints live in
`apps/cli/src/routes/<track>.ts` (`ApiRoute[]`) and start-up work in that file's `ServerHook[]`;
serve.ts only mounts them (done in this commit).

**projects**

| Method, path | Body | Answer |
| --- | --- | --- |
| `GET /api/projects` | | `{ active: id, projects: ProjectCard[], examples: ProjectCard[] }` |
| `GET /api/projects/:id` | | `{ card: ProjectCard, project: Project, files: string[] }` |
| `GET /api/projects/:id/thumbnail.png` | | PNG (canvas render via `composeSvg` + `svgToPng`); cached by sha256 of fabwright.json in `<dir>/.fabwright/thumbs/<hash>.png`, or `$FABWRIGHT_HOME/thumbs/<id>-<hash>.png` for read-only folders |
| `POST /api/projects` | `{ name, template?, from?: exampleId }` | `{ id, dir }`; creates via `newProjectFolder(projectsRoot, name)`, registers it (`source: "web"`), opens it |
| `POST /api/projects/:id/open` | | `{ id, dir }`; switches the active project, broadcasts `{type:"project"}` then a fresh `hello` |
| `GET /api/history` | | `{ versions: VersionSummary[] }` for the active project |
| `GET /api/history/:version` | | `{ version, project, files: Record<path, content>, firmware?: { hash, hex }, frame?: { t_ms, parts: Record<id, VisualState> }, changes }` |
| `POST /api/history/:version/restore` | `{ why? }` | the `restore_version` op result (C5), actor `web` |
| `GET /api/files` | | `{ files: { path, size }[] }` (firmware folder) |
| `GET /api/file?path=` | | `{ path, content }` |
| `PUT /api/file` | `{ path, content }` | `write_file` result, actor `web` |
| `POST /api/build` | `{ run?: boolean }` | `{ ok, diagnostics: CompileDiagnostic[] (file, line, column, severity, message, hint), hash? }` via the `build` op, actor `web` |

```ts
ProjectCard = { id: string /* projectId(dir): 12 hex of sha256(abs dir) */, name: string, dir: string,
  kind: "project" | "example" | "agent-built" | "registered", description?: string,
  board?: string /* part type */, boardName?: string, parts: number, updatedAt: string /* ISO */,
  tests?: { passed: number; total: number; at?: string }, thumbnail: string /* URL with ?v=<hash> */,
  readOnly: boolean /* examples: open copies them */ }
VersionSummary = { version: number /* 1-based among ok action-log lines with project or file */,
  seq: number, t: string, actor: string, client?: string, op: string, why?: string, summary?: string,
  step?: number, changes: { added: string[]; removed: string[]; changed: string[] } /* entity keys "part:led1", "wire:w3", "file:firmware/main.ino" */,
  firmwareHash?: string, hasFrame: boolean }
```

- Version N's firmware: the last `entry.firmware.hash` at or before N, read from
  `.fabwright/builds/<hash>.hex` (written by `build` since this commit).
- Registry of project folders (done in this commit, `packages/session/src/projects-registry.ts`):
  `$FABWRIGHT_HOME/projects.json` (`FABWRIGHT_HOME` defaults to `~/.fabwright`; **tests always set it to a
  temp dir**), `{ version: 1, projects: [{ dir, name, source: "agent"|"web"|"cli"|"serve", addedAt,
  lastOpenedAt }] }`, helpers `registerProject`, `listRegisteredProjects`, `unregisterProject`,
  `newProjectFolder(root, name)`, `projectSlug`, `projectId`.
- Switching the active project: `ProjectSession.dir` stays readonly; serve keeps **one MCP endpoint
  and one hub** and swaps the session behind them. `SessionOptions.openProject(dir)` (done in this
  commit) is the hook the session calls for `new_project {folder}`; the **projects** track implements
  it in serve (new session, `hub.retarget(session)` added to `session/src/live.ts` as one method at
  the end of the hub object, MCP `call` reads the current session). `SessionOptions.projectsRoot`
  defaults to the parent of `dir` (`projects/` for `pnpm start`).

**live**

| Method, path | Body | Answer |
| --- | --- | --- |
| `GET /api/agent-state` | | `AgentState` (C6) |
| `GET /api/firmware` | | `{ hash, hex, artifact, board, backend, builtAt }`, or 404 with why / fix (no board, no sketch, not built) |

`GET /api/project` keeps its shape (used by `?local`).

**agent**: `GET /v/:id` → 302 to `/?follow=ws://<host>/live&project=<id>&autorun=1` (the
shareable local viewer; the live track's follow page honours `autorun=1`); `GET /api/media/:file`
serves recordings from `<project>/.fabwright/media/` only. serve starts the AI gateway (port from
`FABWRIGHT_AI_GATEWAY_PORT`, default 8787, next free port when taken, never fails serve) in
`agentHooks`.

**agentparts**: `GET /api/project-parts` → `{ parts: { id, part: CustomPart, svg: string }[] }`
(svg already sanitized or generated).

### C4. Custom (agent-made) parts

- Stored in the project: **`<project>/parts/<id>/part.json`** + optional
  **`<project>/parts/<id>/visual.svg`**. Written only through `create_part` / `update_part` (so they
  are steps, undoable, in the action log as `file` entries).
- `part.json` has `"format": "fabwright-part/1"`, the `PartSpec` fields minus `mcu` (`id`, `name`,
  `category`, `description`, `pins`, optional `size`, `props`, `bus`, C2 physical fields, `tags`)
  plus **`behavior`**, one of:
  `{ kind: "digital-input" }`, `{ kind: "analog-sensor" }`, `{ kind: "actuator" }`,
  `{ kind: "i2c-device" }`, `{ kind: "uart-device" }`, `{ kind: "display", controller:
  "ssd1306" | "st7735" | "ili9341" | "gc9a01" }` (the agentparts track defines each kind's fields;
  `gc9a01` is enabled once the parts track's controller is merged), and optional
  `usage: { wiring, example?, libraries? }` for get_part.
- Zod schema `CustomPartSchema` in `packages/parts/src/custom/schema.ts`; JSON Schema written by
  `pnpm gen` to `packages/parts/custom-part.schema.json`. Loader `loadProjectParts(dir):
  PartDefinition[]` and `compileCustomPart(part, svg?)` in `packages/parts/src/custom/`, usable in
  Node and the browser (no fs inside `compileCustomPart`).
- Ids must not collide with a built-in type (create_part refuses and says which); within a project
  the custom part wins if a later built-in takes the id, with a warning.
- Fidelity is generated: `{ level: "behavioral", origin: "agent-made", … }`; reports, BOM and
  WIRING print **"agent-made: behavioral, unverified"**.
- SVG: sanitized (no `<script>`, no `on*=` attributes, no `href`/`xlink:href` other than `#…`, no
  `<foreignObject>`, no external `url(…)`, no `<image>` with non-`data:` sources); otherwise an
  auto-generated labelled module drawing from the pins.
- Session: the registry becomes builtins + project parts, refreshed in `sync()` (agentparts adds
  one marked block in session.ts). Web: `apps/web/src/lib/parts.ts` gets an overlay
  (`setProjectParts(defs)`), fed by agentparts' own `apps/web/src/lib/projectParts.ts`
  from `GET /api/project-parts`.

### C5. MCP tools (same names as CLI: `fabwright <tool>` / `fabwright call <tool>`)

New tools live in `packages/session/src/tools/<track>.ts` as a `ToolModule` (`tools` + `ops`),
appended to `TOOLS` and routed by `ProjectSession.call` with the same validation, logging and undo
as built-ins (done in this commit). Handlers get `ExtOpContext { session, why, commit(label, next,
files), summary(text), target(part, pin?) }`.

| Tool | Track | Params | Returns |
| --- | --- | --- | --- |
| `create_part` | agentparts | `{ part: CustomPart, svg?: string, why? }` | `{ type, pins, fidelity: "agent-made: behavioral, unverified", warnings, next }` (edits) |
| `update_part` | agentparts | `{ id, part?: CustomPart, svg?: string \| null, why? }` | same (edits) |
| `list_project_parts` | agentparts | `{}` | `{ parts: { type, name, behavior, pins }[] }` (read-only) |
| `plan_device` | agent | `{ goal: string, constraints?: { pocket?: boolean, max_size_mm?: {w,h,d}, budget_usd?: number, battery_hours?: number, board?: string } }` | `{ summary, question?, board: {type, why}, bom: { type: string \| null, name, qty, why, source: "simulated-exactly" \| "stand-in" \| "agent-made" \| "not-simulated", current_ma?, price_usd?, buy_links? }[], size_mm: { parts: {w,h,d}, enclosure: {w,h,d} }, battery?: { type, capacity_mah, avg_ma, hours }, total_usd, cannot_check: string[] }` (read-only) |
| `record` | agent | `{ actor?: "mcp" \| "all", ms?: number, speed?: number, size?: "1280x720" }` | `{ path, url, viewer_url, duration_s }`; fails in under 5 s with why / fix when Chromium is missing |
| `viewer_url` | agent | `{}` | `{ url, note }` (local only) |
| `delete_file` | agent | `{ path, why? }` | `{ deleted }` (edits) |
| `restore_version` | projects | `{ version: number, why? }` | `{ version, step, changes }` (edits) |

Changes to existing tools:
- `new_project` (agent): `folder?: boolean | string`. Creates `newProjectFolder(session.projectsRoot,
  folder === true ? name : folder)`, writes the template there, `registerProject(dir, {source:
  "agent"})`, then `session.openProject?.(dir)`; without the hook it says "reopen with --project
  <dir>". Returns `{ dir, id, viewer_url? }`. The `template` enum is `Object.keys(TEMPLATES)` (done
  in this commit), so rp2040's templates (`pico`, `xiao-rp2040`, `rp2040-zero`) appear without
  touching catalog.ts.
- `search_parts` (agentparts): when nothing fits, `hint` names `create_part`.
- `screenshot` (agent): image content inline plus absolute `path`.
- `run_tests` (agent): all pass → pending steps are accepted (`accepted_by: "tests"`) or the result
  says why not.
- `check_design` (agent) issue codes: `led-no-resistor` (now along the whole LED path, either side),
  `logic-level` (a pin driving above the receiver's `voltage.max` + 0.3 V; 3.3 V into a 5 V input is
  fine), `part-needs-5v` (a part whose supply min is above 3.6 V on a 3.3 V board's rail),
  `parallel-regulators` (two supply outputs on one net), `rail-3v3-budget` (sum of `current_ma.typ`
  on a 3V3 pin above the board's `limits.max3v3mA`, default 50 mA AVR / 300 mA RP2040 boards),
  `far-apart` (info: a part more than 600 px from every part it is wired to).
- AI pet (agent): `GET /v1/pet?…&m=<urlencoded, ≤60 chars>` passes the person's message to the model.

### C6. Live websocket (ws://…/live)

Types in `packages/session/src/live-events.ts` (done in this commit: `LiveServerEvent`,
`AgentState`, `AGENT_IDLE_AFTER_MS = 10000`). Existing: `hello`, `action`, `presence`, `result`.
New:

| Event | Sent by | When |
| --- | --- | --- |
| `{ type: "agent-state", state: AgentState }` | live | on connect and on every change |
| `{ type: "firmware", artifact, hash, board, backend, at }` | live | after a build wrote a new hex |
| `{ type: "auto-run", after: "build" \| "run" \| "run_tests", hash? }` | live | after an agent build / run / run_tests finished ok |
| `{ type: "project", dir, id }` | projects | the active project changed (a `hello` follows) |
| `{ type: "version", version, at, actor, why? }` | projects | a new version exists |

`AgentState.status`: `none` until an MCP client **calls a tool** (connecting does not count),
`building` while calls arrive (or one runs), `idle` after 10 s without calls with a session open,
`done` when every session that called a tool has ended. `actions` counts real agent tool calls
(actor `mcp`, ok or failed). The bottom pill, the Install MCP popover and the Agent steps panel all
read this, nothing else. Action-log `firmware` entries now carry `hash` (done in this commit).
Clients ignore unknown event types.

### C7. Hints (get_part usage)

`packages/session/src/hints.ts` merges three tables (done in this commit): core (frozen this
round), `hints-parts.ts` (**parts**), `hints-boards.ts` (**rp2040**). The rp2040 track owns the
board-aware functions in hints.ts (`derivedWiring`, `pinKind`, `suggestConnections`: today they
assume A4/A5 and D/A pin names). Custom parts' hints come from their `usage` field (agentparts edits
only `usageFor`'s first lines).

### C8. Who owns which files

| Track | Owns (edits freely) | Touches in a shared file (keep it small) |
| --- | --- | --- |
| live | `apps/web/src/live/**`, `apps/web/src/connect/**`, `apps/web/src/interact/**` (new), `shell/Corners.tsx`, `shell/TopActions.tsx`, `lib/engine.ts`, `components/PartNode.tsx`, `components/Inspector.tsx`, `packages/session/src/live.ts`, `packages/mcp/src/http.ts`, `routes/live.ts`, `e2e/live-*.spec.ts` | `lib/app.ts` (follow loading) |
| projects | `apps/web/src/projects/**`, `apps/web/src/code/**` (new), `shell/TitleBlock.tsx`, `components/EmptyHint.tsx`, `lib/examples.ts`, `shell/Panels.tsx` (Firmware panel), `routes/projects.ts`, `tools/projects.ts`, `e2e/projects-*.spec.ts` | serve.ts (session swap), live.ts (`retarget` only), `apps/cli/src/main.ts` (register `--project` folders) |
| rp2040 | `packages/sim-backends/src/rp2040/**`, `toolchains/arduino-pico/**`, `services/runner/**`, three board part folders, `hints-boards.ts`, hints.ts functions, `templates.ts`, `packages/sim-core/src/mcu.ts` (optional members) | `sim-backends/src/index.ts` (one branch), session.ts (`export` flash line, fqbn default), NOTICE (append) |
| parts | new part folders, physical data in existing `part.json`, `packages/parts/src/lib/**`, `packages/parts/src/spec/**`, `hints-parts.ts`, `apps/web/src/renderers/**`, `packages/physics/**`, `docs/part-spec.md`, `docs/adding-a-part.md` | none |
| agentparts | `packages/parts/src/custom/**`, `tools/agentparts.ts`, `routes/agentparts.ts`, `apps/web/src/lib/parts.ts`, `apps/web/src/lib/projectParts.ts` (new), `packages/session/src/fidelity.ts`, `docs/custom-parts.md` (new) | session.ts (registry overlay in constructor / `sync`, one marked block; `searchParts` hint), hints.ts (`usageFor`) |
| agent | `tools/agent.ts`, `routes/agent.ts`, `drc.ts`, `exporter.ts`, `network.ts`, `screenshot.ts`, `device-render.ts`, `packages/mcp/src/server.ts`, `services/ai-gateway/**`, `apps/web/src/views/network/**`, `docs/agents.md`, `AGENTS.md` | catalog.ts (`AGENT_LOOP`, `new_project` schema), session.ts (`newProject`, `export`, `runTests`, `screenshot`) |

Shared files and how they are touched:
- **`App.tsx`: nobody.** Mount components through `apps/web/src/projects/slots.tsx` and
  `apps/web/src/live/slots.tsx` (`stage` = inside `<main class="stage">`, `chrome` = top level);
  `shell/slots.tsx` renders them (done in this commit). Other tracks needing a mount add a
  `slots.tsx` of their own and one line in `shell/slots.tsx`.
- **`registry.gen.ts`, `fabwright.schema.json`, `custom-part.schema.json`, `docs/mcp-tools.md`:
  generated.** Never hand-merge: take either side, run `pnpm gen`, commit the result.
- **`tools/index.ts`, `routes/index.ts`, `shell/slots.tsx`: append-only**, one line per track.
- **`catalog.ts`**: new tools never go here (C5). **`session.ts`**: only the methods listed above.
- **`pnpm-lock.yaml`**: `rp2040js@1.4.1` (sim-backends) and CodeMirror (web) are installed in this
  commit. A track that still needs a dependency adds it with an exact version at least two weeks
  old, and at merge the lockfile is regenerated with `pnpm install`, never hand-merged.
- **STATUS.md**: the lead updates it after the merges; tracks report in their final message.
- **NOTICE**: append-only.

### C9. Ports and test isolation

- Never use, kill or restart anything on **7780** (the owner's `fabwright serve`).
- `apps/web/playwright.config.ts`: `E2E_PORT` (Vite, default 5173), `E2E_OUTPUT_DIR`; specs that
  start `fabwright serve` take ports from `hubPort(info, slot)` in `e2e/helpers.ts`
  (`E2E_HUB_PORT_BASE`, default 7900). `apps/web/vite.config.ts` reads `VITE_PORT` for `pnpm dev`.
- Per track: live `E2E_PORT=5181 E2E_HUB_PORT_BASE=8100`, projects `5182 / 8200`, rp2040 `5183 /
  8300`, parts `5184 / 8400`, agentparts `5185 / 8500`, agent `5186 / 8600`. Manual `fabwright serve`
  runs use `--port 7791…7796 --strict-port` in the same order. AI gateway in tests: port 0.
- Unit tests start servers on port 0 and set `FABWRIGHT_HOME` to a temp dir.
- Docker: the rp2040 track tags its image `fabwright/arduino-pico:<pinned>`; nobody else rebuilds images.

### C10. Merge order

1. **parts** (schema data, parts, hints tables), 2. **agentparts** (custom parts; enables `gc9a01`
displays after rebasing on parts), 3. **agent** (DRC codes, plan_device reads C2 and agent-made
parts), 4. **rp2040** (its 3.3 V DRC test expects agent's `logic-level` / `part-needs-5v`),
5. **projects**, 6. **live**. After each merge: `pnpm gen`, `pnpm typecheck`, `pnpm test`; e2e after
the last. A track whose test depends on a later track writes that test against the contract above
and lists it in its report, so the lead runs it after the merge.
