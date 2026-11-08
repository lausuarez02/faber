# M0 contracts

The API every M0 builder codes against. Written in the contracts phase; if you need to change a
signature here, change it in the code **and** in this file, and say so in your report.

Read with: `docs/brief.md`, `docs/decisions/0001-m0-foundations.md`.

## Ground rules

- pnpm workspaces, Node 24, pnpm 10.34.6. **Do not run `pnpm add`/`pnpm install` for new deps**: everything is installed (list at the end).
- Internal packages export TypeScript source: `"exports": { ".": "./src/index.ts" }`. No build step between packages. Import with `.ts` extensions inside a package (`./foo.ts`); import other packages by name (`@jumper/sim-core`).
- TypeScript **7.0.2** (native `tsc`) works with this setup; no pin-down was needed. Config is strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` (use `import type` for types).
- Determinism: no `Date`, `Math.random`, `performance.now` or timers inside `sim-core`, `sim-backends` or part models.
- Original work only (no Wokwi assets/code), MIT/Apache-2.0 compatible, no secrets, no remotes, do not commit.

## Commands (root)

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc -p tsconfig.json` over every workspace (`packages/*/src`, `packages/*/scripts`, `apps/web/src`, `apps/web/e2e`, configs). |
| `pnpm test` | Vitest, one project per workspace (`vitest.config.ts` → `packages/*` + `apps/web`). Picks up any `*.test.ts(x)` under a package. |
| `pnpm test:e2e` | Playwright in `apps/web` (desktop + Pixel 7 projects; starts Vite on :5173 itself). |
| `pnpm gen` | Writes `packages/project-format/jumper.schema.json` and `packages/parts/src/registry.gen.ts`. Run after touching any part folder. Generated files are committed. |
| `pnpm dev` / `pnpm build` | Vite dev server / production build of `apps/web`. |

Per-package: `pnpm --filter @jumper/<name> test`, or `pnpm vitest run packages/<name>`.

## Layout

```
apps/web/                     Vite + React app (@jumper/web). vite.config.ts, vitest.config.ts (jsdom), playwright.config.ts, e2e/
packages/project-format/      @jumper/project-format  (DONE)
packages/sim-core/            @jumper/sim-core        (DONE)
packages/sim-backends/        @jumper/sim-backends    (avr8js backend)
packages/parts/               @jumper/parts           (10 parts + generator)
  scripts/gen-registry.ts
  src/parts/<part-id>/{part.json, model.ts, visual.svg, fidelity.json, model.test.ts}
  src/registry.gen.ts         GENERATED
  src/index.ts                export { partDefinitions, registry }
examples/blink/               jumper.json + firmware/{blink/blink.ino, blink.hex, build/blink.ino.hex}
toolchains/arduino/           Dockerfile (arduino-cli + pinned arduino:avr core)
brand/tokens.css              design tokens (DONE)
```

---

## @jumper/project-format

File: `packages/project-format/src/{schema.ts, project.ts, jsonSchema.ts, index.ts}`.

### jumper.json shape (`ProjectSchema`, zod 4)

```ts
{
  format: "jumper/1",
  name: string,                       // min 1
  description?: string,
  parts: Array<{                      // default []
    id: string,                       // /^[A-Za-z][A-Za-z0-9_-]*$/, unique
    type: string,                     // part type id from the registry, e.g. "led"
    x: number, y: number,             // canvas px, top-left of the part
    rotation: 0 | 90 | 180 | 270,     // default 0, clockwise
    props?: Record<string, string | number | boolean>,
  }>,
  wires: Array<{                      // default []
    id: string,                       // same id rule, unique
    from: { part: string, pin: string },
    to:   { part: string, pin: string },
    color?: string,                   // CSS color
    waypoints?: Array<{ x: number, y: number }>,
  }>,
  firmware?: {                        // optional (a blank canvas has none)
    board: string,                    // part id of the MCU board
    dir: "firmware",                  // default "firmware"
    sketch?: string,                  // e.g. "blink.ino"
    artifact: string,                 // e.g. "firmware/blink.hex" (relative to jumper.json)
    build?: { tool: "arduino-cli", fqbn: string },
  },
  scenarios: Array<{ id: string, name?: string, [k: string]: unknown }>,  // default []; M1 placeholder
}
```

