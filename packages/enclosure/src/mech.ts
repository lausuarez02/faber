/**
 * Part mechanics (decision 0004, R1): a part.json `mechanical` block resolved into what the layout
 * needs, in a centred right-handed "local" frame:
 *
 *   L = (x - w/2, h/2 - y, z)      (part frame x right, y DOWN, z up → local x right, y UP, z up)
 *
 * so every case placement is a proper rotation R (det +1) plus a translation: case = R · L + T.
 */
import type { MechFeature, Mechanical, PartSpec } from "@fabwright/sim-core";
import type { Vec3 } from "./types.ts";

export type Mat3 = [Vec3, Vec3, Vec3]; // rows

export interface FootprintPart {
  shape: "rect" | "round";
  /** Local frame: rect = centre + half sizes; round = centre + radius. */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  r: number;
}

export interface LocalFeature {
  id: string;
  kind: MechFeature["kind"];
  /** Unit normal in the local frame. */
  n: Vec3;
  /** Centre of the feature's outer face (tip), local frame (protrude included). */
  tip: Vec3;
  shape: "rect" | "round";
  /** Size on the face: u along the face's horizontal axis, v along the other one (local frame axes noted in `uAxis`/`vAxis`). */
  u: number;
  v: number;
  uAxis: Vec3;
  vAxis: Vec3;
  protrude: number;
  bezel: number;
  travel: number;
  plugClearance: number;
  connector?: string;
  expose: boolean;
  /** Pokes through the wall (PIR dome, pot shaft, slide lever, 5 mm LED dome). */
  passThrough: boolean;
  /** Round 13: a camera lens' diagonal field of view (degrees). */
  fov?: number;
  /** Round 15, access: the opening's rim overlaps the object by this much each side (snap pocket). */
  lip?: number;
  description?: string;
}

export interface PartMech {
  id: string;
  type: string;
  name: string;
  category: string;
  /** Body box (dimensions_mm). */
  w: number;
  h: number;
  d: number;
  pcb: number;
  keepTop: number;
  keepBottom: number;
  soft: boolean;
  footprint: FootprintPart[];
  holes: { x: number; y: number; d: number }[]; // local frame
  features: LocalFeature[];
  /** The part.json had a mechanical block (false = box from dimensions_mm only). */
  hasData: boolean;
  source: string;
  /** Round 17: a magnetic switch's operate / release field (typical, mT), from mechanical.magnet_switch. */
  magnetSwitch?: { operate_mT: number; release_mT: number; source?: string };
}

const EXPOSE_DEFAULT = new Set(["screen", "button", "switch", "knob", "connector", "led", "sensor-window", "grille", "camera", "access"]);
const PASS_THROUGH = new Set(["knob", "switch", "sensor-window", "led"]);

const NORMALS: Record<MechFeature["face"], Vec3> = {
  "+z": [0, 0, 1],
  "-z": [0, 0, -1],
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
  "+y": [0, -1, 0], // part +y is DOWN in the drawing → local -y
  "-y": [0, 1, 0],
};

export function resolveMech(id: string, spec: PartSpec): PartMech {
  const dim = spec.dimensions_mm ?? { w: 10, h: 10, d: 5 };
  const m: Mechanical = spec.mechanical ?? {};
  const { w, h, d } = dim;
  const toL = (x: number, y: number): [number, number] => [x - w / 2, h / 2 - y];
  const footprint: FootprintPart[] = [];
  if (m.outline_parts?.length) {
    for (const p of m.outline_parts) {
      if (p.shape === "rect") {
        const [cx, cy] = toL(p.x + p.w / 2, p.y + p.h / 2);
        footprint.push({ shape: "rect", cx, cy, hw: p.w / 2, hh: p.h / 2, r: 0 });
      } else {
        const [cx, cy] = toL(p.x, p.y);
        footprint.push({ shape: "round", cx, cy, hw: p.d / 2, hh: p.d / 2, r: p.d / 2 });
      }
    }
  } else if (m.outline === "round") {
    footprint.push({ shape: "round", cx: 0, cy: 0, hw: w / 2, hh: w / 2, r: w / 2 });
  } else {
    footprint.push({ shape: "rect", cx: 0, cy: 0, hw: w / 2, hh: h / 2, r: 0 });
  }
  const features: LocalFeature[] = (m.features ?? []).map((f) => localFeature(f, w, h, d));
  return {
    id,
    type: spec.id,
    name: spec.name,
    category: spec.category,
    w,
    h,
    d,
    pcb: m.pcb_mm ?? 0,
    keepTop: m.keepout_top_mm ?? 0,
    keepBottom: m.keepout_bottom_mm ?? 0,
    soft: m.soft ?? false,
    footprint,
    holes: (m.mounting_holes ?? []).map((hole) => {
      const [x, y] = toL(hole.x, hole.y);
      return { x, y, d: hole.d };
    }),
    features,
    hasData: !!spec.mechanical,
    ...(m.magnet_switch ? { magnetSwitch: m.magnet_switch } : {}),
    source: m.source ?? (spec.mechanical ? "part.json" : "dimensions_mm only (no mechanical block)"),
  };
}

