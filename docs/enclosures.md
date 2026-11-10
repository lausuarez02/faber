# Cases and the factory pack

Round 6 (decision [0004](decisions/0004-round6-real-device.md)): a Jumper project can be finished
as a real object. `design_case` packs its parts into a two-part printable case and writes every file
a 3D printer or a factory needs; `export_manufacturing` adds the electronics, the firmware, the
assembly steps and the test plan into one pack a supplier can follow.

<p align="center"><img src="../examples/agent-built/claude-pocket-muse/case/renders/exploded.png" alt="The Pocket Muse case, exploded" width="560"></p>

## Use it

From an agent (MCP) or the shell (same names):

```sh
jumper design_case '{"shape": "pebble"}' -p examples/agent-built/claude-pocket-muse
jumper design_case '{"shape": "puck", "save": false}' -p …      # compare a shape, jumper.json untouched
jumper update_case '{"params": {"closure": "screws", "color": "#2B3038"}, "placements": {"pet": {"face": "left"}}}' -p …
jumper get_case -p …                                            # the report; regenerates stale files
jumper export_manufacturing -p …                                # manufacturing/<name>-v<version>/ + .zip
```

In the web app: the **Case** button (box icon, top right; on phones in the ⋯ menu) opens the Case
view: the case in 3D with the parts inside, a **See-through** and an **Explode** slider, the shape
picker and settings, **Design case / Update case**, the fit checks, the size and the pocket verdict,
downloads (STL, 3MF, STEP, drawing, print notes) and **Factory pack (zip)**. It needs `jumper serve`
(the CAD runs on the server; the browser only gets meshes).

## Any shape, any size (round 7)

The five shapes below are starting points, not the only choices. A case can be **any outline**:
`shape: "custom"` with an `outline` the agent or the person draws, at **any size** with `size_mm`.
There is no preset per object: an egg, a heart, a bean or a guitar pick is a custom outline.

```sh
# an egg 56 x 73 mm drawn as an SVG path (y DOWN, like any SVG): narrow top, wide bottom
jumper check_fit '{"shape": "custom", "outline": "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z"}' -p …
# the same kind of egg as points (y UP) through which a smooth closed curve runs, at a fixed size
jumper design_case '{"shape": "custom", "outline": {"points": [[0,40],[14,33],[24,16],[28,-4],[24,-22],[13,-32],[0,-34],[-13,-32],[-24,-22],[-28,-4],[-24,16],[-14,33]], "smooth": true}, "size_mm": {"w": 64, "h": 84}, "params": {"dome_mm": 2}}' -p …
```

- **`outline`** is the front view in mm: an SVG path string (`M L H V C S Q T A Z`, absolute or
  relative; y points down as in any drawing program) or `{"points": [[x, y], ...], "smooth": true}`
  with y up (the device's top is +y; `smooth: false` = straight lines whose sharp corners are rounded
  so they print). It must be one closed shape that does not cross itself; errors say where and how
  to fix it. The outline becomes one periodic cubic B-spline: OpenCascade builds the shell from that
  curve and the packer tests points against the same curve (a signed distance field), so what is
  checked is what is printed. Its proportions are kept; its drawn size only matters as a ratio.
- **`size_mm`** `{w, h, d}` (any of them; the rest auto). With w / h the outline is scaled to exactly
  that size and the case is that size; with neither the outline grows uniformly to the smallest
  size that holds the parts (never under 15 mm, at most 250 mm). `d` (or `params.depth_mm`) fixes the
  thickness. A preset with `size_mm.w` / `h` becomes its own outline at that size (same pipeline).
- **3D finish, any shape** (`params`, each a number or `"auto"`): `edge_radius_front_mm`,
  `edge_radius_back_mm` (the rim round-overs; clamped where a side port needs a straight wall, with
  a warning), `dome_mm` / `dome_back_mm` (how far each face bulges as a sphere cap with a flat print
  pad; auto is about 1 mm on pebble and custom, flat on the rest), `depth_mm`.