Cross-field checks: duplicate part/wire ids, wire ends pointing at unknown parts, `firmware.board` not in parts.
Unknown keys are dropped on parse. Pin ids are **not** checked against the registry here (the sim/UI does that).

### Exports

```ts
// values
FORMAT_VERSION                       // "jumper/1"
ProjectSchema, PartInstanceSchema, WireSchema, PinRefSchema, PointSchema, RotationSchema,
PropValueSchema, FirmwareSchema, FirmwareBuildSchema, ScenarioSchema
parseProject(input: string | unknown): Project                 // throws ProjectParseError
safeParseProject(input: string | unknown): ParseResult         // { ok: true, project } | { ok: false, issues }
class ProjectParseError extends Error { issues: ProjectIssue[] } // message lists "path: message" lines
createProject(name: string, description?: string): Project
serializeProject(project: Project): string
buildNets(project: Pick<Project, "wires">, options?: BuildNetsOptions): Net[]
netIndex(nets: readonly Net[]): Map<string /* "part:pin" */, string /* net id */>
pinKey(ref: PinRef): string          // "partId:pinId"
projectJsonSchema(): Record<string, unknown>   // JSON Schema draft 2020-12 (input side)
JSON_SCHEMA_ID                       // "urn:jumper:project-format:1"

// types
Project (parsed, defaults filled), ProjectInput (what you may write), PartInstance, Wire, PinRef,
Point, Rotation, PropValue, Firmware, FirmwareBuild, Scenario, ProjectIssue, ParseResult,
Net { id: string; pins: PinRef[] }, BuildNetsOptions { extraPins?: Iterable<PinRef> }
```

- `ProjectIssue = { path: string; message: string }`, path like `"wires[2].from.part"` (`""` = root).
- `serializeProject`: fixed top-level key order (`format, name, description, parts, wires, firmware, scenarios`), part keys `id, type, x, y, rotation, props` (props sorted), wire keys `id, from, to, color, waypoints`, 2-space indent, **each part / wire / scenario on one line**, trailing `\n`. Byte-identical for equal projects. Moving a part = one-line diff.
- `buildNets`: union-find over wire ends. Net ids `n0, n1, …` ordered by each net's first pin (pins sorted by part id, then pin id). Pins no wire touches are only included when passed in `extraPins` (the Simulation passes every pin of every part).
- Schema file: `packages/project-format/jumper.schema.json` (also exported as `@jumper/project-format/jumper.schema.json`). Regenerate with `pnpm gen`.

---

## @jumper/sim-core

Files: `packages/sim-core/src/{clock.ts, circuit.ts, part.ts, mcu.ts, board.ts, simulation.ts, bindings.ts, hex.ts, hash.ts, index.ts}`. Everything below is exported from `@jumper/sim-core`.

### Clock (`clock.ts`)

```ts
class Clock {
  constructor(frequency: number)          // Hz
  readonly frequency: number
  get cycles(): number                    // JS number, exact to 2^53
  get ms(): number
  toMs(cycles: number): number
  fromMs(ms: number): number              // rounded to whole cycles
  schedule(atCycle: number, cb: (cycle: number) => void): EventId   // absolute; ties run in insertion order
  scheduleIn(delayCycles: number, cb): EventId
  cancel(id: EventId): boolean
  nextEventCycle(): number | undefined
  get pendingEvents(): number
  advanceTo(cycle: number): void          // runs due events in order; throws if going backwards
  advance(cycles: number): void
  reset(): void                           // cycle 0, drops events
}
```

### Circuit (`circuit.ts`): MNA DC solver

