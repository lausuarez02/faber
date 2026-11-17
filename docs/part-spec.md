# Fabwright part spec

Every part on the canvas is one folder in `packages/parts/src/parts/<id>/`. The folder is the
whole part: its electrical pins, its behaviour in the simulator, how it looks, how honest the
simulation of it is, and the tests that prove it. Nothing about a part lives anywhere else.

```
packages/parts/src/parts/led/
  part.json       what the part is (pins, props, limits, bindings)       → PartSpec
  fidelity.json   what the simulation does and does not model            → Fidelity
  visual.svg      how it looks, with pin anchors and data-bind hooks
  model.ts        how it behaves (exports `create`)                      → PartModelFactory
  model.test.ts   datasheet-style tests on the DC solver
```

`pnpm gen` validates every folder and writes `packages/parts/src/registry.gen.ts` (committed),
which inlines `part.json`, `fidelity.json` and the SVG text and imports each `model.ts`.
`pnpm test` re-runs the same validation plus the model checks (`src/spec.test.ts`) and fails if
the generated registry is stale.

The zod schemas and TypeScript types live in `@fabwright/sim-core` (`PartSpecSchema`,
`FidelitySchema`, `PartModel`, …); see `docs/contracts.md` for the full type listing. This page is
the rulebook on top of them.

## 1. `part.json`

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | kebab-case, equal to the folder name. This is the `type` in `fabwright.json`. Never rename a shipped id. |
| `name` | yes | Human name, may include the common model number: `"Photoresistor (LDR, GL5528)"`. |
| `category` | yes | `board`, `output`, `input`, `passive`, `sensor`, `power`, `display`, `motor`, `communication`, `misc`. |
| `description` | yes | One or two sentences a beginner can act on: what it does and how to wire it. |
| `pins` | yes | See below. |
| `size` | yes | `{ w, h }` in px. Must equal the SVG viewBox. |
| `props` | no | User-editable settings (inspector + `setProp`). |
| `limits` | no | `maxCurrentmA`, `maxVoltage`, `minVoltage`, `maxPowerW`, plus any other numeric limit (`absMaxCurrentmA`, `maxReverseVoltage`, …). Models read their thresholds from here. |
| `footprint` | no | Physical package, e.g. `"THT 5 mm round LED, 0.1 in (2.54 mm) lead pitch"`. |
| `dimensions_mm` | yes (round 5) | `{ w, h, d }` in mm: outer size of the module as sold; `d` is the height off the board. |
| `mass_g` | yes (round 5) | Grams, the module as sold, without wires. |
| `current_ma` | yes (round 5) | `{ typ, max }` supply current the part itself draws (mA). Passive parts `{ typ: 0, max: 0 }`. |
| `price_usd` | yes (round 5) | Typical single-unit price (USD) from a generic distributor. |
| `buy_links` | yes (round 5) | `{ vendor, url }[]`, `https://` only. Generic distributors or the maker's shop; search URLs are fine. |
| `bindings` | no* | Every `visualState()` key the SVG binds to. *Required for each key used in `data-bind`. |
| `mcu` | boards | `{ backend, chip, clockHz, vcc, fqbn? }`. Required when `category` is `board`. `backend` is `"avr8js"` or `"rp2040js"` (`BOARD_BACKENDS` in sim-core). |
| `tags` | no | Search words: aliases, model numbers, use cases (`"ldr"`, `"light sensor"`). |
| `bus` | bus parts | `{ i2c: { addresses, addressProp?, pullUpOhms?, maxHz? } }` or `{ spi: { modes?, maxHz? } }`. The bus pins carry `protocols` (`i2c-sda`, `i2c-scl`, `spi-mosi`, `spi-miso`, `spi-sck`, `spi-cs`) and the model returns an `i2c` / `spi` member. Bus parts also ship an `example.ino` (+ golden `example.hex`, built with `toolchains/arduino/build-part-examples.sh`) that their test runs on a simulated Uno. See `docs/buses.md`. |

### Physical data

Every shipped part carries what a planner needs to size, weigh, power and price a device
(decision 0003, C2). `plan_device` sums these; `src/spec/physical.test.ts` fails when one is
missing.

