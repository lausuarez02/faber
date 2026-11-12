/**
 * Round 12, track kit: what a printed body weighs and how long it prints, read from its STL.
 * Binary and ASCII STL; volume by the divergence theorem (signed tetrahedra from the origin), area as
 * the sum of the triangles, the box for the height (layers). Pure, no CAD engine.
 */
export interface MeshStats {
  triangles: number;
  /** mm³, always positive (absolute value of the signed volume). */
  volume_mm3: number;
  /** mm², every triangle once. */
  area_mm2: number;
  min: [number, number, number];
  max: [number, number, number];
}

export function stlStats(bytes: Uint8Array): MeshStats {
  const ascii = isAscii(bytes);
  const tris: number[] = [];
  if (ascii) {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) tris.push(Number(m[1]), Number(m[2]), Number(m[3]));
  } else {
    if (bytes.length < 84) throw new Error(`the STL is ${bytes.length} bytes, shorter than an STL header (84)`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 > bytes.length) throw new Error(`the STL says ${n} triangles but holds only ${Math.floor((bytes.length - 84) / 50)}`);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) tris.push(dv.getFloat32(o + k * 4, true));
    }
  }
  let vol = 0;
  let area = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ax = tris[i]!, ay = tris[i + 1]!, az = tris[i + 2]!;
    const bx = tris[i + 3]!, by = tris[i + 4]!, bz = tris[i + 5]!;
    const cx = tris[i + 6]!, cy = tris[i + 7]!, cz = tris[i + 8]!;
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] as const) {
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  }
  return { triangles: tris.length / 9, volume_mm3: Math.abs(vol), area_mm2: area, min, max };
}

function isAscii(b: Uint8Array): boolean {
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 256))).trimStart();
  if (!head.startsWith("solid")) return false;
  // Some binary STLs also start with "solid": trust the size when it matches the binary layout.
  if (b.length >= 84) {
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
    if (84 + n * 50 === b.length) return false;
  }
  return true;
}

/** A binary STL of a w x h x d box (tests and fixtures). */
export function boxStl(w: number, h: number, d: number): Uint8Array {
  const v = [
    [0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0],
    [0, 0, d], [w, 0, d], [w, h, d], [0, h, d],
  ];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = new Uint8Array(84 + f.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, f.length, true);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi]!.forEach((c, j) => dv.setFloat32(84 + i * 50 + 12 + k * 12 + j * 4, c, true))));
  return out;
}
