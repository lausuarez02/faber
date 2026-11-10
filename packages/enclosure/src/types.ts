/**
 * Shared shapes of the case engine (decision 0004, contracts R3 to R5). The case track implements
 * them; the session tools, the HTTP routes and the web Case view only rely on these types.
 *
 * Case frame (mm): origin at the centre of the case's outer bounding box. Looking at the front
 * (the screen side): +x right, +y up, +z out of the front towards the viewer. Right-handed.
 * Every STL / 3MF / STEP file is written in this frame (the slicer re-orients for printing; the
 * print orientation we recommend is in CaseFile.print).
 */
import type { CaseShape, Enclosure } from "@jumper/project-format";

export type Vec3 = [number, number, number];

/** One generated file, relative to the project's case/ folder. */
export interface CaseFile {
  path: string; // e.g. "stl/front.stl"
  kind: "stl" | "3mf" | "step" | "png" | "svg" | "pdf" | "json" | "md";
  /** Which body it holds: "front", "back", "cap-<partId>", "light-pipe-<partId>", "assembly", "drawing", "render-front", … */
  body: string;
  bytes: number;
  sha256: string;
  /** For printable bodies: suggested orientation and whether supports are needed. */
  print?: { face_down: "front" | "back" | "inside" | "flat"; supports: boolean; note?: string };
}

/** A part placed inside the case. */
export interface PlacedPart {
  id: string; // part instance id from jumper.json
  type: string;
  /** Box of the part body in the case frame (mm), after rotation. */
  min: Vec3;
  max: Vec3;
  /** Rotation applied to the part frame (degrees about the case z axis, then flip: part +z facing case +z or -z). */
  rotation: 0 | 90 | 180 | 270;
  /** Case face the part's top (+z) faces: front / back when it lies flat, a side when it stands (a button on the right wall). */
  facing: "front" | "back" | "left" | "right" | "top" | "bottom";
  layer: number;
}

export type FitCheckId =
  | "fits" // every part inside the inner volume, no overlaps
  | "screen-window" // screen active area centred under the window within tolerance, bezel not cut
  | "buttons-reachable" // every button cap reaches through its hole with travel to spare
  | "connector-access" // USB etc. opening lines up with the receptacle, plug clearance kept
  | "min-wall" // every wall >= min (1.2 mm FDM)
  | "printable" // no overhang needing support except where listed
  | "watertight" // every STL is a closed 2-manifold with volume > 0
  | "no-intersection" // no part body intersects the shell
  | "size-match"; // generated bodies within 0.1 mm of the layout

export interface FitCheck {
  id: FitCheckId | string;
  ok: boolean;
  severity: "error" | "warning" | "info";
  /** What failed, why, how to fix (errors-say-why-and-fix), e.g. "The USB-C opening misses the XIAO's port by 1.2 mm. Why: … Fix: …". */
  message: string;
  parts?: string[];
}

export interface CaseReport {
  shape: CaseShape;
  enclosure: Enclosure; // the resolved config (defaults filled in)
  /** Overall outer size (w = x, h = y, d = z), mm, rounded to 0.1. */
  size_mm: { w: number; h: number; d: number };
  inner_mm: { w: number; h: number; d: number };
  wall_mm: number;
  mass_g?: number; // shell mass at the process's density (PLA 1.24 g/cm³ default)
  /** "fits": ≤ 110 × 70 × 30 mm (same limit as plan_device's pocket), "tight": ≤ 130 × 80 × 35, otherwise "no". */
  pocket: "fits" | "tight" | "no";
  ok: boolean; // no check with severity "error" failed
  checks: FitCheck[];
  placed: PlacedPart[];
  files: CaseFile[];
  /** sha256 of the resolved enclosure + parts' mechanical data; case/manifest.json stores it to spot stale files. */
  hash: string;
  /** What the case cannot promise (e.g. "snap-fit strength depends on the filament"). */
  notes: string[];
}

/** Meshes for the web Case view (GET /api/case/mesh). Positions are float32 xyz in the case frame, base64. */
export interface CaseMesh {
  hash: string;
  bodies: { body: string; kind: "shell" | "cap" | "part" | "insert"; color: string; positions: string; indices: string; explode: Vec3 }[];
}