function localFeature(f: MechFeature, w: number, h: number, d: number): LocalFeature {
  const n = NORMALS[f.face];
  const shape = f.shape ?? (f.d && !f.w ? "round" : "rect");
  const u = shape === "round" ? (f.d ?? f.w ?? 2) : (f.w ?? f.d ?? 2);
  const v = shape === "round" ? (f.d ?? f.h ?? 2) : (f.h ?? f.d ?? 2);
  const protrude = f.protrude_mm ?? 0;
  // Point on the face, local frame.
  let x = f.x - w / 2;
  let y = h / 2 - f.y;
  let z = f.z ?? (f.face === "-z" ? 0 : d);
  if (f.face === "+x") x = w / 2;
  if (f.face === "-x") x = -w / 2;
  if (f.face === "+y") y = -h / 2;
  if (f.face === "-y") y = h / 2;
  if (f.face === "+z") z = f.z ?? d;
  if (f.face === "-z") z = f.z ?? 0;
  const tip: Vec3 = [x + n[0] * protrude, y + n[1] * protrude, z + n[2] * protrude];
  // Face axes: ±z faces: u = x, v = y; ±y faces: u = x, v = z; ±x faces: u = y, v = z.
  const uAxis: Vec3 = f.face === "+x" || f.face === "-x" ? [0, 1, 0] : [1, 0, 0];
  const vAxis: Vec3 = f.face === "+z" || f.face === "-z" ? [0, 1, 0] : [0, 0, 1];
  const expose = f.expose ?? EXPOSE_DEFAULT.has(f.kind);
  return {
    id: f.id,
    kind: f.kind,
    n,
    tip,
    shape,
    u,
    v,
    uAxis,
    vAxis,
    protrude,
    bezel: f.bezel_mm ?? 0,
    travel: f.travel_mm ?? 0,
    plugClearance: f.plug_clearance_mm ?? (f.kind === "connector" ? 1.5 : 0),
    ...(f.connector ? { connector: f.connector } : {}),
    expose,
    passThrough: PASS_THROUGH.has(f.kind) && protrude > 0,
    ...(f.kind === "camera" ? { fov: f.fov_deg ?? 66 } : {}),
    ...(f.lip_mm ? { lip: f.lip_mm } : {}),
    ...(f.description ? { description: f.description } : {}),
  };
}

/** Local z range of the envelope (keep-outs included). */
export function envelopeZ(p: PartMech): [number, number] {
  return [-p.keepBottom, p.d + p.keepTop];
}

// ------------------------------------------------------------------ rotations

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i]![j] = a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!;
  return r;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
}

export const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export function rotZ(deg: number): Mat3 {
  const c = Math.round(Math.cos((deg * Math.PI) / 180));
  const s = Math.round(Math.sin((deg * Math.PI) / 180));
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

/** Rotation by a multiple of 90° about a unit axis (an axis of the frame). */
export function rotAbout(axis: Vec3, deg: number): Mat3 {
  const c = Math.round(Math.cos((deg * Math.PI) / 180));
  const s = Math.round(Math.sin((deg * Math.PI) / 180));
  const [x, y, z] = axis;
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** All 24 proper rotations that map frame axes to frame axes. */
export const ROTATIONS: Mat3[] = (() => {
  const out: Mat3[] = [];
  const axes: Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const a of axes)
    for (const b of axes) {
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] !== 0) continue;
      const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      // columns = images of local x, y, z
      out.push([
        [a[0], b[0], c[0]],
        [a[1], b[1], c[1]],
        [a[2], b[2], c[2]],
      ]);
    }
  return out;
})();

export function eqv(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
}

/** Case face → outward unit normal (case frame: +x right, +y up, +z towards the viewer). */
export const FACE_DIR: Record<"front" | "back" | "left" | "right" | "top" | "bottom", Vec3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

/** "Up" and "right" on a face as you look straight at it from outside (R3). */
export function faceAxes(face: keyof typeof FACE_DIR): { right: Vec3; up: Vec3 } {
  const n = FACE_DIR[face];
  const up: Vec3 = face === "top" ? [0, 0, -1] : face === "bottom" ? [0, 0, 1] : [0, 1, 0];
  // looking at the face means looking along -n; right = (-n) × up
  const f: Vec3 = [-n[0], -n[1], -n[2]];
  const right: Vec3 = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  return { right, up };
}

export function dirToFace(v: Vec3): keyof typeof FACE_DIR | undefined {
  for (const [k, d] of Object.entries(FACE_DIR)) if (eqv(d, v)) return k as keyof typeof FACE_DIR;
  return undefined;
}