```json
"dimensions_mm": { "w": 21, "h": 17.5, "d": 3.5 },
"mass_g": 3,
"current_ma": { "typ": 25, "max": 60 },
"price_usd": 5.4,
"buy_links": [{ "vendor": "AliExpress", "url": "https://www.aliexpress.com/w/wholesale-....html" }]
```

- **`dimensions_mm`**: the module as sold, `w × h` on the board plane, `d` the height off the board
  (a pump or a battery: its three outer dimensions). Parts with a size prop (`ws2812-strip`,
  `lipo-battery`) give the default.
- **`mass_g`**: without wires.
- **`current_ma`**: what the part itself draws from its supply. `typ` = normal use (a relay
  energized, a TFT with its backlight on, a servo moving now and then), `max` = worst case (stall,
  every LED white, radio transmitting). Passive parts and power sources: `{ "typ": 0, "max": 0 }`.
  A charger's `max` is what it draws from USB while charging.
- **`price_usd`**: one unit from a generic distributor or the maker's shop, not a bulk price.
- **`buy_links`**: `https://` only; search URLs are fine and age better than product pages.

### Mechanical and sourcing (round 6)

Two optional blocks, always the **last keys** of `part.json` (after `tags`), written by the case
track (decision 0004, R1; [docs/enclosures.md](enclosures.md)). `src/spec/mechanical.test.ts`
requires `mechanical` for every part a shipped example uses whose category is board, display,
input, sensor, power, output or communication, and `sourcing.generic` for every part.

**Part frame** (mm): look down at the part's top face, oriented like its `visual.svg`. Origin = the
top-left corner of the `dimensions_mm` footprint; **+x right (along w), +y down (along h), +z up out
of the top face, z = 0 at the bottom of the body**. A part whose drawing is turned a quarter
(its viewBox aspect is h:w, like the portrait XIAO) still uses `dimensions_mm` for the frame; its
drawing's top edge is the part's -x edge.

```jsonc
"mechanical": {
  "pcb_mm": 1.0,                 // PCB thickness
  "keepout_top_mm": 1.5,         // room above the top face (wires, solder joints)
  "keepout_bottom_mm": 0.5,      // room below (leads, header pins)
  "soft": false,                 // LiPo pouch: a cradle with 10 % swell room, never a boss or screw
  "outline": "rect",             // or "round" (a disc of diameter w centred in the box)
  "outline_parts": [             // or the footprint as a union (overrides outline), e.g. the GC9A01:
    { "shape": "round", "x": 18, "y": 23.2, "d": 35.4 },          //   round PCB (centre, diameter)
    { "shape": "rect", "x": 5.7, "y": 0.6, "w": 24.6, "h": 7.3 }  //   + header tab (top-left, size)
  ],
  "mounting_holes": [{ "x": 2.5, "y": 2.5, "d": 2.2 }],
  "features": [
    { "id": "usb", "kind": "connector", "face": "-x", "x": 0, "y": 8.75, "z": 1.9, "w": 9, "h": 3.2,
      "connector": "usb-c", "plug_clearance_mm": 1.5, "protrude_mm": 1.0 },
    { "id": "active-area", "kind": "screen", "face": "+z", "x": 18, "y": 23.2, "shape": "round", "d": 32.4, "bezel_mm": 1.2 },
    { "id": "lever", "kind": "switch", "face": "+z", "x": 4.3, "y": 1.8, "z": 3.5, "w": 1.5, "h": 1.5, "protrude_mm": 4, "travel_mm": 2 }
  ],
  "source": "datasheet"          // or "typical module", "measured": printed in the drawing notes
},
"sourcing": { "mpn": "102010428", "manufacturer": "Seeed Studio", "package": "module 21 x 17.5 mm", "generic": "Seeed XIAO RP2040 (RP2040, USB-C, castellated pads)" }
```

