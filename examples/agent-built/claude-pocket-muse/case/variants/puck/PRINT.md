# Printing the case: Pocket Muse

Shape **puck**, outer 72.7 x 72.7 x 25 mm, wall 1.6 mm, process **fdm** (PLA), clearances 0.2 mm.

## Bodies

| File | Face on the bed | Supports | Notes |
| --- | --- | --- | --- |
| stl/front.stl | front | no | front face on the bed (the window side down), open side up (about 1333 mm² of the rounded edge overhangs more than 45° near the bed: use a brim; supports only if the edge sags) |
| stl/back.stl | back | no | back face on the bed, open side up (about 493 mm² of the rounded edge overhangs more than 45° near the bed: use a brim; supports only if the edge sags) |
| stl/cap-pet.stl | flat | no | standing on its flange, 0.12 mm layers |

Every STL is already in its print orientation: the face named above lies flat on z = 0, centred on x = y = 0, so it drops onto the bed as it is (no rotating in the slicer). `case.3mf` is one build plate with every body in that orientation, side by side 6 mm apart, named and coloured (PrusaSlicer, Bambu Studio, Cura). The STEP files stay in the case frame (origin at the centre of the outer box, +z out of the front) and `step/assembly.step` is the assembled case with the parts, for CAD and factories.

## Settings

- Nozzle 0.4 mm, layer 0.16 to 0.2 mm, 4 perimeters (walls print solid), 20 % gyroid infill, 5 top / bottom layers.
- Each shell prints open side up on its outer face (a domed face stands on its flat land / pad): no supports needed except where this file says.
- Brim 3 mm on rounded shapes (the rounded edge leaves a small first-layer footprint). First layer slow (20 mm/s). Clearances in this file: 0.2 mm.

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
