# 0004 — Round 6: fix what round 5 left broken, and make the device physically real

Status: accepted · 2026-11-10

The owner asked for two things: fix what is still broken after round 5 (evidence: the real Claude
build of a pocket "Muse" in `jumper-evals/round5/muse/` and the first-timer walk-through in
`jumper-evals/round5/ui/`), and finish a project with **everything needed to make it**: the
electronics, the firmware and a **case** in different shapes with every size, ready for a 3D
printer, plus the files a factory in China asks for.

Five tracks run in parallel worktrees: **switch**, **canvas**, **power**, **frames**, **case**.
This note records each track's choice and the shared contracts (R1 to R10) their merges must fit.
A track that needs to change a contract changes the code and this file in the same commit and says
so in its report. Round 5's contracts (0003, C1 to C10) still hold unless a contract here replaces
one.

Done in this commit (so the tracks do not edit the same lines): the optional `mechanical` and
`sourcing` blocks in `PartSpecSchema` (R1), the optional `assembly`, `power` and `enclosure` fields
in `ProjectSchema` (R2, R3), the `@fabwright/enclosure` package with its shared types and its
dependencies installed (R4), the `case` live event (R6), `Frame.color` / `VersionFrame.color` and
the history route passing it through (R7), `apps/web/src/lib/projectSwitch.ts` (R8), NOTICE lines
for the CAD libraries.

## Choices per track

### switch: opening a project resets everything that belonged to the old one

The first-timer report: after switching, the floating code panel kept the old project's files, the
firmware was refused as "built for another board" (and the fix said to change the board), old
toasts stayed, the inspector showed a part that no longer exists, and the sim kept running. Each
store fixed separately leaks again next round, so there is **one switch event** (R8): the switch
track emits it after the new project loaded, every track registers its own reset. Opening an
example writes **version 1 = the untouched original** (restorable). History counts file changes
after a restore, shows "built <hash>" only on versions that built, and lists `+N / -M` lines per
file. The person's own edits (actor `web`) are never pending agent steps; Agent steps lists `mcp`
steps only. Someone new lands on the **Projects page** when the active project is a fresh
playground or nothing was ever opened. Gallery: Tamagotchi thumbnail, "1 test".

### canvas: a click presses, a drag moves only when you mean it

| Option | For | Against |
| --- | --- | --- |
| **Press on pointerdown, release on pointerup, at least 120 ms visible; move only with the select tool, a drag handle, or a drag past a threshold that starts off the cap (chosen)** | A click works like a finger; keyboard shortcuts stay | Two gestures on one part need clear hit areas |
| Modifier key to press | Simple | Nobody finds it (the report) |
| Lock parts while running | Simple | Cannot rearrange while watching |

Live controls (tilt pad, Shake / Drop / Spin) are **docked** in their own slot so Serial, Agent
steps and the Inspector never cover them, collapsible; Shake is **hold-to-shake** plus a duration;
every motion runs on **sim virtual time** (no wall clock: determinism rule). Dragging the IMU
while running tilts it unless the select tool is active. Serial follows the newest line unless the
person scrolled up. Canvas labels show the short id; the full name is in the hover and the
Inspector. Zoom / pan survive save, build and run. Inspector wiring text comes from the hints with
the board's own bus pins (XIAO GP6 / GP7, not A4 / A5). The pet's speech bubble stays readable
at least 4 s or until the next reply.

### power: the battery really powers the board

The Muse "runs on a LiPo" but the board was powered by an implicit USB supply, the TP4056 advice
said to wire its IN to the board's 5 V, and check_design flagged battery ↔ charger BAT as
"parallel regulators".

| Option | For | Against |
| --- | --- | --- |
| **Board supply pins are real circuit nodes; the board is "powered" when its supply node is above the regulator's minimum; USB is a source the project turns on or off (`power.usb`, R2) (chosen)** | The battery path (cell → TP4056 → switch → schottky → XIAO 5V) is solved by the existing MNA with its piecewise-linear diodes; battery current follows the load; DRC and the sim agree | Board models need a supply model (LDO with dropout) |
| Keep boards always powered, add a "battery" badge | Nothing to model | Fakes fidelity: the report shows exactly this lie |
| A separate power-budget calculator | Simple | Two truths again |

New parts (R2), full spec (pins, physical data, `mechanical`, `sourcing` where verified, fidelity,
model, tests). Export style per project (`assembly`, R2): a soldered / handheld project exports
wire cuts and a soldered assembly, never breadboards or dupont wires. The Muse example is copied
to `examples/agent-built/claude-pocket-muse`, re-wired with the battery truly powering it, tests
green. Planning calls (`plan_device`, `search_parts`, `get_part`) are logged into the project they
end up creating, not the previously open one. `search_parts` with no fit says so and hands a
ready `create_part` template; `get_part` matches ids fuzzily ("rp2040-zero" →
`waveshare-rp2040-zero`).

