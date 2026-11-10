/** Materials, print settings and PRINT.md (per body: orientation, supports, layers, infill). */
import type { Layout } from "./layout.ts";

export function materialFor(process: "fdm" | "resin" | "injection"): { name: string; density: number; lines: string[] } {
  if (process === "resin")
    return { name: "tough resin", density: 1.18, lines: ["Tough / ABS-like resin (e.g. a 'tough' or 'engineering' grade), 0.05 mm layers.", "Wash in IPA, post-cure 30 to 60 min; matte primer + paint for a finish.", "Hollow parts: leave the open side down-facing drain path clear; no supports on the outer face if possible."] };
  if (process === "injection")
    return { name: "PC/ABS", density: 1.15, lines: ["PC/ABS or ABS (UL94 V-0 grade if mains-powered), MT-11010 or VDI 3400 Ref 27 texture outside, polished window area.", "Add 1° draft on all walls along the mould direction (z) and keep walls uniform (this design: one wall thickness).", "Snap lip / bosses: check undercuts with the toolmaker; bosses want ribs to the wall and a 0.6 x wall outer diameter rule.", "This file is a printable prototype, not a mould-ready design: a toolmaker will re-model it (draft, gates, ejector pins)."] };
  return { name: "PLA", density: 1.24, lines: ["PLA (easy) or PETG (tougher, better for snap lips and belt clips); matte PLA hides layer lines.", "Optional: sand 240 → 400, filler primer, paint; or print the front in a contrasting colour.", "Light pipes: clear PETG or clear resin. Button plungers: PETG or PLA."] };
}

export function printSettings(process: "fdm" | "resin" | "injection"): string[] {
  if (process === "resin") return ["Layer 0.05 mm, tough resin, supports only on the inside faces, 30° tilt if the slicer suggests it.", "Clearances in this file: 0.1 mm."];
  if (process === "injection") return ["For a printed prototype of the injection design use the FDM settings: 0.16 mm layers, 4 walls."];
  return ["Nozzle 0.4 mm, layer 0.16 to 0.2 mm, 4 perimeters (walls print solid), 20 % gyroid infill, 5 top / bottom layers.", "Each shell prints open side up on its outer face (a domed face stands on its flat land / pad): no supports needed except where this file says.", "Brim 3 mm on rounded shapes (the rounded edge leaves a small first-layer footprint). First layer slow (20 mm/s). Clearances in this file: 0.2 mm."];
}

export function printMd(L: Layout, title: string, bodies: { name: string; print: { face_down: string; supports: boolean; note?: string }; overhang_mm2?: number }[], screws?: { count: number; size: string; inserts: string }): string {
  const lines: string[] = [];
  const mat = materialFor(L.params.process);
  lines.push(`# Printing the case: ${title}`, "");
  lines.push(`Shape **${L.shape}**, outer ${L.outer.w} x ${L.outer.h} x ${L.outer.d} mm, wall ${L.params.wall_mm} mm, process **${L.params.process}** (${mat.name}), clearances ${L.params.tolerance_mm} mm.`, "");
  lines.push("## Bodies", "", "| File | Face on the bed | Supports | Notes |", "| --- | --- | --- | --- |");
  for (const b of bodies) lines.push(`| stl/${b.name}.stl | ${b.print.face_down} | ${b.print.supports ? "yes" : "no"} | ${b.print.note ?? ""}${b.overhang_mm2 && b.overhang_mm2 > 1 ? ` (about ${Math.round(b.overhang_mm2)} mm² of the rounded edge overhangs more than 45° near the bed: use a brim; supports only if the edge sags)` : ""} |`);
  lines.push("", "Every STL is already in its print orientation: the face named above lies flat on z = 0, centred on x = y = 0, so it drops onto the bed as it is (no rotating in the slicer). `case.3mf` is one build plate with every body in that orientation, side by side 6 mm apart, named and coloured (PrusaSlicer, Bambu Studio, Cura). The STEP files stay in the case frame (origin at the centre of the outer box, +z out of the front) and `step/assembly.step` is the assembled case with the parts, for CAD and factories.", "");
  lines.push("## Settings", "", ...printSettings(L.params.process).map((s) => `- ${s}`), "");
  lines.push("## Material and finish", "", ...mat.lines.map((s) => `- ${s}`), "");
  lines.push("## Other processes", "");
  if (L.params.process !== "resin") lines.push("- **Resin (SLA / MSLA)**: re-generate with `update_case {\"params\": {\"process\": \"resin\"}}` for 0.1 mm clearances; hollow shells print fine open side down with light supports.");
  if (L.params.process !== "injection") lines.push("- **Injection moulding**: send `step/assembly.step` (or `step/front.step` + `step/back.step`) to the toolmaker with the drawing; they add 1° draft, gates and ejector pins. Ask for PC/ABS with a VDI 27 texture.");
  lines.push("");
  lines.push("## Assembly hardware", "");
  if (screws) lines.push(`- ${screws.count} x ${screws.size}`, `- ${screws.count} x ${screws.inserts}`);
  else if (L.lip) lines.push(`- None: the front snaps onto the back (lip ${L.lip.t.toFixed(1)} mm${L.lip.groove > 0.05 ? `, ${L.lip.bead} mm bead` : ""}). Press evenly all round; to open, push a fingernail into the seam at the bottom.`);
  lines.push("- Double-sided foam tape (1 mm) behind the modules that have no standoff; Kapton tape over bare pads that face metal.", "");
  lines.push("## What this case cannot promise", "", "- Snap strength and fit depend on the filament and on your printer's real tolerances: print the front and back first and test the fit before printing caps and pipes.", "- Part sizes come from datasheets or typical modules (see the drawing notes); clone modules vary by up to ~1 mm. Measure yours if it is tight.", "- No drop, water or heat testing: a LiPo inside needs room to swell (the cradle leaves 10 %) and must never be squeezed or pierced.");
  return lines.join("\n") + "\n";
}
