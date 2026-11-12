# The build kit: everything to build it yourself

Round 12. Ask an agent "what do I need to build it?" (or press **Build it yourself** in the Case
view or the project menu) and Jumper answers with one kit, for any project:

| Part | What is in it |
| --- | --- |
| **Buy** | Every part with its quantity and the exact variant to pick ("250mAh, 502030 pouch cell, JST-PH 2.0 lead", "100k"), the settings it was designed with in words ("Charge current (R_PROG): 250 mA (it usually comes set to 1000 mA: change it before first use)"), store links from the part data for the shopper's region (Amazon searches move to amazon.de / .co.uk), unit and line prices, alternatives (same-chip boards, "any module sold as …"), and the things people forget. Totals per store, "still to buy", and everything including what they may already have. |
| **Tools** | Soldering iron (with the tip for castellated pads), cutters, stripper, multimeter, … each required / recommended / optional with why; skill level with the reasons; print time and hands-on time. |
| **Print** | Each STL: material, colour (named from the case colour), the face on the bed, supports, layer height, infill, walls, grams and time; the 3MF build plate; what to tell a print service (JLC3DP, Craftcloud: which files, which material). |
| **Assemble** | Numbered steps, each with its picture, the wires (from / to in words, colour, cut length, gauge), cautions and a check before going on: print and test-fit the shells, heat-set inserts (screwed cases), flash the bare board, cut and strip, power and ground first, one module at a time (resistors / diodes inline with the module they serve), parts into the case layer by layer (which wall each port, button or lever lines up with), the cell last, close it, final check. |
| **Flash** | Per board: UF2 drag and drop (RP2040), esptool with the board's own command (ESP32), avrdude / arduino-cli (AVR), arduino-cli with the board's FQBN (nRF52, STM32 with an ST-Link or DFU note), mpremote (MicroPython); where the file is in the project and in the kit; the sound clips for a microSD card. |
| **If it does not work** | Common problems by part category (computer does not see the board, dark screen, no sound, runs on USB but not the battery, the case does not close), what Jumper's design check and case checks said, and the "check on the real device" list from the simulation's fidelity data. |

## Use it

```sh
jumper get_build_kit '{}' -p my-project                       # writes build-kit/<name>-kit/ + zip
jumper get_build_kit '{"region": "eu", "prefer": "AliExpress", "write": false}' -p my-project
```

- MCP / CLI: `get_build_kit {region?, prefer?, slicer?, write?, pdf?}` returns `{summary, kit, files, next}`.
  The kit is read-only on the project: it never rebuilds the case or the firmware; `missing[]` says
  what is stale or absent, with the fix.
- HTTP (the web panel): `GET /api/kit?region=` (the kit), `POST /api/kit/files` (writes the files;
  token), `GET /api/kit/file?path=` (a file from `build-kit/`).
- Web: **Build it yourself** in the Case view (under the files) and in the project menu (phones: the
  ⋯ menu). Tabs Buy / Print / Assemble / Flash; ticks are kept in that browser only; Zip, PDF, Page.
- The factory pack (`export_manufacturing`) also has `build-kit/` (kit.html, KIT.md, SHOPPING.csv,
  PRINT-LIST.md); the factory files and the zh-CN summary are unchanged.

Files in `build-kit/<name>-kit/`: `kit.html` (one self-contained page, pictures inside, ticks kept in
the browser, prints to PDF), `kit.pdf` (when Playwright's Chromium is installed), `KIT.md`,
`SHOPPING.md`, `SHOPPING.csv` (one row per store link), `PRINT-LIST.md`, `case/` (the STLs, the 3MF,
the renders), `firmware/` (the file to flash), `sd-card/` (clips, when the project talks).

## The things people forget (rules, not per project)

| Rule | Adds |
| --- | --- |
| A part whose description names a microSD / TF slot | a microSD card, FAT32 |
| A part with a JST lead (sourcing names JST-PH / SH / XH / ZH / GH) whose neighbours have no matching connector feature | the mating socket with leads, with the polarity warning |
| Every USB connector feature on the parts | a data (not charge-only) cable of that type |
| Soldered build | silicone wire per gauge (metres from the cut list + 20 %, the colours used), heat-shrink, solder, Kapton tape |
| Breadboard build | breadboard, Dupont wires (one per connection), header pins for modules |
| A case | double-sided foam tape; filament (grams from the print list) |
| `closure: "screws"` | M2 screws and heat-set inserts (count = the case's bosses) |

Lines without a store link in the part data get store searches for their description and a
`no_link` note that says so; stand-ins say to search for the real part by name.

## Print estimates

From each STL's mesh (volume, surface area, height): the walls and the top / bottom skins print
solid (area x 1 mm, never more than the volume), the rest at the infill; grams = printed volume x
density (PLA 1.24, PETG 1.27) x 1.05 for the brim and purge; time = printed volume / 4 mm³ per
second + 3 s per layer. A fast printer takes about half. Resin: solid volume x 1.1, 8 s per 0.05 mm
layer. When **PrusaSlicer** is installed on this computer (`/Applications/PrusaSlicer.app`, or
`prusa-slicer` on PATH, or `JUMPER_SLICER=<path>`), `get_build_kit` slices each STL with explicit
settings and reads the G-code's own estimate (cached in `.jumper/kit-slicer.json`; the web panel
uses only cached slices, it never slices). OrcaSlicer is detected but not driven (its command line
needs printer profiles). No slicer is bundled (PrusaSlicer is AGPL); `JUMPER_SLICER=none` turns it
off.

## The assembly plan

When the case engine writes an assembly plan (round 12 track assembly) the steps come from it:
`report.assembly_plan` / `report.assemblyPlan` / `report.assembly` in `case/report.json`, or
`case/assembly.json`, shaped `{steps: [{title, do | text | instructions, parts, wires (ids or
{from, to, color?, length_mm?, gauge_awg?}), image | images | picture (relative to case/),
cautions | caution | warnings, check | checkpoint | test, minutes}]}` (`AssemblyPlanLike` in
`packages/session/src/kit/steps.ts`; extra fields are ignored). Wires named by id take their colour,
length and gauge from the cut list. Without a plan the steps are derived (`steps_source: "derived"`).

## Honest limits

- Prices are the part data's typical single-unit prices; consumables are rough estimates; no
  shipping, tax or live stock. Most links are store searches (the part data has few product pages).
- The derived steps use the case renders as pictures (the same inside view for each wiring step);
  the parts in the inside render are coloured boxes without labels.
- Wire lengths are the factory pack's (pin distance in the case x 1.3 + strip + slack), not routed.
- Print grams and times are estimates unless PrusaSlicer sliced them.
- Skill and time are rules of thumb (about 3 minutes per soldered wire for a first-timer).
