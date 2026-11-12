/**
 * Round 12: one picture per assembly step, with the case's own renderer (no browser): the shell
 * being filled with the parts already in it, the step's parts highlighted and lifted a little out
 * of their place (about to go in), the step's wires, the case opened like a book for the wires
 * between the shells, and the closed case at the end.
 */
import type { AssemblyPlan, AssemblyStep } from "./assembly.ts";
import type { Layout } from "./layout.ts";
import type { Mesh } from "./mesh.ts";
import { renderPng, type RenderItem, type View, VIEWS } from "./render.ts";
import type { Vec3 } from "./types.ts";

export interface StepMeshes {
  front: Mesh;
  back: Mesh;
  color: string;
  /** Button plungers / light pipes: body name ("cap-pet") → mesh. */
  inserts: Map<string, { mesh: Mesh; color: string }>;
  /** Part id → its envelope mesh in the case frame. */
  parts: Map<string, { mesh: Mesh; color: string }>;
  /** "part.pin" → position (case frame). */
  pins: Record<string, Vec3>;
  /** Exploded offsets for the closing step. */
  explode: { front: Vec3; back: Vec3 };
}

const HIGHLIGHT = "#FF7A1A";
const WIRE: Record<string, string> = { red: "#E5432F", black: "#30343B", yellow: "#F2D43A", blue: "#3D8BFF", white: "#F4F6F8", purple: "#9B6BFF", green: "#3CC47C", orange: "#FF9F2E", any: "#8B95A5" };