- **Packing inside the real outline**: the parts are packed straight into the outline, inset by the
  wall, the wiring gap and the rim round-over at their depth, not into its bounding box, so the
  narrow end of an egg holds less than its wide end; the screen stays on the centre line but moves
  up or down to where the outline is wide. A custom outline keeps its silhouette: a port on a curve
  gets a spot face; only where a plug could not reach at all is a local flat (up to 8 mm deep) cut,
  and the report says so (a heart's point, a lobe). Ports try other sides first (a heart's bottom is
  a point), and a layout where a plug would not reach loses to one where it does.
- **When the parts do not fit** a fixed size, nothing grows and nothing is saved: `design_case` /
  `update_case` return `fits: false`, `misses` (`{part, type, dimension: "outline" | "depth", short_mm,
  where, message}`, e.g. "eyes (gc9a01-round-tft) sticks out 3.1 mm at the bottom of the outline")
  and `suggestions`, each tried with the same layout (`fits`, `size_mm`) and given as the calls that
  make it (`change: [{tool, args}]`): a smaller part in the same role from the library (a 0.96" SSD1306
  instead of the GC9A01, a 20 mm speaker instead of a 28 mm one, a smaller board with the same chip),
  a smaller LiPo cell (the `capacity` prop picks the pouch: 150 mAh 402030, 250 mAh 502030, 500 mAh
  503035, 1000 mAh 523450), a board stood on its edge (`placements: {"xiao": {"on_edge": true}}`),
  less rounded rims, or "make it N mm bigger" with the size that holds everything.
- **`check_fit`** (or `design_case {"dry_run": true}`) answers all of that without CAD in well under a
  second (the suggestions are tried while a ~1 s budget lasts; untried ones have no `fits`).
  `check_fit` with no arguments tests the saved case; `preview: true` adds the front-view geometry.
- **In the Case view**: **Custom** opens the outline editor: start from an ellipse or a preset, drag
  the points, double-click (or **+ Point**) to add one, **− Point** to remove the selected one; Tab
  to a point, arrows move it 1 mm (Shift: 5 mm), Delete removes it. **W / H / D** in mm (blank =
  auto). The parts' footprints are drawn inside the outline at real size as you edit, red where one
  runs into the wall, with what misses and what would fit under it (**Use N × M mm** takes the size
  that holds everything). An outline an agent drew opens in the same editor.

<p align="center"><img src="media/round7-egg-front.png" alt="A talking egg: a custom egg outline with a round screen for eyes" width="300"> <img src="media/round7-egg-exploded.png" alt="The egg case exploded: front shell, parts, back shell with the speaker grille" width="300"></p>

## Shapes and settings

| Shape | What it is |
| --- | --- |
| `rounded-box` | Rounded rectangle (corner radius `corner_radius_mm`), small edge round. The most compact. |
| `pill` | Capsule: semicircular ends on the long axis, front and back edges rounded in 3D (up to ~0.44 of the depth). |
| `pebble` | Oval plan, sized around the parts, centred on the screen in x; front and back edges rounded in 3D with one large fillet each (up to ~0.44 of the depth), both faces domed about 1 mm with a flat land round the window and a flat pad on the back (what each shell prints on). |
| `puck` | Round, centred on the screen, edges rounded in 3D (~0.34 of the depth). |
| `keychain` | Rounded box (7 mm plan corners) with 3D-rounded edges, a tab and a 5 mm lanyard hole. |
| `custom` | Round 7: any `outline` you draw (SVG path or smoothed points), at any `size_mm` or auto, rounded and domed like a pebble (above). |

