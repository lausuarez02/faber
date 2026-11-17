/**
 * Triangle meshes from OpenCascade bodies: welded (shared vertices), binary STL, 3MF (zip + XML,
 * one named, coloured object per body), and the checks every printable file must pass: a closed
 * 2-manifold (each edge used by exactly two triangles, in opposite directions) with volume > 0.
 */
import { zipSync, strToU8 } from "fflate";

export interface Mesh {
  positions: Float32Array; // xyz
  indices: Uint32Array; // 3 per triangle
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function meshOf(shape: any, tolerance = 0.05, angular = 0.3): Mesh {
  const m = shape.mesh({ tolerance, angularTolerance: angular });
  return weld(m.vertices as number[], m.triangles as number[]);
}

/** Merge vertices closer than eps (OCCT duplicates them along face seams). */
export function weld(vertices: ArrayLike<number>, triangles: ArrayLike<number>, eps = 1e-4): Mesh {
  const key = (x: number, y: number, z: number) => `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const remap = new Uint32Array(vertices.length / 3);
  for (let i = 0; i < vertices.length / 3; i++) {
    const x = vertices[3 * i]!;
    const y = vertices[3 * i + 1]!;
    const z = vertices[3 * i + 2]!;
    const k = key(x, y, z);
    let idx = map.get(k);
    if (idx === undefined) {
      idx = pos.length / 3;
      map.set(k, idx);
      pos.push(x, y, z);
    }
    remap[i] = idx;
  }
  const idx: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = remap[triangles[i]!]!;
    const b = remap[triangles[i + 1]!]!;
    const c = remap[triangles[i + 2]!]!;
    if (a === b || b === c || a === c) continue; // degenerate after welding
    idx.push(a, b, c);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export interface MeshCheck {
  triangles: number;
  closed: boolean;
  /** Edges not shared by exactly two oppositely wound triangles. */
  badEdges: number;
  volume: number; // mm³ (signed, > 0 for outward normals)
  bbox: { min: [number, number, number]; max: [number, number, number] };
  shells: number;
}

export function checkMesh(m: Mesh): MeshCheck {
  const edges = new Map<string, number>();
  const n = m.indices.length / 3;
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[3 * t + e]!;
      const b = m.indices[3 * t + ((e + 1) % 3)]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const dir = a < b ? 1 : 1000;
      edges.set(k, (edges.get(k) ?? 0) + dir);
    }
  }
  let bad = 0;
  for (const v of edges.values()) if (v !== 1001) bad++;
  let vol = 0;
  const P = m.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, P[i + k]!);
      max[k] = Math.max(max[k]!, P[i + k]!);
    }
  for (let t = 0; t < n; t++) {
    const a = 3 * m.indices[3 * t]!;
    const b = 3 * m.indices[3 * t + 1]!;
    const c = 3 * m.indices[3 * t + 2]!;
    vol += (P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) - P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) + P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!)) / 6;
  }
  // connected components (shells)
  const parent = new Int32Array(P.length / 3).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let t = 0; t < n; t++) {
    const a = find(m.indices[3 * t]!);
    const b = find(m.indices[3 * t + 1]!);
    const c = find(m.indices[3 * t + 2]!);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const roots = new Set<number>();
  for (let t = 0; t < n; t++) roots.add(find(m.indices[3 * t]!));
  return { triangles: n, closed: bad === 0, badEdges: bad, volume: vol, bbox: { min, max }, shells: roots.size };
}

/**
 * The mesh turned so `up` (case frame) points to +z, then moved so it stands on z = 0 centred on
 * x = y = 0: how the body goes on the printer's bed (the face down is flat on z = 0).
 */
export function printPose(m: Mesh, up: [number, number, number]): Mesh {
  const l = Math.hypot(up[0], up[1], up[2]) || 1;
  const n = [up[0] / l, up[1] / l, up[2] / l] as const;
  let R: number[][];
  if (n[2] > 1 - 1e-9) R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  else if (n[2] < -1 + 1e-9) R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]; // half turn about x
  else {
    // Rodrigues: axis n x z, angle acos(n . z)
    const ax = [n[1], -n[0], 0];
    const s = Math.hypot(ax[0]!, ax[1]!);
    const k = [ax[0]! / s, ax[1]! / s, 0];
    const c = n[2];
    const sn = s;
    const K = [[0, -k[2]!, k[1]!], [k[2]!, 0, -k[0]!], [-k[1]!, k[0]!, 0]];
    const K2 = K.map((row, i) => [0, 1, 2].map((j) => row[0]! * K[0]![j]! + row[1]! * K[1]![j]! + row[2]! * K[2]![j]!));
    R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) + sn * K[i]![j]! + (1 - c) * K2[i]![j]!));
  }
  const P = m.positions;
  const out = new Float32Array(P.length);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let r = 0; r < 3; r++) {
      const v = R[r]![0]! * P[i]! + R[r]![1]! * P[i + 1]! + R[r]![2]! * P[i + 2]!;
      out[i + r] = v;
      min[r] = Math.min(min[r]!, v);
      max[r] = Math.max(max[r]!, v);
    }
  }
  const sh = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, min[2]!];
  for (let i = 0; i < out.length; i += 3) for (let r = 0; r < 3; r++) out[i + r] = out[i + r]! - sh[r]!;
  return { positions: out, indices: m.indices };
}

/** Build-plate spots for bodies (their print-pose footprints), in rows with a gap, no overlap. */
export function plateLayout(sizes: { w: number; h: number }[], gap = 6, rowWidth = 200): { x: number; y: number }[] {
  const order = sizes.map((s, i) => ({ ...s, i })).sort((a, b) => b.h - a.h || b.w - a.w);
  const at: { x: number; y: number }[] = new Array(sizes.length);
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const s of order) {
    if (x > 0 && x + s.w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    at[s.i] = { x: x + s.w / 2, y: y + s.h / 2 };
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  return at;
}

export function stlBinary(m: Mesh, name: string, frame = "print orientation, face down on z = 0"): Uint8Array {
  const n = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(`Fabwright case: ${name} (mm, ${frame})`.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(head);
  dv.setUint32(80, n, true);
  const P = m.positions;
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = 3 * m.indices[3 * t]!;
    const b = 3 * m.indices[3 * t + 1]!;
    const c = 3 * m.indices[3 * t + 2]!;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    for (const [i, v] of [a, b, c].entries()) {
      dv.setFloat32(o + 12 + i * 12, P[v]!, true);
      dv.setFloat32(o + 16 + i * 12, P[v + 1]!, true);
      dv.setFloat32(o + 20 + i * 12, P[v + 2]!, true);
    }
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return new Uint8Array(buf);
}

/** Read a binary STL back into a welded mesh (tests, and the web mesh route for stale caches). */
export function readStl(bytes: Uint8Array): Mesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  const v: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 3; k++) {
      v.push(dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true));
      t.push(3 * i + k);
    }
  }
  return weld(v, t, 1e-3);
}

export function threeMf(objects: { name: string; color: string; mesh: Mesh; at?: { x: number; y: number } }[], title: string): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const mats = objects.map((o) => `<base name="${esc(o.name)}" displaycolor="${o.color.toUpperCase()}FF"/>`).join("");
  const objs = objects
    .map((o, i) => {
      const P = o.mesh.positions;
      const vs: string[] = [];
      for (let k = 0; k < P.length; k += 3) vs.push(`<vertex x="${P[k]!.toFixed(4)}" y="${P[k + 1]!.toFixed(4)}" z="${P[k + 2]!.toFixed(4)}"/>`);
      const ts: string[] = [];
      const I = o.mesh.indices;
      for (let k = 0; k < I.length; k += 3) ts.push(`<triangle v1="${I[k]}" v2="${I[k + 1]}" v3="${I[k + 2]}"/>`);
      return `<object id="${i + 2}" name="${esc(o.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${vs.join("")}</vertices><triangles>${ts.join("")}</triangles></mesh></object>`;
    })
    .join("");
  // build items carry the plate position (3MF transform: 3 x 3 rotation then translation)
  const items = objects.map((o, i) => `<item objectid="${i + 2}"${o.at ? ` transform="1 0 0 0 1 0 0 0 1 ${o.at.x.toFixed(3)} ${o.at.y.toFixed(3)} 0"` : ""}/>`).join("");
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">${esc(title)}</metadata><metadata name="Application">Fabwright</metadata><resources><basematerials id="1">${mats}</basematerials>${objs}</resources><build>${items}</build></model>`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  // fixed mtime so the file is byte-identical for the same case (zip stores a DOS date)
  const mtime = new Date(Date.UTC(2026, 0, 1));
  return zipSync({ "[Content_Types].xml": [strToU8(ct), { mtime }], "_rels/.rels": [strToU8(rels), { mtime }], "3D/3dmodel.model": [strToU8(model), { mtime }] }, { level: 6 });
}