/** A square bar from a to b (w mm across), as a closed mesh with outward winding. */
export function barMesh(a: Vec3, b: Vec3, w = 0.9): Mesh {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(d[0], d[1], d[2]) || 1e-3;
  const dn: Vec3 = [d[0] / L, d[1] / L, d[2] / L];
  const ref: Vec3 = Math.abs(dn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u: Vec3 = [dn[1] * ref[2] - dn[2] * ref[1], dn[2] * ref[0] - dn[0] * ref[2], dn[0] * ref[1] - dn[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: Vec3 = [dn[1] * u[2] - dn[2] * u[1], dn[2] * u[0] - dn[0] * u[2], dn[0] * u[1] - dn[1] * u[0]];
  const pos = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    const x = i & 1, y = (i >> 1) & 1, z = (i >> 2) & 1;
    for (let k = 0; k < 3; k++) pos[3 * i + k] = a[k]! + d[k]! * x + u[k]! * w * (y - 0.5) + v[k]! * w * (z - 0.5);
  }
  const idx = new Uint32Array([0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6]);
  return { positions: pos, indices: idx };
}

function mergeMeshes(ms: Mesh[]): Mesh {
  const n = ms.reduce((s, m) => s + m.positions.length, 0);
  const t = ms.reduce((s, m) => s + m.indices.length, 0);
  const positions = new Float32Array(n);
  const indices = new Uint32Array(t);
  let po = 0;
  let io = 0;
  for (const m of ms) {
    positions.set(m.positions, po);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + po / 3;
    po += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/** A 180° turn about a line (the book's hinge): proper rotation, so the winding stays outward. */
function bookTurn(m: Mesh, hinge: AssemblyPlan["hinge"], h: number, zc: number): Mesh {
  const P = new Float32Array(m.positions.length);
  const alongY = hinge === "left" || hinge === "right";
  for (let i = 0; i < P.length; i += 3) {
    const x = m.positions[i]!, y = m.positions[i + 1]!, z = m.positions[i + 2]!;
    P[i] = alongY ? 2 * h - x : x;
    P[i + 1] = alongY ? y : 2 * h - y;
    P[i + 2] = 2 * zc - z;
  }
  return { positions: P, indices: m.indices };
}
function bookPoint(p: Vec3, hinge: AssemblyPlan["hinge"], h: number, zc: number): Vec3 {
  const alongY = hinge === "left" || hinge === "right";
  return [alongY ? 2 * h - p[0] : p[0], alongY ? p[1] : 2 * h - p[1], 2 * zc - p[2]];
}

function wireBars(steps: AssemblyStep["wires"], pins: Record<string, Vec3>, lift: Vec3, map: (end: string, p: Vec3) => Vec3): RenderItem[] {
  const out: RenderItem[] = [];
  for (const w of steps) {
    const a0 = pins[w.from];
    const b0 = pins[w.to];
    if (!a0 || !b0) continue;
    const a = map(w.from, a0);
    const b = map(w.to, b0);
    const a1: Vec3 = [a[0] + lift[0], a[1] + lift[1], a[2] + lift[2]];
    const b1: Vec3 = [b[0] + lift[0], b[1] + lift[1], b[2] + lift[2]];
    out.push({ mesh: mergeMeshes([barMesh(a, a1), barMesh(a1, b1), barMesh(b1, b)]), color: WIRE[w.color] ?? (w.color.startsWith("#") ? w.color : WIRE.any!) });
  }
  return out;
}

/** Render every step's picture: "assembly/step-01.png" → PNG bytes. Sets step.image. */
export function renderAssemblySteps(plan: AssemblyPlan, L: Layout, M: StepMeshes, size: { w: number; h: number } = { w: 720, h: 540 }): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const inShell = { front: new Set<string>(), back: new Set<string>() };
  const shellOf = new Map(plan.mounts.map((m) => [m.part, m.shell]));
  const insertShell = (name: string): "front" | "back" => (plan.order.front.includes(name) ? "front" : "back");
  const ob = L.outer;
  const gap = 8;
  const hingeAt = plan.hinge === "left" ? ob.min[0] - gap / 2 : plan.hinge === "right" ? ob.max[0] + gap / 2 : plan.hinge === "bottom" ? ob.min[1] - gap / 2 : ob.max[1] + gap / 2;
  const views: Record<string, View> = {
    "front-shell": { from: [0.3, 0.42, -1], up: [0, 1, 0] },
    "back-shell": { from: [0.3, 0.42, 1], up: [0, 1, 0] },
    "open-book": { from: [0.12, -0.55, 1], up: [0, 1, 0] },
    bench: VIEWS.front,
    closed: VIEWS.front,
    exploded: VIEWS.exploded,
  };
  for (const s of plan.steps) {
    const items: RenderItem[] = [];
    const hl = new Set(s.view.highlight);
    const cam = s.view.camera;
    const partItem = (id: string, offset?: Vec3): RenderItem | undefined => {
      const p = M.parts.get(id) ?? M.inserts.get(id);
      if (!p) return undefined;
      return { mesh: p.mesh, color: hl.has(id) ? HIGHLIGHT : p.color, ...(offset ? { offset } : {}) };
    };
    if (cam === "front-shell" || cam === "back-shell") {
      const shell = cam === "front-shell" ? "front" : "back";
      const open: Vec3 = shell === "front" ? [0, 0, -1] : [0, 0, 1];
      items.push({ mesh: shell === "front" ? M.front : M.back, color: M.color });
      for (const id of inShell[shell]) if (!hl.has(id)) items.push(partItem(id)!);
      const lift: Vec3 = [open[0] * s.view.explode, open[1] * s.view.explode, open[2] * s.view.explode];
      for (const id of hl) {
        const it = partItem(id, s.view.explode ? lift : undefined);
        if (it) items.push(it);
      }
      items.push(...wireBars(s.wires, M.pins, [open[0] * 3, open[1] * 3, open[2] * 3], (_e, p) => p));
    } else if (cam === "open-book") {
      items.push({ mesh: M.back, color: M.color });
      items.push({ mesh: bookTurn(M.front, plan.hinge, hingeAt, L.split), color: M.color });
      for (const shell of ["front", "back"] as const)
        for (const id of inShell[shell]) {
          const p = M.parts.get(id) ?? M.inserts.get(id);
          if (!p) continue;
          items.push({ mesh: shell === "front" ? bookTurn(p.mesh, plan.hinge, hingeAt, L.split) : p.mesh, color: hl.has(id) ? HIGHLIGHT : p.color });
        }
      items.push(...wireBars(s.wires, M.pins, [0, 0, 4], (end, p) => (shellOf.get(end.split(".")[0]!) === "front" ? bookPoint(p, plan.hinge, hingeAt, L.split) : p)));
    } else if (cam === "exploded") {
      items.push({ mesh: M.front, color: M.color, offset: M.explode.front }, { mesh: M.back, color: M.color, offset: M.explode.back });
      // closing: everything inside; checking the print: the empty shells
      if (s.action === "close" || s.action === "screw") {
        for (const id of [...inShell.front]) {
          const p = M.parts.get(id) ?? M.inserts.get(id);
          if (p) items.push({ mesh: p.mesh, color: p.color, offset: M.explode.front });
        }
        for (const id of [...inShell.back]) {
          const p = M.parts.get(id) ?? M.inserts.get(id);
          if (p) items.push({ mesh: p.mesh, color: p.color });
        }
      } else for (const [name, p] of M.inserts) items.push({ mesh: p.mesh, color: p.color, offset: insertShell(name) === "front" ? M.explode.front : [0, 0, 0] });
    } else if (cam === "closed") {
      items.push({ mesh: M.front, color: M.color }, { mesh: M.back, color: M.color });
      for (const [, p] of M.inserts) items.push({ mesh: p.mesh, color: p.color });
    } else {
      // bench: the step's parts on their own, or the wires laid out side by side
      for (const id of hl) {
        const it = partItem(id);
        if (it) items.push(it);
      }
      if (!items.length && s.wires.length) {
        s.wires.forEach((w, i) => items.push({ mesh: barMesh([0, -i * 4, 0], [w.length_mm, -i * 4, 0], 1.6), color: WIRE[w.color] ?? (w.color.startsWith("#") ? w.color : WIRE.any!) }));
      }
      if (!items.length) items.push({ mesh: M.front, color: M.color }, { mesh: M.back, color: M.color, offset: M.explode.back });
    }
    const view = s.wires.length && cam === "bench" && !hl.size ? { from: [0, 0, 1] as Vec3, up: [0, 1, 0] as Vec3 } : views[cam]!;
    const path = `assembly/step-${String(s.n).padStart(2, "0")}.png`;
    files.set(path, renderPng(items.filter(Boolean), view, size.w, size.h));
    s.image = path;
    // what is in each shell after this step
    if (["place", "press-fit", "tape", "glue"].includes(s.action) && (s.shell === "front" || s.shell === "back"))
      for (const id of s.parts) {
        const sh = M.inserts.has(id) ? insertShell(id) : (shellOf.get(id) ?? s.shell);
        inShell[sh].add(id);
      }
  }
  return files;
}