`params` (all optional): `wall_mm` (≥ 1.2, default 1.6), `corner_radius_mm` (4), `color`
(renders + 3MF), `lanyard_hole` (default on for keychain; a small tab on other shapes), `belt_clip`
(a separate PETG clip glued to the back), `closure` (`snap` lip with a bead and groove, or `screws`:
M2 into brass heat-set inserts in the front shell's bosses, counterbored from the back),
`tolerance_mm` (0.2 FDM, 0.1 resin, 0.05 injection), `process` (`fdm` / `resin` / `injection`:
notes, materials and tolerances), `gap_mm` (1.5: wiring room around each part).

`front`: the part whose screen faces out (default: the first display). `placements`: per part,
`{"face": "front" | "back" | "left" | "right" | "top" | "bottom" | "inside", "x_mm", "y_mm",
"rotation", "layer", "on_edge"}`, faces as seen holding the device with the screen towards you; parts left out
are auto-packed. `exclude`: parts not in the case (an external sensor on a cable).

## How the layout works

1. **Mechanical data** from each part's `part.json` (`mechanical`, [part-spec](part-spec.md#mechanical-and-sourcing-round-6)):
   footprint, keep-outs, mounting holes, and features (screen active area, button cap, USB port,
   LEDs, sensor windows, grilles, levers).
2. **Orientation**: the front part's screen faces +z. A part with an exposed feature turns so the
   feature faces its case face: USB to the bottom (a box or key fob: all on its bottom, with a flat
   wall; a pebble / pill / puck: the charging port at the bottom and the next on its own side, so no
   wall is cut flat; a spot face thins the wall round a port the curve holds back), buttons to
   the right / left / top, a slide switch's lever and sensor windows to the top, a buzzer's grille
   to the back. Everything else lies flat.
3. **Packing**: a front stack from the screen backwards and a back stack (the LiPo in its cradle,
   back grilles) from the back wall, as shallow as both allow, with `gap_mm` around each part. Side
   parts (ports, buttons, levers) slide to mid-depth so the edges can be rounded. Four part orders
   x 11 x 11 plan rectangles (and, on curved shapes, which port gets which side) are packed; the ~30
   most promising are finished into real layouts and the one with the smallest outer volume wins,
   weighed up when thicker than 18 mm (more past 22), when its edge radius falls short of the shape,
   or when it needs a flat. `report.volume_cm3` is the volume inside the outer surface.
4. **Plan**: the cavity outline for the shape is sized around the parts, allowing for the rounded
   front and back edges (the inner round is concentric with the outer one, so the wall is uniform).
   The outer outline is a true 2D offset of the cavity by `wall_mm`.
5. **Details**: window over the active area (+0.3 mm into the bezel), button plungers (flange
   inside, 1 mm proud, a hole with clearance), USB openings sized for the plug's overmold, light
   pipes for exposed SMD LEDs, sound holes, ribs that locate the screen module, standoffs + pins
   where a module has mounting holes and a free path to a wall, the cell cradle (+10 % swell), the
   snap lip or the screw bosses, the tab.

Case frame (STEP files, the web meshes, the report): mm, origin at the centre of the outer box, +x
right, +y up, +z out of the front. Every **STL is in print orientation**: the face PRINT.md names
lies flat on z = 0, centred on x = y = 0 (front shell face down, back shell open side up, caps and
light pipes on their flange, the belt clip on its L profile). `case.3mf` is one **build plate**:
every body in that pose, side by side 6 mm apart (item transforms). `step/assembly.step` stays
assembled.

## Checks (in every report)

| Check | Meaning |
| --- | --- |
| `fits` | every part is inside with the wiring room; small passives ride in the wiring |
| `screen-window` | window centred on the active area, not cutting past the bezel |
| `buttons-reachable` | each plunger goes through its hole, stands proud for the switch's travel |
| `connector-access` | the plug reaches: receptacle ≤ 2.5 mm inside the outer surface, opening on a flat |
| `min-wall` | wall measured between the outer and inner surfaces in OpenCascade (and at the snap groove), ≥ 1.2 mm |
| `printable` | prints on its outer face without supports; overhang area of the rounded edge near the bed |
| `watertight` | every STL is a closed 2-manifold with volume > 0 (re-checked from the file bytes in tests) |
| `no-intersection` | no part body overlaps a shell (OpenCascade common volume < 0.001 mm³) |
| `size-match` | the printed bodies are within 0.1 mm of the planned size |
| `pocket` | thickness first: `fits` (comfortable) ≤ 18 mm thick within 110 × 70 mm, `tight` ≤ 22 mm within 130 × 80, else `no` (bulky); the message names the reason and the volume |

What the case **cannot** check: snap strength and fit on your printer (print the two shells and test
before the rest), clone modules that differ by ~1 mm from the typical sizes, drop / water / heat,
and the actual route of each wire (`gap_mm` is a budget).

## Files

```
case/                    (outputs: regenerated from jumper.json + the parts' data, never undone)
  stl/front.stl, back.stl, cap-<part>.stl, light-pipe-<part>.stl, belt-clip.stl
  case.3mf               build plate: every printable body in print orientation, named and coloured
  step/assembly.step     shells + plungers + the parts as named solids (AP214), front.step, back.step
  renders/front.png, back.png, exploded.png, inside.png
  drawing/drawing.svg    A3: front / side / bottom views, overall size, openings table, tolerances,
  drawing/drawing.pdf    material / finish, print settings (PDF when Playwright's Chromium is installed)
  PRINT.md               per body: face on the bed, supports, settings; resin and injection notes
  report.json, manifest.json (hash of the inputs: a stale case is regenerated by get_case / the view)
  variants/<shape>/…     design_case {save: false}
manufacturing/<name>-v<version>/ (+ .zip)
  README.md, README.zh-CN.md, NOTES.md, BOM.csv, BOM.md
  electronics/WIRING.md, netlist.csv, jumper.net (KiCad legacy netlist), WIRE-CUTS.csv
  firmware/firmware.hex, firmware.uf2 (RP2040), FLASHING.md, source/
  enclosure/ (the case files), assembly/ASSEMBLY.md, test/TEST-PLAN.md, TEST-ON-HARDWARE.md
  manifest.json          sha256 of every file
```

The web view's meshes are cached in `.jumper/case-mesh.json`.

## Engine and licences

CAD: [replicad](https://github.com/sgenoud/replicad) 1.1.0 (MIT) on the OpenCascade WebAssembly
build `replicad-opencascadejs` 1.1.0 (LGPL-2.1, loaded unmodified at run time, see NOTICE), in
Node only (`packages/enclosure`, loaded lazily). STL / 3MF are written by Jumper (3MF zipped with
fflate, MIT), renders by Jumper's own rasteriser (no browser), the drawing as SVG (PDF printed by
Playwright's Chromium when present). This OpenCascade build has no IGES writer: the pack ships
STEP AP214, which factories accept (convert to IGES in FreeCAD if one insists).

## Honest limits (round 7, custom outlines)

- The packer is a search (packings into the outline at a few sizes and part orders, plus rectangles),
  not an optimum; a custom outline gets the same search in `check_fit` and `design_case` (about
  0.3 to 0.6 s), so they agree. Suggestions are each one change, tried alone.
- A narrow tip or a deep notch is rounded less than the rest (OpenCascade cannot roll a large rim
  round a tight curve; the report says the radius it made). Outline necks narrower than two walls
  plus 4 mm are reported, not fixed.
- LiPo cell sizes by capacity are typical pouch sizes; the real cell can differ by about 1 mm.
- The editor edits points through which a smooth curve runs; an SVG path an agent drew opens as 14
  points along its silhouette (saving it from the editor replaces the path with those points).

## Honest limits (round 6)

- Edges round as far as the side openings allow: every port, plunger and lever needs its hole on
  the straight band of the side wall, so the front and back radii differ when a port sits off
  mid-depth (the Muse pebble: 6 mm front, 2.7 mm back). Packing is a search, not an optimum.
- Parts without mounting holes are located by ribs (screen) or held with foam tape; standoffs are
  only made where a column to a wall is free.
- Wire cuts (`wireCuts` in `packages/session/src/assembly.ts`, shared with `export`) take the pin
  distance in the case layout × 1.3 for routing plus 10 mm strip and 15 mm slack, rounded up to 5 mm;
  without a case they are estimates from the part sizes (the CSV says which). Not routed paths.
- No PCB layout: the pack is for a hand-wired / perfboard build; `jumper.net` is where a PCB starts.
- Sourcing has MPNs and plain descriptions; LCSC / JLC numbers are left empty until checked.