### frames: colour screens everywhere, the libraries agents reach for

Colour TFT and round frames reach every picture that is not the live canvas: `record` videos,
history previews, gallery thumbnails, Tests filmstrips (the Muse replay shows a black GC9A01).
The sim host already has the pixels (`ColorFrame`, `colorFrameToPng`); they travel as PNGs in
`Frame.color` (R7).

Libraries: a new pinned library set **libs3** for AVR and RP2040 (R7): Adafruit GFX, ST7735 /
ST7789, ILI9341, GC9A01A (BSD / MIT), SSD1306, MPU6050 + Unified Sensor, DHT sensor library,
FastLED (MIT), TFT_eSPI (licence checked file by file; FreeBSD for the core, its bundled fonts and
extensions have their own notes), **Adafruit NeoPixel (LGPL-3.0)**: it is compiled into the
person's own firmware inside the build image, never shipped in Fabwright's repo or packages; NOTICE
says so, and the export's firmware README tells the person that a firmware binary they distribute
that links NeoPixel carries LGPL-3.0 obligations (relinkable objects or source). Every existing
golden hex must build byte-identical with libs3. The RP2040 image builds on any machine from the
committed Dockerfile through `ensureImage` (like AVR), and CI builds it.

### case: enclosures and the factory pack

**CAD engine.** Factories quote from STEP; printers take STL / 3MF.

| Option | Licence | Geometry | STEP | Runs | Verdict |
| --- | --- | --- | --- | --- | --- |
| **replicad 1.1.0 + replicad-opencascadejs 1.1.0 (chosen)** | MIT wrapper + LGPL-2.1 OCCT wasm (48 MB unpacked, loaded as a separate unmodified file) | Real B-rep: sketches, extrude, loft, fillet, shell, booleans | **Yes, real B-rep STEP** (OCCT STEPControl_Writer); STL; 3MF we write (zip + XML, fflate) | Node 24 and browsers | Measured here: wasm init 0.2 s; a 46 × 38 × 17 mm rounded box with a 2 mm fillet, a 1.6 mm shell and a 30 mm window cut, STEP 112 KB + STL, 0.5 s in all |
| opencascade.js 1.1.1 | LGPL-2.1 | Full OCCT | Yes (+ IGES) | Node, browsers | Last release 2023-03, 67 MB, no maintained API on top |
| @jscad/modeling 2.13.0 | MIT | Mesh CSG; no true fillets / shells | **No** (STL, 3MF, OBJ) | Node, browsers | Would need a second engine for STEP |
| manifold-3d 3.5.4 | Apache-2.0 | Robust mesh booleans, guaranteed manifold | **No** | Node, browsers | Great validator, not a CAD kernel |
| CadQuery / build123d in Docker | Apache-2.0 + OCCT LGPL | B-rep (Python) | Yes | Docker only, ~1 GB image | Agent loop waits on a container; no browser |
| OpenSCAD in Docker | GPL-2.0 (external tool) | Mesh CSG | **No** | Docker only | No STEP, no fillets |

Choice: **replicad on OCCT wasm**, run on the server side (Node) inside `@fabwright/enclosure`,
imported lazily (`await import(...)`) so nothing else loads 10 MB of wasm. The web Case view gets
meshes from the server (R6), so the browser bundle never contains OCCT. LGPL-2.1 compliance: the
wasm is the unmodified npm file loaded at run time and replaceable, disclosed in NOTICE with the
source links. **IGES**: offered only if the replicad-opencascadejs build exposes the IGES writer
(the case track checks); otherwise the pack says "STEP AP214 (factories accept it; ask for IGES
and we convert)". Renders: our own projection rasteriser into RGBA → `encodePng` (already in
sim-core): deterministic, no Chromium. Drawing: SVG always; PDF through Playwright when its
Chromium is installed, otherwise the pack says the PDF is missing and why.