```ts
type NodeId = string;  type ElementId = string;
const GROUND = "0", GMIN = 1e-9 /* S, every node */, MIN_R_OUT = 1e-3,
      SWITCH_R_CLOSED = 0.01, SWITCH_R_OPEN = Infinity, DIODE_R_OFF = 1e12;

interface DiodeParams { vf: number; rOn: number; rOff?: number }
interface ElementOptions { id?: ElementId }

interface CircuitBuilder {                         // what PartModel.stamp() receives
  resistor(a, b, ohms, opts?): ElementId           // current > 0: a → b
  voltageSource(plus, minus, volts, rOut = 0, opts?): ElementId  // current > 0: delivered out of `plus`
  currentSource(a, b, amps, opts?): ElementId      // pushes amps from a through the source into b
  diode(anode, cathode, p: DiodeParams, opts?): ElementId   // piecewise linear; current > 0 = forward
  led(anode, cathode, p: DiodeParams, opts?): ElementId     // alias of diode
  switch(a, b, closed: boolean, opts?): ElementId  // closed = 0.01 Ω, open = not stamped at all
}

interface SolveResultView {                        // what PartModel.onSolved() receives
  voltage(node: NodeId): number                    // V vs ground; unknown → 0
  current(id: ElementId): number                   // A; unknown → 0
  isFloating(node: NodeId): boolean                // no conducting path to ground
  isOn(id: ElementId): boolean                     // diode state
}
interface SolveResult extends SolveResultView {
  voltages: ReadonlyMap<NodeId, number>; currents: ReadonlyMap<ElementId, number>;
  floating: ReadonlySet<NodeId>; iterations: number; converged: boolean;
}

class Circuit implements CircuitBuilder { clear(): void; solve(): SolveResult; elementCount; maxIterations = 64 }
gaussianSolve(m: Float64Array, n: number): Float64Array   // n×(n+1) augmented, partial pivoting
scopedBuilder(target: CircuitBuilder, scope: string): CircuitBuilder  // ids → "<scope>/<id or eN>"
```

Behavior worth knowing:
- Voltage sources are stamped as Norton equivalents, so a GPIO is literally `voltageSource(pin, "0", high ? vcc : 0, 25)` and `INPUT_PULLUP` is `voltageSource(pin, "0", vcc, 35_000)`.
- Diodes iterate on/off states until stable (warm-started from the previous solve).
- Floating = no path to ground through resistors, sources, closed switches or **on** diodes. Floating nodes read ≈ 0 V.
- Reference numbers (tested): red LED `{ vf: 2.0, rOn: 5 }` + 220 Ω from 5 V → 13.3 mA; same LED straight on a 25 Ω GPIO → 100 mA.
- **Inside a part, element ids are scoped** by the Simulation (`"led1/e0"`, or `"led1/<your id>"`). Always keep the id *returned* by the builder call from the latest `stamp()` and pass that to `r.current()`.

### Part spec types (`part.ts`) — shape of `part.json` and `fidelity.json`

zod schemas are exported too (`PartSpecSchema`, `FidelitySchema`, `PinSpecSchema`, `PropSpecSchema`, `BindingSpecSchema`, `McuSpecSchema`, `PinTypeSchema`, `FidelityAreaSchema`); the registry generator validates every part folder with them.