- **`face`**: `+z` (top), `-z`, `+x`, `-x`, `+y` (the bottom edge in the drawing), `-y`.
- **`kind`**: `screen` (window over the active area; `bezel_mm` = how much the window may overlap
  the frame), `button` (`travel_mm`; the case prints a plunger), `switch` and `knob` (a lever or
  shaft that pokes through a slot / hole), `connector` (opening of `w + 2 × plug_clearance_mm`;
  USB-C plugs need about 1.5), `led` (a light pipe for SMD LEDs, a hole for 5 mm domes),
  `sensor-window` (PIR dome, ultrasonic cans, LDR: an aperture), `grille` (buzzer / mic: sound
  holes), `vent`, `antenna` (keep thick walls and metal away).
- **Position**: `x`, `y` = centre on the face. On a side face one of them is the edge itself (0, w
  or h) and **`z` is required** (height of the centre). On ±z faces `z` defaults to `d` / 0.
- **`protrude_mm`**: how far the feature stands out *beyond the face point*: a USB receptacle past
  the PCB edge, or a lever / shaft / dome. When `dimensions_mm.d` already includes the lever (a
  slide switch is 7.5 mm with its 4 mm lever), give `z` = the body top (3.5) so `z + protrude_mm = d`.
  Levers, shafts and domes (`switch`, `knob`, `sensor-window`, `led` with `protrude_mm`) go through
  the wall; buttons stay inside and get a plunger.
- **Size**: `shape: "rect"` (default) uses `w` (along x on ±z / ±y faces, along y on ±x faces) and
  `h` (y on ±z faces, z on side faces); `"round"` uses `d`.
- **`expose`**: default true for screen, button, switch, knob, connector, led, sensor-window,
  grille. Set `false` for things nobody reaches in the finished device (a board's reset button,
  its status LED).
- **`sourcing`**: `mpn` / `manufacturer` only when certain, `generic` always (what a supplier can
  quote from). **LCSC / JLC numbers only after checking them on lcsc.com / jlcpcb.com**; the spec
  test keeps a list of checked numbers, so a guessed one fails.
- Agent-made parts (`create_part`) accept the same two blocks.

### Pins

```json
{ "id": "A", "label": "Anode (+)", "x": 10, "y": 76, "type": "passive", "description": "…" }
```

- **`id`** is what wires reference (`{ "part": "led1", "pin": "A" }`). Use short, stable ASCII
  ids without spaces: `A`/`C`, `1`/`2`, `POS`/`NEG`, `GND.1`. Several pins with the same function
  get a dot suffix (`GND.1`, `GND.2`).
- **Board GPIO ids are the McuBackend pin ids**, which are also the names in Arduino code:
  `D0`–`D13`, `A0`–`A5`. There is no separate mapping table; `pin.id === mcuPin`. Power pins use
  the silkscreen names `5V`, `3V3`, `VIN`, `IOREF`, `AREF`, `RESET`.
- **`x`, `y`** are px inside the viewBox and are the source of truth for wire anchors. Put them
  at the end of the lead or the centre of the header hole, inside the viewBox.
- **`type`**: `digital`, `analog`, `power`, `ground`, `passive`. All `ground` pins become circuit
  node `"0"` (in M0 every ground is one node).
- `voltage`, `protocols` (`pwm`, `adc`, `uart-tx`, `i2c-sda`, `spi-sck`, `int0`, …) and
  `description` are optional but expected on boards.

### Scale

The canvas is 1:1 with a breadboard: **20 px = 0.1 in (2.54 mm)**, the `--grid-size` token. A
5 mm LED's legs are 20 px apart, an Uno is 540 × 420 px, a Nano's pin rows are 120 px apart. Keep
real pin pitch so parts line up on the dot grid and on a future breadboard.

### Props

```json
{ "id": "resistance", "label": "Resistance", "type": "number", "default": 220, "min": 0.1, "max": 100000000, "unit": "Ω" }
```