**Layout.** Auto-pack: screen (the `front` part) right behind the front wall with its active area
centred in the window, board and battery stacked behind it, buttons on the face the person picks
(R3 placements, default: the side nearest the board's GPIO), USB opening lined up with the
board's port, a `gap_mm` wiring clearance around every part, the inner volume reported.

**Shapes**: rounded-box, pill (capsule), pebble (organic rounded ellipsoid), puck (round),
keychain (tab with a lanyard hole). Two-part shell (front / back) with snap-fit lips or M2 bosses
for heat-set inserts, standoffs for the board, a battery cradle (never a boss on a LiPo), button
caps with plungers, screen window, USB-C cutout, light-pipe holes. Print-friendly: each shell
prints open side up without supports where possible, walls ≥ 1.2 mm, 0.2 mm FDM clearance, notes
for resin and injection (draft angles, uniform walls, ABS / PC).

**Validation** (tests): every STL is a closed 2-manifold (each edge shared by exactly two
triangles with opposite winding), signed volume > 0; no part body intersects the shell (OCCT
common volume < 0.001 mm³); generated bounding boxes within 0.1 mm of the layout.

**Reference**: the Muse (round GC9A01 face, XIAO RP2040, LiPo, MPU6050, buzzer, button) in
**pebble** and **puck**, committed under `examples/agent-built/claude-pocket-muse/case/`.

---

## Shared contracts

### R1. part.json `mechanical` and `sourcing` (in `PartSpecSchema`, done in this commit)

Units: **mm**. **Part frame**: looking down at the part's top (component / front) face, oriented
exactly like its `visual.svg`. Origin = top-left corner of the `dimensions_mm` footprint; **+x right
(along w), +y DOWN (along h, like SVG), +z up out of the top face, z = 0 at the bottom of the
body**; `dimensions_mm.d` is the full height with components. A pin drawn at visual.svg (px, py)
is at (px / size.w × w, py / size.h × h).

```jsonc
"mechanical": {
  "outline": "rect",                 // "rect" (default) | "round" (disc of diameter w, centred in the box)
  "pcb_mm": 1.0,                     // board / module PCB thickness
  "keepout_top_mm": 1.5,             // room above the top face (wires, solder joints); default 0
  "keepout_bottom_mm": 1.0,          // room below (header pins, leads); default 0
  "soft": false,                     // LiPo pouch: cradle with ~10 % swell room, never a boss / screw
  "mounting_holes": [{ "x": 2.5, "y": 2.5, "d": 2.2 }],
  "features": [
    { "id": "usb", "kind": "connector", "face": "-y", "x": 10.5, "y": 0, "z": 2.6,
      "w": 9.0, "h": 3.3, "connector": "usb-c", "plug_clearance_mm": 1.5, "protrude_mm": 0.6 },
    { "id": "active-area", "kind": "screen", "face": "+z", "x": 18, "y": 18,
      "shape": "round", "d": 32.4, "bezel_mm": 1.2 },
    { "id": "cap", "kind": "button", "face": "+z", "x": 3, "y": 3, "shape": "round",
      "d": 3.5, "protrude_mm": 1.5, "travel_mm": 0.25 }
  ],
  "source": "datasheet"              // "datasheet" | "measured" | "typical module"
},
"sourcing": {
  "mpn": "1N5817", "manufacturer": "…",   // module or key chip
  "lcsc": "C…", "jlc": "basic",           // ONLY numbers checked on lcsc.com / jlcpcb.com; unknown = omitted, never guessed
  "package": "DO-41",
  "generic": "Schottky diode 1 A 20 V, DO-41"   // what a supplier can quote from without an MPN
}
```

Field rules (exact names, zod in `packages/sim-core/src/part.ts`: `MechanicalSchema`,
`MechFeatureSchema`, `SourcingSchema`, `MECH_FACES`, `MECH_FEATURE_KINDS`):
- `face` ∈ `"+z" | "-z" | "+x" | "-x" | "+y" | "-y"` (part-frame axes; `+z` = top face).
- `kind` ∈ `screen | button | switch | knob | connector | led | sensor-window | grille | vent | antenna`.
- `x, y` = centre on the face. Side faces: the point on that edge (x for ±y faces, y for ±x faces;
  the other coordinate is the edge: 0, w or h) and **`z` (required on side faces)** = centre height
  above the body bottom. ±z faces: z defaults to d / 0.
- Size: `shape` `"rect"` (default) uses `w` (along the face's horizontal axis: x on ±z / ±y, y on
  ±x) and `h` (y on ±z, z on side faces); `"round"` uses `d`.
- `expose` default: true for screen, button, switch, knob, connector, led, sensor-window, grille.
- **Key order: `mechanical` then `sourcing` are the LAST keys of part.json** (after `tags`). Only
  the case track writes them in existing parts; the power track writes them in its new parts.
- Custom parts (`create_part`): the case track adds `mechanical` and `sourcing` to
  `CustomPartSchema` (one line each in `packages/parts/src/custom/schema.ts`), then `pnpm gen`.
- Required: a case-track spec test requires `mechanical` for every part used by a shipped example
  (`examples/**/fabwright.json`) whose category is board, display, input, sensor, power, output or
  communication; `sourcing.generic` for every shipped part.

### R2. Power: parts, pins, project fields, DRC codes (power track)

New part ids (folders under `packages/parts/src/parts/`), category `power` unless noted:

| id | Real part | Pins | Props |
| --- | --- | --- | --- |
| `schottky-diode` | 1N5817 (1 A, 20 V, Vf ≈ 0.32 V at 0.1 A) | `A` anode, `C` cathode (same ids as `led`) | |
| `generic-diode` | 1N4148 (Vf ≈ 0.7 V), category `passive` | `A`, `C` | |
| `n-mosfet` | AO3400 logic-level N-MOSFET, category `passive` | `G`, `D`, `S` | |
| `npn-transistor` | 2N2222 / BC547, category `passive` | `B`, `C`, `E` | `model: "2N2222" \| "BC547"` |
| `pnp-transistor` | 2N2907 / BC557, category `passive` | `B`, `C`, `E` | `model` |
| `ldo-regulator` | MCP1700-3.3 / AP2112K-3.3 | `VIN`, `GND`, `VOUT` (+ `EN`, tied high when unconnected, for AP2112) | `variant: "MCP1700-3.3" \| "AP2112K-3.3"` |
| `boost-converter` | MT3608 module | `VIN+`, `VIN-`, `VOUT+`, `VOUT-` | `vout` (V, default 5.0) |

`slide-switch` exists (pins `1`, `2`, `3`) and is the power switch. Every new part ships with
dimensions, mass, current, price, buy links, `mechanical` (body + any exposed feature), `sourcing`
(verified numbers only), fidelity, model and tests.

Boards: **existing pin ids never change** (projects use them). XIAO RP2040: `VBUS` (the "5V" pad:
USB 5 V in, or an external 3.5 to 5.5 V input), `3V3` (regulator out), `GND.1`; no BAT pin.
Pico: `VBUS`, `VSYS` (1.8 to 5.5 V in, VBUS reaches it through the on-board schottky), `3V3`,
`3V3_EN` (new pin), `GND.*`. RP2040-Zero: `VBUS` ("5V"), `3V3`, `GND.1`. Limits go in the
existing `limits` catch-all (e.g. `max3v3mA`, `minSupplyV`), no new top-level keys in existing
part.json files (R1 owns the end of the file).

Project fields (in `ProjectSchema`, done in this commit):
- `power?: { usb?: boolean }`: a USB cable is plugged into the board. Absent = `true` (round-5
  behaviour). `false` = the board runs only from what is wired to its supply pins.
- `assembly?: "breadboard" | "soldered"`: absent = `"soldered"` when the project has an
  `enclosure` or its board is a pocket board (XIAO, RP2040-Zero), otherwise `"breadboard"`
  (`assemblyStyle(project, registry)` in `packages/session/src/assembly.ts` resolves it).

New tools (`packages/session/src/tools/power.ts`):

| Tool | Params | Returns |
| --- | --- | --- |
| `set_power` | `{ usb: boolean, why? }` | `{ usb, board_powered: boolean, supply: { net, volts, from: string[] }, battery?: { part, volts, ma, hours_left } }` (edits) |
| `set_assembly` | `{ style: "breadboard" \| "soldered", why? }` | `{ style, note }` (edits) |

Wire cuts (used by export and by the case track's factory pack), in
`packages/session/src/assembly.ts` (power owns):

```ts
export interface WireCut { wire: string; from: string /* "xiao.GP6" */; to: string; color: string;
  length_mm: number /* rounded up to 5 mm, incl. 10 mm strip + slack */; gauge_awg: number /* 26 signal, 24 power */ }
export function assemblyStyle(project: Project, registry: PartRegistry): "breadboard" | "soldered";
/** positions: 3D pin positions in mm (case frame) from the case layout; without them the length is estimated from dimensions_mm. */
export function wireCuts(project: Project, registry: PartRegistry, positions?: Record<string /* "part.pin" */, [number, number, number]>): WireCut[];
```

check_design: `parallel-regulators` never fires for a battery wired to a charger's `BAT`; the
TP4056 `VIN` is the USB input (a fix never says to wire it to the board's 5 V / VBUS). New codes:
`usb-backfeed` (a battery path reaches VBUS with no diode / switch while USB can be plugged),
`battery-reversed` (cell NEG on a supply net or POS on ground), `ldo-dropout` (the regulator's
input falls below Vout + dropout before the cell is empty: say at which cell voltage),
`battery-overvoltage` (a 4.2 V cell straight on a 3.3 V pin), `no-power-path` (USB off and nothing
powers the board). The Muse must report **0 errors** wired correctly.

### R3. The case config in fabwright.json (`enclosure`, done in this commit)

```jsonc
"enclosure": {
  "shape": "pebble",                    // "rounded-box" | "pill" | "pebble" | "puck" | "keychain"
  "params": {
    "wall_mm": 1.6,                     // ≥ 1.2 (schema min), default 1.6
    "corner_radius_mm": 4,              // rounded-box / keychain, default 4
    "color": "#F2EDE4",                 // renders + 3MF colour
    "lanyard_hole": false,              // default true for keychain
    "belt_clip": false,
    "closure": "snap",                  // "snap" | "screws" (M2 into heat-set inserts)
    "tolerance_mm": 0.2,                // FDM default
    "process": "fdm",                   // "fdm" | "resin" | "injection"
    "gap_mm": 1.5                       // wiring room around parts
  },
  "front": "eye",                       // part whose screen faces out of the front (default: first display)
  "placements": {                       // optional; parts left out are auto-packed
    "pet": { "face": "right", "x_mm": 0, "y_mm": 4, "rotation": 0 },
    "bat": { "face": "inside", "layer": 2 }
  },
  "exclude": []                         // part ids not inside the case
}
```

Faces (`CASE_FACES`): `front | back | left | right | top | bottom`, as seen by the person holding
it with the front (screen) towards them; plus `inside` (no opening). `x_mm` / `y_mm` = position
on that face from its centre, +x right / +y up as you look straight at that face.

**Case frame** (every STL / 3MF / STEP is written in it): mm, origin at the centre of the outer
bounding box, looking at the front: **+x right, +y up, +z out of the front towards the viewer**
(right-handed). Shared types: `packages/enclosure/src/types.ts` (`CaseReport`, `CaseFile`,
`FitCheck`, `PlacedPart`, `CaseMesh`), constants `MIN_WALL_MM = 1.2`,
`DEFAULT_TOLERANCE_MM = 0.2`, `POCKET_MM = {w: 110, h: 70, d: 30}` (plan_device's pocket limit).
Pocket verdict: `fits` ≤ 110 × 70 × 30, `tight` ≤ 130 × 80 × 35, else `no`.

### R4. MCP tools (same names on the CLI: `fabwright <tool>` / `fabwright call <tool> '<json>'`)

New tools live in their track's `packages/session/src/tools/<track>.ts` as a `ToolModule` and one
appended line in `tools/index.ts` (0003 C5 rules).

| Tool | Track | Params | Returns |
| --- | --- | --- | --- |
| `set_power` | power | R2 | R2 |
| `set_assembly` | power | R2 | R2 |
| `design_case` | case | `{ shape: CaseShape, params?: CaseParams, front?: string, placements?: Record<id, CasePlacement>, exclude?: string[], save?: boolean /* default true; false = write to case/variants/<shape>/ and leave fabwright.json alone */, images?: boolean /* default true: front + exploded PNG inline */, why? }` | `CaseReport` (size_mm, inner_mm, pocket, ok, checks, files) + inline images + `next` (edits when save) |
| `update_case` | case | same fields, all optional; `params` / `placements` deep-merged, a placement set to `null` is removed | same; fails when there is no case: "No case yet. Why: … Fix: design_case {"shape": "pebble"}" |
| `get_case` | case | `{}` | `CaseReport`, regenerating stale files first (read-only for the project) |
| `export_manufacturing` | case | `{ dir?: string /* default "manufacturing" */, zip?: boolean /* default true */, zh_cn?: boolean /* default true */, why? }` | `{ dir, zip?, files: string[], missing: { item, why, fix }[], notes: string[], next }` (writes files, not an undoable edit, like `export`) |

Changes to existing tools: `search_parts` with no fit → `{ results: [], hint, create_part_template }`
(power); `get_part` fuzzy id (power); `check_design` codes (R2, power); `export` honours
`assembly` (power: soldered = `WIRE-CUTS.csv` + soldered steps, no breadboard / dupont lines);
`run` summary without "ran 3000 ms (now 3000 ms)" jargon (switch). Tool descriptions say what the
case cannot check (snap strength, real tolerances of the person's printer).

### R5. Files on disk

Generated case files are **outputs**, like `export/`: regenerated from `fabwright.json` + the parts'
`mechanical` data, never in the undo history (binary). `case/manifest.json` holds the hash; a
stale case (after undo, a moved part, a changed part) is regenerated by `get_case`, the route or
the next `design_case`.

```
<project>/case/
  manifest.json            { hash, enclosure, files: CaseFile[] }
  report.json              CaseReport
  stl/front.stl            binary STL, case frame, one body per file
  stl/back.stl
  stl/cap-<partId>.stl     button caps / plungers
  stl/light-pipe-<partId>.stl
  case.3mf                 every printable body, named and coloured
  step/assembly.step       shell bodies + part envelopes as named solids (AP214)
  step/front.step, step/back.step
  renders/front.png, back.png, exploded.png, inside.png
  drawing/drawing.svg      overall size, wall, hole positions, tolerances, material / finish, print settings
  drawing/drawing.pdf      only when Playwright's Chromium is installed (otherwise missing[] says why)
  PRINT.md                 per body: orientation, supports, layer height, infill, PLA / PETG; resin and injection notes
  variants/<shape>/…       design_case {save: false}: same layout, fabwright.json untouched
<project>/manufacturing/<slug>-v<version>/       (+ <slug>-v<version>.zip next to it)
  README.md                English, simple, for the supplier: what it is, what is inside, how to build, flash and test
  README.zh-CN.md          short summary (zh_cn)
  NOTES.md                 honest limits: no PCB layout (hand-wired / perfboard), what was only simulated, what to verify on a real unit
  BOM.csv                  line,refs,qty,name,mpn,manufacturer,lcsc,jlc,package,generic,unit_usd,ext_usd,buy_url,source,notes
  BOM.md
  electronics/WIRING.md, netlist.csv (net,part,pin), fabwright.net (KiCad legacy netlist), WIRE-CUTS.csv
  firmware/firmware.hex, firmware.uf2 (RP2040), FLASHING.md, source/<the firmware folder>
  enclosure/<everything in case/ except variants/>
  assembly/ASSEMBLY.md     numbered steps with the renders
  test/TEST-PLAN.md        the scenarios in plain words + TEST-ON-HARDWARE.md
  manifest.json            { project, version, firmware_hash, case_hash, files: { path, bytes, sha256 }[] }
```

`version` = the project's latest history version (0003 C3); `slug` = `projectSlug(name)`.
Committed example: `examples/agent-built/claude-pocket-muse/case/` (pebble, the saved case) and
`case/variants/puck/`. Binary STL keeps each body around 1 MB or less; the committed case stays
under 10 MB.

### R6. HTTP routes (`apps/cli/src/routes/case.ts`, `caseRoutes` + `caseHooks`)

Local-only like every route (0003 C3); changing routes need `x-fabwright-token`; errors are
`{ error: "<what failed>. Why: … Fix: …" }`.

| Method, path | Body | Answer |
| --- | --- | --- |
| `GET /api/case` | | `{ enclosure: Enclosure \| null, report?: CaseReport, stale: boolean }` |
| `POST /api/case` | `{ shape?, params?, front?, placements?, exclude? }` | `CaseReport`; `design_case` when there is no case, else `update_case`, actor `web` |
| `GET /api/case/mesh` | | `CaseMesh` (float32 positions / uint32 indices, base64, case frame, an `explode` vector per body); 404 with why / fix when there is no case |
| `GET /api/case/file?path=` | | the file from `<project>/case/` only (path checked), `content-disposition: attachment` |
| `POST /api/manufacturing` | `{ zh_cn? }` | `export_manufacturing` result + `url: "/api/manufacturing/<file>.zip"`, actor `web` |
| `GET /api/manufacturing/:file` | | a zip from `<project>/manufacturing/` only |

Live event (in `live-events.ts`, done in this commit): `{ type: "case", hash, ok }` after the
case files were regenerated. No other track adds routes this round.

### R7. Colour frames and libraries (frames track)

- `Frame.color?: Record<partId, ColorFrameImage>` (`packages/session/src/sim.ts`) and
  `VersionFrame.color?` (`versions.ts`), `ColorFrameImage = { w, h, png /* base64, no data: prefix */ }`,
  done in this commit; `GET /api/history/:version` passes `frame.color` through (done). The frames
  track fills it (only for parts whose screen changed since the last frame) and draws it in videos,
  history previews (one marked line in `HistoryView.tsx`, through its own
  `apps/web/src/lib/colorFrames.ts`), gallery thumbnails (`composeSvg`) and Tests filmstrips.
- Images: base `fabwright/arduino-cli:1.5.1-avr1.8.8-libs3`, runner
  `fabwright/arduino-runner:1.5.1-avr1.8.8-libs3-r1`, RP2040 `fabwright/arduino-pico:6.3.1-libs3-r1`
  (FROM the libs3 runner). Exact library versions in `toolchains/arduino/LIBRARIES.md`. Old tags
  stay buildable (env overrides `FABWRIGHT_ARDUINO_IMAGE`, `FABWRIGHT_RUNNER_IMAGE`, `FABWRIGHT_PICO_IMAGE`);
  golden hexes unchanged.

### R8. Per-project UI state (switch track)

`apps/web/src/lib/projectSwitch.ts` (done in this commit): `onProjectSwitch(cb)` /
`emitProjectSwitch({ id, reason: "open" | "reload" })`. The switch track emits it after the new
project is loaded, before it renders. Every track registers its own reset **in its own files**:
canvas (selection, inspector, live controls, serial scroll, view port: `open` fits the new
project, `reload` keeps the view), case (Case view state), frames (cached colour frames), switch
(code panel, firmware, toasts, sim stop + reset).

### R9. Who owns which files

| Track | Owns (edits freely) | Touches in a shared file (keep it small, marked `// round 6 <track>`) |
| --- | --- | --- |
| switch | `apps/web/src/projects/**`, `apps/web/src/code/**`, `lib/projectSwitch.ts`, `lib/app.ts`, `lib/store.ts`, `components/Toasts.tsx`, `components/EmptyHint.tsx`, `shell/TitleBlock.tsx`, `shell/Panels.tsx` (Firmware, Agent steps), `routes/projects.ts`, `tools/projects.ts`, `versions.ts` (not `color`), `apps/web/src/live/**` (steps list, agent state), `e2e/switch-*.spec.ts` | `packages/sim-backends/src/rp2040/hex.ts` (the board-mismatch message only), session.ts (`run` summary line), `lib/engine.ts` (only calls; a stop / reset helper at the end if one is missing) |
| canvas | `apps/web/src/interact/**` (+ new `interact/slots.tsx` for the docked card), `components/PartNode.tsx`, `components/Canvas.tsx`, `components/Inspector.tsx`, `components/SerialConsole.tsx`, `components/WireEdge.tsx`, `lib/engine.ts`, `lib/ui.ts`, `shell/actions.ts`, `apps/web/src/renderers/**` (pet bubble), `hints.ts` + `hints-boards.ts` (board-aware wiring), `e2e/canvas-*.spec.ts` | `shell/slots.tsx` (one line) |
| power | the 7 new part folders, pins / `limits` / `description` of `seeed-xiao-rp2040`, `raspberry-pi-pico`, `waveshare-rp2040-zero`, `tp4056-charger`, `lipo-battery` (+ their `model.ts`), `packages/sim-core/src/circuit.ts`, `board.ts`, `drc.ts`, `planner.ts`, `exporter.ts`, `assembly.ts` (new), `tools/power.ts`, `hints-parts.ts`, `apps/web/src/power/**` (USB toggle, own `slots.tsx`), `examples/agent-built/claude-pocket-muse/**` except `case/`, `docs/power.md` (new), `packages/session/test/power-*.test.ts` | session.ts (`searchParts`, `getPart`, plan / search logging, `export` assembly lines), `shell/slots.tsx` (one line), `examples/agent-built/README.md` (one row), `apps/web/src/lib/examples.ts` (one entry) |
| frames | `toolchains/**`, `services/runner/**`, `.github/workflows/ci.yml`, `screenshot.ts`, `recorder.ts`, `device-render.ts`, `visual-capture.ts`, `visual-report.ts`, `sim.ts` (colour capture), `apps/web/src/views/tests/**`, `apps/web/src/lib/colorFrames.ts` (new), `packages/parts/src/libs3.integration.test.ts` (new) + sketches under `packages/parts/fixtures/libs3/` | `HistoryView.tsx` (one line), NOTICE (append), session.ts (colour frames in `run` only) |
| case | `packages/enclosure/**`, `tools/case.ts`, `routes/case.ts`, `packages/session/src/manufacturing.ts` (new), `apps/web/src/views/case/**`, `apps/web/src/case/**` (store, `slots.tsx`), `docs/enclosures.md` (new), the `mechanical` / `sourcing` blocks at the end of existing part.json files, `docs/part-spec.md` (mechanical / sourcing section), `packages/parts/src/spec/mechanical.test.ts`, `examples/agent-built/claude-pocket-muse/case/**`, `e2e/case-*.spec.ts` | `shell/TopActions.tsx` (one "Case" button), `shell/slots.tsx` (one line), `custom/schema.ts` (two lines), NOTICE (append) |

Shared files and how they are touched:
- **`App.tsx`: nobody.** Mount through your own `slots.tsx` and one line in `shell/slots.tsx`.
- **Generated: `registry.gen.ts`, `fabwright.schema.json`, `custom-part.schema.json`,
  `docs/mcp-tools.md`.** Never hand-merge: take either side, run `pnpm gen`, commit.
- **Append-only, one line per track: `tools/index.ts`, `routes/index.ts`, `shell/slots.tsx`, NOTICE.**
- **part.json**: power edits `pins` / `limits` / `description` of the five files above; case only
  appends `mechanical` + `sourcing` after `tags`. Neither reformats a whole file.
- **`examples/agent-built/claude-pocket-muse/`**: power owns everything outside `case/`. If the
  folder is missing on the case branch, case copies `jumper-evals/round5/muse/pocket-muse` there to
  work, but **commits only `case/**`**; its tests read the project from that folder when present,
  else from `packages/enclosure/test/fixtures/pocket-muse.json`. After power's re-wire is merged
  the lead regenerates the committed case (`fabwright design_case` on the merged project).
- **`session.ts`**: only the methods listed; each block marked `// round 6 <track>`.
- **`pnpm-lock.yaml`**: replicad 1.1.0, replicad-opencascadejs 1.1.0 and fflate 0.8.3 are
  installed in this commit. Another dependency: exact version at least two weeks old; at merge
  the lockfile is regenerated with `pnpm install`, never hand-merged.
- **STATUS.md**: the lead updates it after the merges; tracks report in their final message.

### R10. Ports, isolation, merge order

- Never use, kill or restart anything on **7780** (the owner's `fabwright serve`); never touch `~/.claude`.
- Per track: switch `E2E_PORT=5191 E2E_HUB_PORT_BASE=8700`, canvas `5192 / 8800`, power
  `5193 / 8900`, frames `5194 / 9000`, case `5195 / 9100`. Manual `fabwright serve` runs use
  `--port 7801…7805 --strict-port` in the same order. Unit tests: servers on port 0,
  `FABWRIGHT_HOME` in a temp dir, AI gateway port 0.
- Docker: only frames builds or tags toolchain images.
- Merge order: 1. **switch**, 2. **canvas** (both web; canvas registers R8 resets on switch's
  emitter), 3. **power** (parts, DRC, the Muse example), 4. **frames** (images, colour frames;
  re-checks golden hexes and the Muse firmware build), 5. **case** (mechanical data for power's
  parts too, uses `assembly.ts`, regenerates the Muse case on the merged project). After each
  merge: `pnpm gen`, `pnpm typecheck`, `pnpm test`; e2e after the last. A track whose test depends
  on a later track writes it against the contract and lists it in its report.

### Case track: changes to the contracts (round 6, case branch)

- **R1, addition**: `mechanical.outline_parts` (optional): the footprint as a union of rects
  (top-left x, y, w, h) and discs (centre x, y, d) in the part frame; overrides `outline`. The
  GC9A01 module is a 35.4 mm round PCB with a header tab off-centre, which neither `rect` nor a
  centred `round` describes. One line in `packages/sim-core/src/part.ts`, marked `// round 6 case`.
- **R1, clarification** (docs/part-spec.md): `protrude_mm` is measured beyond the feature's face
  point; when `dimensions_mm.d` already includes a lever / shaft / dome, the feature gives `z` = the
  body top so `z + protrude_mm = d`. Parts whose drawing is turned a quarter (XIAO, Nano,
  RP2040-Zero) still use `dimensions_mm` for the frame; the drawing's top edge is the part's -x.
- **R2 / R3 fields were not saved**: `serializeProject` (project-format) and the undo entity map
  (`session/src/history.ts`) did not carry `assembly`, `power` or `enclosure`. The case branch adds
  all three generically (the same lines the power track needs); if both branches add them, keep one.
- **R2 wire cuts**: `assembly.ts` is not on the case branch, so the factory pack uses
  `caseWireCuts` in `packages/session/src/manufacturing.ts` with the same `WireCut` shape and the
  case layout's pin positions. After power merges, the lead can point the pack at
  `assembly.wireCuts` (one call in `tools/case.ts`).
- **R4 CLI**: `fabwright <tool> '<json>'` works for every tool (a default branch in
  `apps/cli/src/main.ts` `toOp`). **MCP**: tools may return `image_files` (absolute PNG paths);
  `toContent` inlines them (`packages/mcp/src/server.ts`, 7 lines). `custom/compile.ts` passes
  `mechanical` / `sourcing` through to the compiled spec (2 lines).
- **IGES**: the replicad-opencascadejs 1.1.0 build has no IGES writer; the pack ships STEP AP214
  and says how to convert.
- **Web**: a Case entry in the phone ⋯ menu as well as the desktop button (`shell/TopActions.tsx`).
