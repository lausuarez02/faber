# Printing the case: Pocket Muse

Shape **puck**, outer 63.1 x 55.2 x 32 mm, wall 1.6 mm, process **fdm** (PLA), clearances 0.2 mm.

## Bodies

| File | Face on the bed | Supports | Notes |
| --- | --- | --- | --- |
| stl/front.stl | front | no | front face on the bed (the window side down), open side up (about 340 mm² of the rounded edge overhangs more than 45° near the bed: use a brim; supports only if the edge sags) |
| stl/back.stl | back | no | back face on the bed, open side up (about 158 mm² of the rounded edge overhangs more than 45° near the bed: use a brim; supports only if the edge sags) |
| stl/cap-pet.stl | flat | no | print standing on its flange, 0.12 mm layers |

`case.3mf` has every body, named and coloured, ready for a slicer (PrusaSlicer, Bambu Studio, Cura). The STL / 3MF / STEP files are in the case frame (origin at the centre of the outer box); the slicer lays each body flat on the face named above.

## Settings

- Nozzle 0.4 mm, layer 0.16 to 0.2 mm, 4 perimeters (walls print solid), 20 % gyroid infill, 5 top / bottom layers.
- Each shell prints open side up on its outer face: no supports needed except where PRINT.md says.
- Brim 3 mm on rounded shapes (small first-layer footprint). First layer slow (20 mm/s). Clearances in this file: 0.2 mm.

## Material and finish

- PLA (easy) or PETG (tougher, better for snap lips and belt clips); matte PLA hides layer lines.
- Optional: sand 240 → 400, filler primer, paint; or print the front in a contrasting colour.
- Light pipes: clear PETG or clear resin. Button plungers: PETG or PLA.

## Other processes

- **Resin (SLA / MSLA)**: re-generate with `update_case {"params": {"process": "resin"}}` for 0.1 mm clearances; hollow shells print fine open side down with light supports.
- **Injection moulding**: send `step/assembly.step` (or `step/front.step` + `step/back.step`) to the toolmaker with the drawing; they add 1° draft, gates and ejector pins. Ask for PC/ABS with a VDI 27 texture.

## Assembly hardware

- None: the front snaps onto the back (lip 1.0 mm, 0.3 mm bead). Press evenly all round; to open, push a fingernail into the seam at the bottom.
- Double-sided foam tape (1 mm) behind the modules that have no standoff; Kapton tape over bare pads that face metal.

## What this case cannot promise

- Snap strength and fit depend on the filament and on your printer's real tolerances: print the front and back first and test the fit before printing caps and pipes.
- Part sizes come from datasheets or typical modules (see the drawing notes); clone modules vary by up to ~1 mm. Measure yours if it is tight.
- No drop, water or heat testing: a LiPo inside needs room to swell (the cradle leaves 10 %) and must never be squeezed or pierced.
