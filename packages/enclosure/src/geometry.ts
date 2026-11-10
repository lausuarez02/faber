/**
 * Build the case bodies in OpenCascade (B-rep) from a layout: the outer shape, the cavity (a true
 * 2D offset of the plan, so the wall is uniform), the front / back split with a snap lip or M2
 * bosses, openings, button plungers, light pipes, ribs, standoffs, the cell cradle and the tab.
 * Everything is in the case frame (mm).
 */
import { apply, type Mat3, ROTATIONS } from "./mech.ts";
import type { Layout, Opening } from "./layout.ts";
import { planBounds, planDrawing } from "./plan.ts";
import { occt, type Replicad } from "./occt.ts";
import type { CaseFile, Vec3 } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Solid = any;

export interface Body {
  /** "front", "back", "cap-<part>", "light-pipe-<part>", "belt-clip". */
  name: string;
  kind: "shell" | "cap" | "light-pipe" | "clip";
  shape: Solid;
  color: string;
  print: NonNullable<CaseFile["print"]>;
  /** Case-frame direction that points up (away from the bed) when this body is printed. */
  up: Vec3;
  /** Direction this body moves in the exploded view (mm). */
  explode: Vec3;
}

export interface Built {
  bodies: Body[];
  envelopes: { id: string; shape: Solid; color: string }[];
  outer: Solid;
  cavity: Solid;
  rf: number;
  rfBack: number;
  notes: string[];
  screws?: { count: number; size: string; inserts: string };
}