`type` is `number`, `boolean`, `color`, `enum` (`options` required; `default` must be one of
them) or `text` (round 7: free text over several lines, stored as a string, edited in a text box
saved on blur; e.g. the DFPlayer's `clips`, one "N: words" line per track). Number defaults must sit inside `min`/`max`. The spec test sets every prop to its min,
default and max (every option for enums) and requires the solve to converge.

## 2. `fidelity.json`

The honesty report. It feeds the per-project "real-world confidence" panel, so write it for a
user deciding whether to trust the sim.

```json
{
  "level": "behavioral",
  "areas": {
    "logic":  { "level": "ok",     "note": "…" },
    "timing": { "level": "approx", "note": "…" },
    "analog": { "level": "approx", "note": "…" },
    "power":  { "level": "approx", "note": "…" },
    "radio":  { "level": "n/a",    "note": "…" }
  },
  "emulates": ["…"],
  "doesNotEmulate": ["…"],
  "testOnRealDevice": ["…"]
}
```

- `level`: `exact` (matches the datasheet within its tolerance for everything users can observe;
  rare), `behavioral` (right behaviour, simplified physics; most parts), `stub` (placeholder).
- Each area is `ok`, `approx`, `none` or `n/a`, and every area that is not `n/a` needs a
  non-empty `note` saying concretely what is simplified ("piecewise-linear diode, no thermal
  drift"), not marketing.
- `testOnRealDevice` lists what a user must still check on hardware. Be specific.

## 3. `visual.svg`

- Root `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 <w> <h>">` matching `size`.
- **Original artwork only.** Never trace or copy another simulator's or vendor's graphics.
- Brand look: dark-first. Bodies in dark tones (`#15181D`, `#1C2027`, `#2B313B`, PCB `#0F1E22`),
  hairline strokes (`#3A4250`), leads `#9AA3AF`, pin anchors `#C9CED6`, silkscreen text
  `#E9EDF2` (secondary `#8A93A0`). Glows use `--live` `#5CF2A1`, `--warn` `#FFB23F` or the
  physical colour of the light.
- Text: `font-family="IBM Plex Mono"` for pin labels and values; `Bricolage Grotesque` for a
  board name; `IBM Plex Sans` otherwise. No other fonts.
- Not allowed: `<script>`, `<style>`, `<image>`, `<foreignObject>`, `on*` attributes, external
  `href`/`url()`. Gradients/filters are fine via `url(#…)`.
- **ids** must start with `<part-id>-` (`led-halo`), because many copies are inlined into one
  page. Prefer no ids at all.
- **Pin anchors:** one `<circle data-pin="<pinId>" cx="<x>" cy="<y>" r="3"/>` per pin, at exactly
  the `part.json` coordinates (±0.5 px). Every pin needs one; the generator checks both ways.

### Bindings (`data-bind`)

The renderer inlines the SVG once and, every frame, applies the model's `visualState()` to every
element with `data-bind="attr:key[,attr2:key2]"` (`applyVisualState` in sim-core):

| Form | Effect | Example |
| --- | --- | --- |
| `text:key` | sets `textContent` | `<text data-bind="text:label">` |
| `visible:key` | `display="none"` when falsy, removed when truthy | `data-bind="visible:sounding"` |
| `<attr>:key` | `setAttribute(attr, String(value))` | `opacity:brightness`, `fill:color` |

Every `key` must be listed in `part.json` `bindings` and returned by `visualState()`, with the
documented type. Write the unlit/default look into the static attributes (e.g. `opacity="0"`)
so the SVG is correct before the first frame.

**Motion is a transform string computed by the model.** There is no expression language in
bindings; the model returns a ready SVG transform and the SVG binds `transform` to it:

| Pattern | Model returns | SVG |
| --- | --- | --- |
| Rotation (pot knob) | `knobAngle: -135..135` and `knobTransform: "rotate(<angle> 40 38)"` | `<g transform="rotate(0 40 38)" data-bind="transform:knobTransform">` |
| Press offset (button) | `capTransform: "translate(0 1.5)"` / `"translate(0 0)"` | `<g data-bind="transform:capTransform">` |
| Slide (switch) | `knobTransform: "translate(16 0)"` / `"translate(0 0)"` | `<g data-bind="transform:knobTransform">` |
| LED glow | `brightness: 0..1`, `color: "#FF3B2F"` | a lens overlay and a blurred halo, both `data-bind="fill:color,opacity:brightness"` |
| Sound | `sounding: boolean`, `volume: 0..1` | `<g display="none" data-bind="visible:sounding,opacity:volume">` arcs |

Keep the numeric key (`knobAngle`) as well, so tests, instruments and agents can read it.
Round values in `visualState()` (the `round()` helper, 3 decimals) so solver noise does not
rewrite the DOM every frame.

## 4. `model.ts`

```ts
import type { PartModel, PartModelFactory } from "@fabwright/sim-core";

export const create: PartModelFactory = (ctx): PartModel => ({
  stamp(c) { /* add elements between ctx.node(pin) nodes, every solve */ },
  onSolved(r) { /* read r.voltage / r.current of what you stamped */ },
  visualState() { return { /* keys from part.json bindings */ }; },
  setProp(id, value) { /* update state; the sim re-solves */ },
  interact(e) { /* press / release / set; the sim re-solves */ },
  diagnostics() { return []; },
});
```

Rules:

- **Deterministic.** No `Date`, `Math.random`, `performance.now`, timers or I/O. Time comes from
  `ctx.now()` (virtual ms) or the `tMs` passed to `onSolved`.
- **Stamp from current state, every time.** `stamp()` runs on every solve; do not cache elements
  across solves. Keep the element id *returned* by the builder from the latest `stamp()` and pass
  that to `r.current()` (ids are scoped by the simulation to `"<instance>/<your id>"`).
- **Use only your own pins** (`ctx.node(pinId)`) and `ctx.internalNode(name)` for nodes inside
  the part (e.g. the buzzer's diode-to-coil node). The spec test checks this.
- **Electrical building blocks** (`CircuitBuilder`): `resistor`, `voltageSource` (Norton, with
  `rOut`), `currentSource`, `diode`/`led` (piecewise linear: knee `vf` + `rOn`), `switch`
  (closed 0.01 Ω, open = not stamped). Model the part with these; anything nonlinear becomes a
  table or a piecewise curve computed in TypeScript (see `photoresistor`).
- **Props**: read initial values from `ctx.props` (defaults already merged); update in `setProp`.
  Accept loose inputs (numbers as strings, booleans as 0/1) via `num()`, `str()`, `truthy()` in
  `src/lib/props.ts`.
- **Interactions**: `press`/`release` for momentary controls, `press` toggles latching ones,
  `set` with `value` for continuous ones (pot position 0..1, LDR lux). Clamp out-of-range values.
- **Boards**: use `createMcuBoardModel(ctx, { rails, visual })` from sim-core. `ctx.mcu` is only
  set on the project's firmware board; others stamp only their rails.

### Diagnostics

Return `{ severity, code, message, pin? }`. Codes are stable kebab-case
(`led-overcurrent`, `resistor-overpower`, `buzzer-reversed`, `gpio-overcurrent`). Every message
says **what is wrong, why, and how to fix it**, with numbers:

> LED will burn out, add a resistor: 100 mA flows through it (absolute max 30 mA). Put about
> 220 Ω in series at 5 V or 100 Ω at 3.3 V.

Use `warning` for "works but out of spec", `error` for "this would damage real hardware",
`info` for "silently does nothing" (e.g. a buzzer below its start voltage).

## 5. `model.test.ts`

Prove the model against its datasheet with the real solver. Use the bench in `src/lib/bench.ts`:

```ts
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";

const def = need(registry.get("led"), "led");
const led = mount(def, { props: { color: "red" }, wiring: { A: "a", C: GROUND } });
led.solve((c) => { c.voltageSource("vcc", GROUND, 5, 0.01); c.resistor("vcc", "a", 220); });
expect(led.model.visualState().currentmA).toBeCloseTo(13.3, 0);
```

- `mount(def, { id, props, wiring, mcu })` creates the model with a fake `PartContext`. Unlisted
  pins get private nodes; ground pins default to `"0"`.
- `bench.solve(extra)` stamps the part plus `extra` (kept for later solves) and solves;
  `bench.setProp` / `bench.interact` change state and re-solve, like the Simulation does.
- `ScriptedMcu` is a fake `McuBackend` for board tests (`mcu.drive("D13", "output", 1)`).
- Test at least: the headline datasheet number, the edges (off, saturation, reversed), every
  diagnostic, and every prop/interaction path.

## 6. What the validator checks

`src/spec/validate.ts` (run by `pnpm gen` and by `src/spec.test.ts` for every folder):

- all five files exist; folder name is kebab-case and equals `part.json` `id`;
- `part.json` and `fidelity.json` parse against the zod schemas; non-`n/a` fidelity notes are
  non-empty;
- pin ids are unique; each pin's `x`/`y` lies inside the viewBox; boards have `mcu`;
- enum props have options containing the default; number defaults are within min/max;
- the SVG is well-formed (`src/spec/svg.ts`), has `<svg>` root with `viewBox` = `0 0 w h`, uses
  no forbidden elements/attributes/external refs, prefixes ids with the part id, uses only brand
  fonts;
- every pin has exactly placed `data-pin` anchors and every `data-pin` is a real pin;
- every `data-bind` key is documented in `bindings`.

`src/spec.test.ts` additionally instantiates each model and checks that every bound and
documented key is produced by `visualState()` with the documented type, that the model survives
every prop value and interaction with a converged solve and finite numbers, that it only touches
its own pins, and that `registry.gen.ts` matches what the generator would write.

## 7. Package API (`@fabwright/parts`)

```ts
partDefinitions: PartDefinition[]                 // generated, sorted by id
registry: PartRegistry                            // { get(type), list() }
parts: Record<string, PartDefinition>             // id → { spec, fidelity, svg, create }
listParts(category?): PartDefinition[]
getPart(id): PartDefinition | undefined
searchParts(query): PartDefinition[]              // id / name / tags / category / description, ranked
LED_COLORS, ledBrightness, resistorBands, formatOhms, ldrResistance   // model helpers
```

## 8. M0 parts

| id | Pins | Props | visualState keys |
| --- | --- | --- | --- |
| `arduino-uno` | `D0`–`D13`, `A0`–`A5`, `5V`, `3V3`, `VIN`, `IOREF`, `AREF`, `RESET`, `GND.1`–`GND.3` | – | `powered`, `running`, `led_l`, `pin_<id>` |
| `arduino-nano` | `D0`–`D13`, `A0`–`A7`, `5V`, `3V3`, `VIN`, `AREF`, `RESET.1`, `RESET.2`, `GND.1`, `GND.2` | – | same as Uno |
| `led` | `A`, `C` | `color`: red / yellow / green / blue / white | `brightness`, `color`, `lens`, `on`, `currentmA` |
| `rgb-led` | `R`, `COM`, `G`, `B` (common cathode) | – | `r`, `g`, `b`, `brightness`, `color`, `on` |
| `resistor` | `1`, `2` | `resistance` Ω (alias `ohms`) | `resistance`, `label`, `band1`–`band3`, `currentmA`, `powerW` |
| `pushbutton` | `1a`, `1b`, `2a`, `2b` (1a–1b and 2a–2b tied) | – (interact press/release/set) | `pressed`, `capTransform` |
| `slide-switch` | `1`, `2` (COM), `3` | `position` 0/1 (interact press toggles) | `position`, `knobTransform` |
| `potentiometer` | `1`, `W`, `2` | `position` 0..1, `resistance` (10 kΩ) | `position`, `knobAngle`, `knobTransform` |
| `photoresistor` | `1`, `2` | `lux` (GL5528 curve) | `lux`, `resistance`, `light` |
| `buzzer` | `POS`, `NEG` | – | `sounding`, `volume`, `volts`, `currentmA` |

## 9. Round 5 parts

| id | What it adds | Checked with |
| --- | --- | --- |
| `gc9a01-round-tft` | 240×240 round colour TFT; MIPI panel options `viewer: "native"`, `invertGlass`, `roundGlass`, `rotationTable` (`src/lib/mipiPanel.ts`) | Adafruit_GFX example on a simulated Uno |
| `lipo-battery` | 1S cell: OCV vs state of charge, sag, coulomb counting (`speedup` prop for tests, shown in the label), protection cut-off | bench + a charging run with the TP4056 |
| `tp4056-charger` | trickle / CC / CV / full, R_PROG current, USB plug (press), OUT protection | bench + charging run |
| `passive-buzzer` | frequency from the measured pin period, note names, melody history | `tone()` melody on firmware |
| `vibration-motor` | module with its own NPN; the dc-motor model inside (`src/lib/innerMotor.ts`) | bench (timed) |
| `ttp223-touch` | push-pull touch output, A/B jumpers | bench |
| `capacitive-soil-moisture` | AOUT falls with moisture, 3.3 / 5 V | bench + the plant waterer |
| `relay-module` | active low / high input, pull-in voltage, 10 / 5 ms operate / release, COM-NO-NC | bench + the plant waterer |
| `water-pump` | DC pump (dc-motor model inside), flow and `pumpedMl` | plant waterer example on firmware |
| `ir-proximity` | active-low obstacle output, threshold knob, surface reflectivity, robot physics (`mount`) | bench + `packages/physics` |
| `bump-switch` | lever micro switch, robot physics presses it (`mount`) | bench + `packages/physics` |
| `dht22` | AM2302 single-bus protocol bit for bit, previous-measurement answer, 2 s / 1 s rules | library-free reader on firmware |
| `pir-motion` | repeat / single trigger, hold and 2.5 s block time, warm-up | bench (timed) |
| `ws2812-strip` | WS2812B bits decoded from pin edges, up to 16 LEDs, current, timing warnings | bit-banged example on firmware |

The active `buzzer` now reports `buzzer-tone` when it is driven with `tone()`.

Reference numbers proven by the tests: red LED + 220 Ω at 5 V → 13.3 mA at Vf ≈ 2.07 V;
blue LED Vf ≈ 3.0 V; pot at 0.5 → 2.50 V; GL5528 15 kΩ at 10 lx, ~950 Ω at 1000 lx, 1 MΩ dark;
active buzzer ≈ 23 mA on a 5 V GPIO; Uno D13 → 220 Ω → red LED ≈ 12 mA.

## 10. Round 7 parts (voice)

| id | What it adds | Checked with |
| --- | --- | --- |
| `dfplayer-mini` | DFPlayer Mini MP3 module: the serial frames (play 0x03 / 0x0F / 0x12, volume, pause, stop, reset, queries; replies 0x3F, 0x41, 0x3D; checksum and the 8-byte form), BUSY low while playing, start-up delay. Clips are text (`clips` prop); a play logs an `Utterance` (`PartModel.speech()`, `Simulation.speech()`) with its estimated length (2.6 words/s + 0.3 s) and whether a speaker draws current (`audible`). SPK_1-SPK_2 is a bridged RMS source, DAC_L / DAC_R line out | `src/lib/dfplayer.test.ts`, its `model.test.ts` (scripted UART), `src/dfplayer.integration.test.ts` (real firmware on the Nano's Serial and the XIAO's Serial1) |
| `speaker` | 4 / 8 Ω coil as a resistor; sounding, volume against its rating, overpower; a round `grille` feature so the case cuts sound holes | bench |

A UART part hears a board's hardware serial port too: the AVR backend puts its USART on D1 / D0
once a part watches D1 (`McuBackend.pinWatched`); RP2040 boards already put Serial1 / Serial2 on
their pins.

## 11. Round 8 parts (smaller devices)

| id | What it adds | Checked with |
| --- | --- | --- |
| `speaker-20mm` | 20 x 20 x 4 mm, 8 Ω, 0.5 W, Ø13 grille: the smallest speaker plan_device picks for speech (the 28 mm `speaker`'s coil model, its own size and rating) | its `model.test.ts`, `packages/session/test/parts-advice.test.ts` |
| `speaker-15mm` | 15 x 15 x 3.5 mm, 8 Ω, 0.25 W, Ø10 grille: quieter, for the tightest cases | its `model.test.ts` |
| `charge-boost-5v` | IP5306-class LiPo charger + 5 V boost on one 25 x 21 x 4.5 mm board (instead of TP4056 + MT3608, 1102 → 525 mm²): CC / CV charge at about 2 A, 5 V at 90 %, 3.0 V cut-off, 32 s light-load auto-off under 45 mA, KEY (press) and USB wake it | its `model.test.ts`, `packages/session/test/parts-advice.test.ts` |

Speakers are separate parts, not a size prop, because the case packs a part by its `dimensions_mm`
(only a LiPo's `capacity` changes its packed size). Smaller LiPo cells need no new part: `capacity`
100 / 150 / 250 mAh packs a 401730 / 402030 / 502030 pouch.