```ts
const PART_CATEGORIES = ["board","output","input","passive","sensor","power","display","motor","communication","misc"];

interface PartSpec {
  id: string;                 // kebab-case, == folder name, e.g. "arduino-uno"
  name: string;
  category: PartCategory;
  description: string;
  pins: PinSpec[];
  size: { w: number; h: number };            // visual.svg viewBox size in px == node size on canvas
  props?: PropSpec[];
  limits?: { maxCurrentmA?; maxVoltage?; minVoltage?; maxPowerW?; [k: string]: number };
  footprint?: string;                         // e.g. "THT 5mm LED"
  buyLinks?: { vendor: string; url: string }[];
  bindings?: BindingSpec[];                   // documents visualState keys
  mcu?: McuSpec;                              // boards only
  tags?: string[];
}
interface PinSpec {
  id: string;                 // used in wires. Boards: GPIO ids == McuBackend pin ids ("D13", "A0")
  label: string;
  x: number; y: number;       // px in the visual.svg viewBox
  type: "digital" | "analog" | "power" | "ground" | "passive";   // "ground" pins are tied to node "0"
  voltage?: { min: number; max: number };
  protocols?: string[];       // "pwm", "adc", "i2c-sda", "i2c-scl", "uart-tx", "uart-rx", "spi-mosi", …
  description?: string;
}
interface PropSpec {
  id: string; label: string; type: "number" | "boolean" | "color" | "enum";
  default: number | boolean | string;
  min?; max?; step?; unit?: string;
  options?: (string | { value: string; label: string })[];
  description?: string;
}
interface BindingSpec { key: string; type: "number" | "string" | "boolean"; description: string }
interface McuSpec { backend: string /* "avr8js" */; chip: string /* "atmega328p" */; clockHz: number; vcc: number; fqbn?: string }

interface Fidelity {
  level: "exact" | "behavioral" | "stub";
  areas: Record<"logic" | "timing" | "analog" | "power" | "radio",
                { level: "ok" | "approx" | "none" | "n/a"; note: string }>;
  emulates: string[];
  doesNotEmulate: string[];
  testOnRealDevice: string[];
}
```

### Part model contract (`part.ts`) — what `model.ts` implements

```ts
type VisualValue = number | string | boolean;
type VisualState = Record<string, VisualValue>;
interface PartInteraction { kind: "press" | "release" | "set"; key?: string; value?: VisualValue }
interface Diagnostic { severity: "info" | "warning" | "error"; message: string; code?: string; pin?: string }

interface PartContext {
  readonly id: string;                          // instance id, e.g. "led1"
  readonly spec: PartSpec;
  readonly props: Readonly<Record<string, PropValue>>;   // spec defaults + instance props (kept current)
  node(pinId: string): NodeId;                  // "0" for ground nets; throws for unknown pins
  internalNode(name: string): NodeId;           // "led1#name"
  readonly mcu?: McuBackend;                    // only on the project's firmware board
  requestSolve(): void;                         // synchronous re-stamp + re-solve
  now(): number;                                // virtual ms
}

interface PartModel {
  stamp(c: CircuitBuilder): void;               // called on EVERY solve; stamp from current state
  onSolved?(r: SolveResultView, tMs: number): void;
  visualState(): VisualState;
  setProp(id: string, value: PropValue): void;  // the Simulation re-solves after it
  interact?(event: PartInteraction): void;      // the Simulation re-solves after it
  diagnostics?(): Diagnostic[];
  dispose?(): void;
}
type PartModelFactory = (ctx: PartContext) => PartModel;

interface PartDefinition { spec: PartSpec; fidelity: Fidelity; svg: string; create: PartModelFactory }
interface PartRegistry { get(type: string): PartDefinition | undefined; list(): PartDefinition[] /* sorted by id */ }
createRegistry(defs: Iterable<PartDefinition>): PartRegistry
resolveProps(spec: PartSpec, props?: Record<string, PropValue>): Record<string, PropValue>
```

`model.ts` must export **`create`**: `export const create: PartModelFactory = (ctx) => { … }` (or `export function create(ctx: PartContext): PartModel`).

### McuBackend (`mcu.ts`) — implemented by `@jumper/sim-backends`