const EULER: { R: Mat3; a: number; b: number; c: number }[] = (() => {
  const out: { R: Mat3; a: number; b: number; c: number }[] = [];
  const rx = (d: number): Mat3 => { const c = Math.round(Math.cos((d * Math.PI) / 180)); const s = Math.round(Math.sin((d * Math.PI) / 180)); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
  const ry = (d: number): Mat3 => { const c = Math.round(Math.cos((d * Math.PI) / 180)); const s = Math.round(Math.sin((d * Math.PI) / 180)); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
  const rz = (d: number): Mat3 => { const c = Math.round(Math.cos((d * Math.PI) / 180)); const s = Math.round(Math.sin((d * Math.PI) / 180)); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
  const mul = (p: Mat3, q: Mat3): Mat3 => p.map((row) => [0, 1, 2].map((j) => row[0]! * q[0]![j]! + row[1]! * q[1]![j]! + row[2]! * q[2]![j]!)) as Mat3;
  for (const a of [0, 90, 180, 270]) for (const b of [0, 90, 180, 270]) for (const c of [0, 90, 180, 270]) out.push({ R: mul(rz(c), mul(ry(b), rx(a))), a, b, c });
  return out;
})();

/** Rotate a shape by an axis-aligned rotation matrix (about the origin). */
export function orient(shape: Solid, R: Mat3): Solid {
  const e = EULER.find((x) => x.R.every((row, i) => row.every((v, j) => Math.abs(v - R[i]![j]!) < 1e-9)));
  if (!e) throw new Error("orient: not an axis rotation");
  let s = shape;
  if (e.a) s = s.rotate(e.a, [0, 0, 0], [1, 0, 0]);
  if (e.b) s = s.rotate(e.b, [0, 0, 0], [0, 1, 0]);
  if (e.c) s = s.rotate(e.c, [0, 0, 0], [0, 0, 1]);
  return s;
}

/** Rotation taking local x → u, y → v (or -v), z → n. */
function frameR(u: Vec3, v: Vec3, n: Vec3): Mat3 {
  const cross: Vec3 = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]]; // u × n = -(n × u)
  const y: Vec3 = [-cross[0], -cross[1], -cross[2]]; // n × u keeps det +1
  void v;
  const R: Mat3 = [
    [u[0], y[0], n[0]],
    [u[1], y[1], n[1]],
    [u[2], y[2], n[2]],
  ];
  if (!ROTATIONS.some((q) => q.every((row, i) => row.every((val, j) => Math.abs(val - R[i]![j]!) < 1e-9)))) throw new Error("frameR: axes are not orthonormal");
  return R;
}

function tryFillet(solid: Solid, r: number, z: number): Solid | undefined {
  try {
    return solid.fillet(r, (e: Solid) => e.inPlane("XY", z));
  } catch {
    return undefined;
  }
}

/** Extrude the plan from z0 to z1 and round the top perimeter with radTop, the bottom with radBot (falls back to smaller radii). */
function roundedSlab(r: Replicad, drawing: Solid, z0: number, z1: number, radTop: number, radBot = radTop): { solid: Solid; r: number; rBack: number } {
  const base = drawing.sketchOnPlane("XY", z0).extrude(z1 - z0);
  for (const k of [1, 0.75, 0.5, 0.3]) {
    const a = radTop * k < 0.05 ? base : tryFillet(base, radTop * k, z1);
    const b = a && radBot * k >= 0.05 ? tryFillet(a, radBot * k, z0) : a;
    if (b) return { solid: b, r: radTop * k < 0.05 ? 0 : radTop * k, rBack: radBot * k < 0.05 ? 0 : radBot * k };
  }
  void r;
  return { solid: base, r: 0, rBack: 0 };
}

/**
 * A curved shape's outer body: the outer plan extruded, domed by a sphere on each face (pebble),
 * every front / back rim edge rounded in 3D with one large fillet, then the domes cut flat at their
 * plateau. Falls back to smaller radii when OpenCascade cannot fillet the larger one.
 */
export function roundedBody(r: Replicad, L: Layout, zOutB: number, zOutF: number): { solid: Solid; r: number; rBack: number } {
  const d = L.dome;
  const cf = d?.front.crown ?? 0;
  const cb = d?.back.crown ?? 0;
  let base = planDrawing(r, L.plan, L.params.wall_mm).sketchOnPlane("XY", zOutB - cb - 1).extrude(zOutF - zOutB + cf + cb + 2);
  const sphere = (dm: NonNullable<Layout["dome"]>["front"], z0: number, sign: 1 | -1) => {
    const zc = z0 - sign * Math.sqrt(dm.R * dm.R - dm.S * dm.S);
    // turned so the sphere's poles and seam lie far outside the body (a seam on the face would be filleted)
    return r.makeSphere(dm.R).rotate(90, [0, 0, 0], [1, 0, 0]).translate([dm.x, dm.y, zc]);
  };
  if (d && cf > 0) base = base.intersect(sphere(d.front, zOutF, 1));
  else base = base.intersect(r.makeBox([-1e3, -1e3, -1e3], [1e3, 1e3, zOutF]));
  if (d && cb > 0) base = base.intersect(sphere(d.back, zOutB, -1));
  else base = base.intersect(r.makeBox([-1e3, -1e3, zOutB], [1e3, 1e3, 1e3]));
  const zMid = (zOutF + zOutB) / 2;
  const span = (zOutF - zOutB) / 2;
  for (const k of [1, 0.85, 0.7, 0.55, 0.4, 0.25]) {
    const rT = L.rf * k;
    const rB = L.rfBack * k;
    try {
      // the front and back rim edges only (a seam running front to back is not rounded)
      let s = base.fillet((e: Solid) => {
        const bb = e.boundingBox;
        if (bb.depth > span) return null;
        return bb.center[2] > zMid ? rT : rB;
      });
      s = s.intersect(r.makeBox([-1e3, -1e3, zOutB - cb], [1e3, 1e3, zOutF + cf]));
      if (r.measureVolume(s) > 0) return { solid: s, r: rT, rBack: rB };
    } catch {
      // try a smaller radius
    }
  }
  return { solid: base.intersect(r.makeBox([-1e3, -1e3, zOutB - cb], [1e3, 1e3, zOutF + cf])), r: 0, rBack: 0 };
}

function cutterFor(r: Replicad, o: Opening, len: number): Solid {
  const z0 = -0.8;
  let tool: Solid;
  if (o.shape === "round") tool = r.makeCylinder(o.u / 2, len - z0, [0, 0, z0], [0, 0, 1]);
  else {
    const c = Math.min(o.corner, Math.min(o.u, o.v) / 2 - 0.01);
    const d = c > 0.05 ? r.drawRoundedRectangle(o.u, o.v, c) : r.drawRectangle(o.u, o.v);
    tool = d.sketchOnPlane("XY", z0).extrude(len - z0);
  }
  return orient(tool, frameR(o.uAxis, o.vAxis, o.n)).translate(o.at);
}

function cylAlong(r: Replicad, d: number, from: number, to: number, base: Vec3, n: Vec3): Solid {
  const R = frameR(Math.abs(n[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1], [0, 1, 0], n);
  return orient(r.makeCylinder(d / 2, to - from, [0, 0, from], [0, 0, 1]), R).translate(base);
}

export async function buildCase(L: Layout): Promise<Built> {
  const r = await occt();
  const t = L.params.wall_mm;
  const tol = L.params.tolerance_mm;
  const notes: string[] = [];
  const cav2d = () => planDrawing(r, L.plan, 0);
  const zOutF = L.zFront + t;
  const zOutB = L.zBack - t;
  const outerR = L.kind === "rrect" ? roundedSlab(r, planDrawing(r, L.plan, t), zOutB, zOutF, L.rf, L.rfBack) : roundedBody(r, L, zOutB, zOutF);
  const outer = outerR.solid;
  const rf = outerR.r;
  const rfBack = outerR.rBack;
  if (rf + 1e-6 < L.rf) notes.push(`The rounded front / back edge is ${rf.toFixed(1)} mm instead of ${L.rf.toFixed(1)} mm (OpenCascade could not fillet the larger radius on this outline).`);
  if (L.dome) notes.push(`Domed faces: the front rises ${L.dome.front.crown.toFixed(1)} mm and the back ${L.dome.back.crown.toFixed(1)} mm above the flat wall, with a flat ${(2 * L.dome.front.plateau).toFixed(0)} mm land around the window and a flat ${(2 * L.dome.back.plateau).toFixed(0)} mm pad on the back (each shell prints on its flat).`);
  const cavity = roundedSlab(r, cav2d(), L.zBack, L.zFront, Math.max(0, rf - t), Math.max(0, rfBack - t)).solid;
  let shell = outer.cut(cavity);

  // tab (keychain / lanyard), part of the back shell
  if (L.tab) {
    const ob = planBounds(L.plan, t);
    const tb = L.tab;
    const top = tb.y + tb.h / 2;
    const bottom = ob.maxY - t - 1.5; // overlaps the wall
    const h = top - bottom;
    const rr = Math.min(tb.w / 2 - 0.01, 4);
    let tabS = r.drawRoundedRectangle(tb.w, h, rr).translate(tb.x, (top + bottom) / 2).sketchOnPlane("XY", tb.z0).extrude(tb.t);
    tabS = tabS.cut(r.makeCylinder(tb.hole / 2, tb.t + 2, [tb.x, top - tb.hole / 2 - 1.8, tb.z0 - 1], [0, 0, 1]));
    shell = shell.fuse(tabS.cut(cavity));
  }

  // part envelopes (bodies only, keep-outs not included) for the assembly STEP and the intersection check
  const envelopes: Built["envelopes"] = [];
  for (const p of L.placed) {
    const m = p.mech;
    const cut = Math.max(0, ...m.features.filter((f) => f.passThrough && f.n[2] > 0.5).map((f) => f.protrude));
    const h = Math.max(0.3, m.d - cut);
    let s: Solid | undefined;
    for (const fp of m.footprint) {
      const piece = fp.shape === "round" ? r.makeCylinder(fp.r, h, [fp.cx, fp.cy, 0], [0, 0, 1]) : r.makeBox([fp.cx - fp.hw, fp.cy - fp.hh, 0], [fp.cx + fp.hw, fp.cy + fp.hh, h]);
      s = s ? s.fuse(piece) : piece;
    }
    // mounting holes go through the board: the case's locating pins sit in them
    for (const hole of m.holes) {
      try {
        s = s!.cut(r.makeCylinder(hole.d / 2, h + 2, [hole.x, hole.y, -1], [0, 0, 1]));
      } catch {
        // keep the solid board (the intersection check is then stricter there)
      }
    }
    for (const f of m.features.filter((x) => x.passThrough && x.n[2] > 0.5)) s = s!.fuse(r.makeCylinder(Math.min(f.u, f.v) / 2, f.protrude, [f.tip[0], f.tip[1], f.tip[2] - f.protrude], [0, 0, 1]));
    envelopes.push({ id: m.id, shape: orient(s, p.R).translate(p.T), color: partColor(m.category) });
  }
  const ob = shell.boundingBox.bounds as [Vec3, Vec3];
  const big = (z0: number, z1: number) => r.makeBox([ob[0][0] - 20, ob[0][1] - 20, z0], [ob[1][0] + 20, ob[1][1] + 20, z1]);
  let front = shell.intersect(big(L.split, ob[1][2] + 5));
  let back = shell.intersect(big(ob[0][2] - 5, L.split));
  const clip = (s: Solid) => s.intersect(outer);

  // closure
  if (L.lip) {
    const lip = L.lip;
    const outRing = (a: number, b: number) => planDrawing(r, L.plan, a).cut(planDrawing(r, L.plan, b));
    let lipS = outRing(-tol, -tol - lip.t).sketchOnPlane("XY", L.split - lip.h).extrude(lip.h + 0.01);
    lipS = lipS.fuse(outRing(t * 0.5, -tol - lip.t).sketchOnPlane("XY", L.split).extrude(0.8));
    if (lip.groove > 0.05) {
      lipS = lipS.fuse(outRing(-tol + lip.bead, -tol - 0.05).sketchOnPlane("XY", L.split - lip.h + 0.3).extrude(0.5));
      back = back.cut(outRing(lip.groove, -0.05).sketchOnPlane("XY", L.split - lip.h + 0.15).extrude(0.8));
    } else notes.push(`The ${t} mm wall is too thin for a snap groove (it would leave less than 1.2 mm), so the lip is a friction fit; use wall_mm 1.8 or more for a snap bead, or closure "screws".`);
    // the lip stops where a part sits against the wall (a USB port, a button)
    for (const p of L.placed) if (p.max[2] > L.split - lip.h - 0.5 && p.min[2] < L.split + 0.8) lipS = lipS.cut(r.makeBox([p.bodyMin[0] - 0.4, p.bodyMin[1] - 0.4, L.split - lip.h - 1], [p.bodyMax[0] + 0.4, p.bodyMax[1] + 0.4, L.split + 1]));
    front = front.fuse(clip(lipS));
  }
  let screws: Built["screws"];
  if (L.bosses.length) {
    for (const b of L.bosses) {
      const fb = r.makeCylinder(b.od / 2, L.zFront + 0.3 - L.split, [b.x, b.y, L.split], [0, 0, 1]).cut(r.makeCylinder(1.6, 4.5, [b.x, b.y, L.split - 0.01], [0, 0, 1]));
      front = front.fuse(clip(fb));
      let bb = clip(r.makeCylinder(b.od / 2, L.split - (L.zBack - 0.3), [b.x, b.y, L.zBack - 0.3], [0, 0, 1]));
      back = back.fuse(bb);
      bb = r.makeCylinder(1.1, L.split - zOutB + 2, [b.x, b.y, zOutB - 1], [0, 0, 1]).fuse(r.makeCylinder(2.1, 2.5, [b.x, b.y, zOutB - 1], [0, 0, 1]));
      back = back.cut(bb);
    }
    const len = L.split - zOutB - 1.5 + 3;
    const std = [4, 5, 6, 8, 10, 12, 14, 16, 20, 25].find((s) => s >= len - 0.5 && s <= len + 1.5) ?? Math.round(len);
    screws = { count: L.bosses.length, size: `M2 x ${std} mm pan head`, inserts: "M2 x 3 mm brass heat-set inserts (3.2 mm hole), pressed into the front bosses with a soldering iron at ~220 °C" };
  }
  for (const rib of L.ribs) {
    const z0 = rib.shell === "front" ? rib.min[2] : rib.min[2] - 0.3;
    const z1 = rib.shell === "front" ? rib.max[2] + 0.3 : rib.max[2];
    const box = clip(r.makeBox([rib.min[0], rib.min[1], z0], [rib.max[0], rib.max[1], z1]));
    if (rib.shell === "front") front = front.fuse(box);
    else back = back.fuse(box);
  }
  for (const p of L.posts) {
    const z0 = p.shell === "back" ? p.z0 - 0.3 : p.z0;
    const z1 = p.shell === "front" ? p.z1 + 0.3 : p.z1;
    let s = r.makeCylinder(p.d / 2, z1 - z0, [p.x, p.y, z0], [0, 0, 1]);
    if (p.pin_d) s = s.fuse(p.shell === "back" ? r.makeCylinder(p.pin_d / 2, 1.5, [p.x, p.y, z1], [0, 0, 1]) : r.makeCylinder(p.pin_d / 2, 1.5, [p.x, p.y, z0 - 1.5], [0, 0, 1]));
    if (p.shell === "front") front = front.fuse(clip(s));
    else back = back.fuse(clip(s));
  }
  for (const c of L.cradles) {
    const z0 = L.zBack - 0.3;
    const z1 = L.zBack + c.h;
    const ring = r.makeBox([c.min[0] - c.wall, c.min[1] - c.wall, z0], [c.max[0] + c.wall, c.max[1] + c.wall, z1]).cut(r.makeBox([c.min[0], c.min[1], z0 - 1], [c.max[0], c.max[1], z1 + 1]));
    back = back.fuse(clip(ring));
  }

  // openings through whichever shell they cross
  const bodies: Body[] = [];
  const color = L.params.color;
  for (const o of L.openings) {
    const len = o.depth + 0.8;
    if (o.spot) {
      // flat recess on the outside round the port: from depth (the thinned wall) outwards
      const spotTool = orient(r.drawRoundedRectangle(o.u + 4, o.v + 4, Math.min(2, (o.v + 4) / 2 - 0.01)).sketchOnPlane("XY", o.depth).extrude(o.spot + 6), frameR(o.uAxis, o.vAxis, o.n)).translate(o.at);
      front = front.cut(spotTool);
      back = back.cut(spotTool);
    }
    const tools: Solid[] = o.holes ? o.holes.map((h) => cylAlong(r, h.d, -0.8, len, h.at, o.n)) : [cutterFor(r, o, len)];
    for (const tool of tools) {
      front = front.cut(tool);
      back = back.cut(tool);
    }
    if (o.insert) {
      const ins = o.insert;
      if (ins.kind === "cap") {
        const s = cylAlong(r, ins.flange_d, 0, ins.flange_mm, ins.base, o.n).fuse(cylAlong(r, ins.d, 0, ins.length, ins.base, o.n));
        bodies.push({ name: `cap-${o.part}`, kind: "cap", shape: s, color: shade(color, -0.25), print: { face_down: "flat", supports: false, note: "standing on its flange, 0.12 mm layers" }, up: o.n, explode: [o.n[0] * 14, o.n[1] * 14, o.n[2] * 14] });
      } else {
        const s = cylAlong(r, ins.d, 0.3, 0.3 + ins.length, ins.base, o.n).fuse(cylAlong(r, ins.flange_d, o.standoff - 0.85, o.standoff - 0.05, ins.base, o.n));
        bodies.push({ name: `light-pipe-${o.part}`, kind: "light-pipe", shape: s, color: "#E8F4FF", print: { face_down: "flat", supports: false, note: "standing on its flange; clear PETG or clear resin; polish both ends" }, up: o.n, explode: [o.n[0] * 12, o.n[1] * 12, o.n[2] * 12] });
      }
    }
  }
  const sep = Math.max(12, (ob[1][2] - ob[0][2]) * 0.9);
  bodies.unshift(
    { name: "front", kind: "shell", shape: front, color, print: { face_down: "front", supports: false, note: "front face on the bed (the window side down), open side up" }, up: [0, 0, -1], explode: [0, 0, sep] },
    { name: "back", kind: "shell", shape: back, color, print: { face_down: "back", supports: false, note: "back face on the bed, open side up" }, up: [0, 0, 1], explode: [0, 0, -sep] },
  );
  if (L.params.belt_clip) {
    const H = L.outer.h;
    const lenC = Math.min(50, Math.max(20, H * 0.6));
    const yTop = L.outer.max[1] - Math.max(4, H * 0.15);
    const zb = L.outer.min[2];
    let clipS = r.makeBox([-9, yTop - 7, zb - 3], [9, yTop, zb]);
    clipS = clipS.fuse(r.makeBox([-9, yTop - lenC, zb - 5], [9, yTop, zb - 3]));
    clipS = clipS.fuse(r.makeBox([-9, yTop - lenC, zb - 5], [9, yTop - lenC + 2, zb - 2.2]));
    bodies.push({ name: "belt-clip", kind: "clip", shape: clipS, color: shade(color, -0.35), print: { face_down: "flat", supports: false, note: "print on its side (the L profile flat on the bed) so the layers run along the spring; PETG; glue to the back with CA or VHB tape" }, up: [1, 0, 0], explode: [0, 0, -sep * 1.8] });
    notes.push("The belt clip is a separate PETG part glued to the back (CA glue or 3M VHB). It is not screwed: screws would hit the cell behind the back wall.");
  }

  void apply;
  return { bodies, envelopes, outer, cavity, rf, rfBack, notes, ...(screws ? { screws } : {}) };
}

export function partColor(category: string): string {
  return { board: "#2F6B4F", display: "#1C2430", sensor: "#3B5BA5", power: "#C9A227", input: "#7A7F8A", output: "#B5483B", communication: "#4B7F8C", motor: "#6B6F76" }[category] ?? "#5A6070";
}

export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k))));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
