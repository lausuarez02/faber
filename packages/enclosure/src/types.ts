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
  | "camera-view" // round 14: a camera lens has its hole, and the field of view clears the wall
  | "held-object" // round 15: a held object's room, opening and walls
  | "held-sensor" // round 15: a sensor that must sit next to a held object
  | "held-magnet" // round 17: a magnet glued on the held object clears the socket
  | "edge-radius" // round 17: the front / back rims got the radius planned (fillet, lofted round-over, chamfer)
  | "min-wall" // every wall >= min (1.2 mm FDM)
  | "printable" // no overhang needing support except where listed
  | "watertight" // every STL is a closed 2-manifold with volume > 0
  | "no-intersection" // no part body intersects the shell
  | "size-match"; // generated bodies within 0.1 mm of the layout

export interface FitCheck {
  id: FitCheckId | string;
  ok: boolean;
  severity: "error" | "warning" | "info";
  /** Round 12 (assembly checks): the sizes and positions behind it, mm. */
  facts?: Record<string, number | string>;
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
  /** Volume enclosed by the outer surface (cm³): what the packer minimises. */
  volume_cm3?: number;
  /** Thickness first: "fits" (comfortable) ≤ 18 mm thick within 110 × 70 mm, "tight" ≤ 22 mm within 130 × 80, otherwise "no" (bulky). */
  pocket: "fits" | "tight" | "no";
  ok: boolean; // no check with severity "error" failed
  checks: FitCheck[];
  placed: PlacedPart[];
  files: CaseFile[];
  /** sha256 of the resolved enclosure + parts' mechanical data; case/manifest.json stores it to spot stale files. */
  hash: string;
  /** What the case cannot promise (e.g. "snap-fit strength depends on the filament"). */
  notes: string[];
  /** Round 7: a fixed size (size_mm / depth_mm) and how the parts fit it; auto sizes report fits: true. */
  fit?: { fits: boolean; needed_mm: { w: number; h: number; d: number }; asked_mm?: { w?: number; h?: number; d?: number }; scale: number };
  /** Round 7: the outer outline seen from the front (case frame, mm): the real silhouette, for previews. */
  outline_mm?: [number, number][];
  /** Round 12: how it goes together: the plan (case/assembly/plan.json), a picture per step, the side it opens on like a book, the order per shell, and how many of its checks failed. */
  assembly?: { steps: number; plan: string; images: string[]; hinge: string; order: { front: string[]; back: string[] }; errors: number; warnings: number };
  /** Round 8: the distribution proposal the case was built from (enclosure.layout; "auto" = balanced), its fill ratio (parts' volume / cavity) and layers. */
  /** Round 15: what the case holds that is not electronics (a tin, a card deck): its room, opening, walls and how to check its size. */
  held?: import("./held.ts").HeldReport[];
  layout?: { goal: string; asked: string; label: string; fill_ratio: number; layers: { index: number; z_mm: [number, number]; parts: string[] }[]; why: string[]; source: string };
}

/** Meshes for the web Case view (GET /api/case/mesh). Positions are float32 xyz in the case frame, base64. */
export interface CaseMesh {
  hash: string;
  bodies: { body: string; kind: "shell" | "cap" | "part" | "insert"; color: string; positions: string; indices: string; explode: Vec3 }[];
}