```ts
type PinMode = "input" | "input_pullup" | "output" | "analog";
interface PinState { mode: PinMode; value: 0 | 1 }
type Unsubscribe = () => void;

interface McuBackend {
  readonly cyclesPerSecond: number;      // 16_000_000 for the Uno
  readonly cycles: number;               // since last reset()
  readonly vcc: number;                  // 5
  readonly pinIds: readonly string[];    // Uno: "D0".."D13", "A0".."A5"
  load(firmware: Uint8Array | string): void;     // Intel HEX text or raw image; resets the CPU
  step(cycles: number): void;            // may overshoot by one instruction; read `cycles` after
  readPin(pinId: string): PinState;
  setPinInput(pinId: string, volts: number): void;   // thresholds to a level (and feeds the ADC for A0..A5)
  onPinChange(cb: (pinId, state: PinState, cycle: number) => void): Unsubscribe; // sync, inside step(), on mode OR output value change
  onSerial(cb: (byte: number, cycle: number) => void): Unsubscribe;              // sync, default UART TX
  writeSerial?(byte: number): void;      // optional UART RX
  reset(): void;                         // keep program, cycles → 0
}
type BackendFactory = (board: { partId: string; type: string; mcu: McuSpec }) => McuBackend;
```

Rules for backends: `setPinInput` must **not** fire `onPinChange` (only mode/output changes do). Never read wall-clock time. `cycles` must be monotonic and start at 0 after `load()`/`reset()`.

Uno pin map (ATmega328P): `D0–D7` = PORTD0–7, `D8–D13` = PORTB0–5, `A0–A5` = PORTC0–5 (ADC0–5). Serial = USART0.

### Board helper (`board.ts`)

```ts
const GPIO_R_OUT = 25, PULLUP_OHMS = 35_000;
interface McuBoardOptions {
  rails?: Record<string /* pin id */, number /* volts */>;   // e.g. { "5V": 5, "3V3": 3.3 }, 0.05 Ω sources
  gpio?: readonly string[];          // default: spec pins that are in mcu.pinIds
  gpioROut?: number; pullupOhms?: number;
  maxPinCurrentmA?: number;          // default spec.limits.maxCurrentmA ?? 40 → "gpio-overcurrent" error
  visual?: (r: SolveResultView | undefined) => VisualState;   // extra keys (e.g. on-board LED)
}
createMcuBoardModel(ctx: PartContext, opts?: McuBoardOptions): PartModel
```

Per GPIO: output → source `vcc|0` with 25 Ω (element `"gpio:<pin>"`); input_pullup → `vcc` with 35 kΩ (`"pullup:<pin>"`); input/analog → nothing. After every solve, non-output pins get `mcu.setPinInput(pin, netVoltage)`. visualState: `{ powered: true, running: boolean, pin_<id>: 0|1 }` plus `opts.visual(...)`. A board that is not the firmware board stamps only its rails.
The Uno model can be: `export const create: PartModelFactory = (ctx) => createMcuBoardModel(ctx, { rails: { "5V": 5, "3V3": 3.3 }, visual: () => ({ led_l: ctx.mcu?.readPin("D13").value ?? 0 }) })`.

### Simulation (`simulation.ts`)

```ts
interface SimulationOptions {
  project: Project;
  registry: PartRegistry;
  backendFactory?: BackendFactory;      // needed when project.firmware is set
  firmware?: Uint8Array | string;       // HEX text or image for the firmware board
  chunkMs?: number;                     // max MCU step inside runFor, default 1 ms
  frequency?: number;                   // clock Hz when there is no MCU, default 1 MHz
}
type TraceEntry =
  | { cycle: number; kind: "pin"; pin: string; mode: PinMode; value: 0 | 1 }
  | { cycle: number; kind: "serial"; byte: number };
type SimEvent =
  | { type: "solved"; tMs } | { type: "pin"; pin; state; cycle } | { type: "serial"; byte; cycle }
  | { type: "run"; tMs } | { type: "stopped" } | { type: "reset" };
interface SimDiagnostic extends Diagnostic { partId: string }

class Simulation {
  constructor(opts: SimulationOptions)  // builds nets, creates backend, loads firmware, instantiates models, solves once
  readonly project; readonly nets: readonly Net[]; readonly clock: Clock;
  readonly mcu: McuBackend | undefined; readonly boardId: string | undefined;
  get cycles(): number; get timeMs(): number; get stopped(): boolean;
  runFor(ms: number): void              // advances virtual time; re-solves synchronously on every pin change
  stop(): void; resume(): void; reset(): void; dispose(): void;
  solve(): SolveResult; get lastSolve(): SolveResult | undefined;
  nodeOf(partId, pinId): NodeId; pinVoltage(partId, pinId): number; netVoltage(netId): number;
  partIds(): string[]; partState(partId): VisualState | undefined;
  setProp(partId, propId, value): void; interact(partId, event: PartInteraction): void;
  diagnostics(): SimDiagnostic[];       // includes "unknown-part-type" errors (such parts are skipped)
  get trace(): readonly TraceEntry[]; traceHash(): string /* 14 hex chars */; serialText(): string;
  writeSerial(byte: number): void;
  subscribe(listener: (e: SimEvent) => void): Unsubscribe;
}
```

- Nets: every pin of every registered part has a node. Nets containing any `type: "ground"` pin become node `"0"` (all grounds are one node in M0). Unwired pins are single-pin nets.
- Clock frequency = `mcu.cyclesPerSecond`. The trace is identical whatever `chunkMs` or `runFor` slicing you use (tested). Each `runFor` counts from the previous call's target, so an MCU instruction that overshoots one call is absorbed by the next and `timeMs` does not drift under per-frame slicing.
- UI loop: on each animation frame call `sim.runFor(frameMs * speed)` then read `partState(id)` for each part and apply it with `applyVisualState`. Never use wall time inside the sim.

### Other helpers

```ts
parseIntelHex(text: string): Uint8Array        // flat image from 0, gaps 0xFF; types 00/01/02/04
hashString(str: string, seed?: number): string // cyrb53, 14 hex chars
parseBindings(spec: string): Binding[]         // "opacity:brightness,fill:color" → [{attr,key}, …]
applyVisualState(root, state: VisualState): void   // applies to every [data-bind] under root
```

---

## SVG binding convention (`visual.svg`)

- Root `<svg>` with `viewBox="0 0 <size.w> <size.h>"` (match `part.json` size). No external refs, no scripts, no fonts other than the three brand families (use `font-family="IBM Plex Mono"` for pin labels).
- IDs inside an SVG must be prefixed with the part id (`led-glow`) because many copies are inlined into one page; better, avoid ids entirely.
- **Bindings:** any element may carry `data-bind="attr:stateKey[,attr2:key2]"`, where `stateKey` is a key of `visualState()` and documented in `part.json` `bindings`. Examples: `data-bind="opacity:brightness"`, `data-bind="fill:color"`, `data-bind="text:label"`, `data-bind="visible:pressed"`.
  - `text` sets `textContent`; `visible` sets `display="none"` when falsy and removes it when truthy; any other attr → `setAttribute(attr, String(value))`.
  - The renderer inlines the SVG once and calls `applyVisualState(svgRoot, sim.partState(id))` per frame (no React re-render).
- **Pins:** `part.json` `pins[].x/y` are the source of truth for connection points (viewBox px). The SVG may also mark them with `<circle data-pin="<pinId>" cx=… cy=… r=…/>` (the generator checks every `data-pin` exists in part.json); the canvas uses part.json coordinates for handles.
- Rotation is applied by the canvas around the part's center; pins rotate with it.

## Part folders (`packages/parts/src/parts/<id>/`)

`part.json` (PartSpec), `fidelity.json` (Fidelity), `visual.svg`, `model.ts` (exports `create`), `model.test.ts` (Vitest; test the model by stamping it into a `Circuit` with a fake `PartContext`, or via a small `Simulation`). Then `pnpm gen`. `@jumper/parts` exports `partDefinitions: PartDefinition[]` and `registry: PartRegistry`, plus `parts` (id → definition), `listParts`, `getPart`, `searchParts`, and the helpers `LED_COLORS`, `ledBrightness`, `resistorBands`, `formatOhms`, `ldrResistance`. `pnpm --filter @jumper/parts gen:check` fails when `registry.gen.ts` is stale. Board pins carry no `mcuPin` field: a board's pin id *is* the McuBackend pin id. The full rulebook is `docs/part-spec.md`.

Pin id conventions the example project relies on:
- `led`: `A` (anode), `C` (cathode); props `color` (enum/color, default `"red"`); visualState `brightness` 0..1, `color`. Overcurrent diagnostic code `led-overcurrent` above `limits.maxCurrentmA` (20).
- `resistor`: `1`, `2`; prop `resistance` (Ω, default 220; `ohms` is accepted as an alias).
- `arduino-uno`: `D0`–`D13`, `A0`–`A5`, `5V`, `3V3`, `VIN`, `AREF`, `IOREF`, `RESET`, `GND.1`, `GND.2`, `GND.3` (type `ground`); `mcu: { backend: "avr8js", chip: "atmega328p", clockHz: 16000000, vcc: 5, fqbn: "arduino:avr:uno" }`.

## @jumper/sim-backends

```ts
interface AvrBackendOptions { chip?: "atmega328p"; clockHz?: number; vcc?: number; board?: "uno" | "nano" }
createAvrBackend(opts?: AvrBackendOptions): McuBackend
backendFactory: BackendFactory          // "avr8js" + atmega328p → createAvrBackend (uno/nano pin names from the part type); otherwise a readable error
```

The Nano adds `A6`/`A7` as analog-only pins. SPI and TWI are not attached in M0. See `docs/adding-a-board-backend.md`.

Deps available: `avr8js@0.21.1`, `intel-hex@0.2.0` (or use `parseIntelHex` from sim-core).

## examples/blink

`examples/blink/jumper.json` (Uno `uno`, `r1` 220 Ω, `led1`; D13 → r1.1, r1.2 → led1.A, led1.C → uno.GND.1; `firmware: { board: "uno", dir: "firmware", sketch: "blink/blink.ino", artifact: "firmware/blink.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" } }`), `firmware/blink/blink.ino`, `firmware/blink.hex` (golden, committed) and `firmware/build/blink.ino.hex` (the same bytes as arduino-cli writes them; a test asserts they are identical). Write it with `serializeProject`. Rebuild with `scripts/build-firmware.sh` (see `firmware/BUILD.md`).

## Brand

`brand/tokens.css`: CSS custom properties `--ink --panel --panel-2 --line --text --muted --wire --live --warn --data --bg --grid-dot --wire-ink --focus --font-display --font-ui --font-mono --radius-sm --radius --radius-lg --grid-size`. Dark on `:root`; light via `[data-theme="light"]` or OS preference (unless `data-theme="dark"`). `apps/web/src/main.tsx` already imports it and the @fontsource weights (Bricolage 600/800, Plex Sans 400/500/600, Plex Mono 400/500).

## Installed dependencies (do not add more)

- root: typescript 7.0.2, vitest 5.1.0, tsx 4.23.15, @types/node 24.19.2
- project-format: zod 4.6.7 · sim-core: zod 4.6.7, @jumper/project-format
- sim-backends: avr8js 0.21.1, intel-hex 0.2.0, @jumper/sim-core
- parts: @jumper/sim-core, @jumper/project-format, dev @jumper/sim-backends
- web: react/react-dom 19.3.1, @xyflow/react 12.12.1, zustand 5.1.0, @fontsource/{bricolage-grotesque, ibm-plex-sans, ibm-plex-mono} 5.3.0, all @jumper/*; dev: vite 8.3.6, @vitejs/plugin-react 6.2.1, @playwright/test 1.65.0, jsdom 31.0.0, @testing-library/react 16.3.3, @testing-library/dom, @types/react(-dom) 19.3.0
