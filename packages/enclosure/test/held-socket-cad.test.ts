// Round 17: a case that rides on a held object through a socket (enclosure.held[].engage_mm) and
// follows its outline (enclosure.follow): the fixture is a round puck on a 70 mm pouch can's lid,
// e-paper on top, a reed switch over the socket floor that sees a magnet glued on the can body.
// Built through the CAD kernel; the STLs are measured.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Project } from "@jumper/project-format";
import { generateCase } from "../src/engine.ts";
import { checkMesh, type Mesh } from "../src/mesh.ts";
import { specOf, zHits } from "./helpers.ts";

const LID = JSON.parse(readFileSync(new URL("./fixtures/lid-topper.json", import.meta.url), "utf8")) as Project;

/** A binary STL as a welded mesh (positions shared by index). */
function stlMesh(b: Uint8Array): Mesh {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = v.getUint32(80, true);
  const key = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const o = 84 + i * 50 + 12 + k * 12;
      const p = [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)];
      const s = p.map((x) => x.toFixed(4)).join(",");
      let j = key.get(s);
      if (j === undefined) {
        j = pos.length / 3;
        key.set(s, j);
        pos.push(...p);
      }
      idx.push(j);
    }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function bbox(m: Mesh): { min: number[]; max: number[]; size: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k]!, m.positions[i + k]!);
    max[k] = Math.max(max[k]!, m.positions[i + k]!);
  }
  return { min, max, size: [0, 1, 2].map((k) => max[k]! - min[k]!) };
}

describe("a lid-topper: a round puck that rides on a can's lid (round 17)", { timeout: 300_000 }, () => {
  it("follows the can's outline, a 6 mm socket in the back, watertight STLs, the reed sees the magnet only when mounted", async () => {
    const g = await generateCase(LID, specOf, { renders: false, stepImages: false });
    const r = g.report;
    const L = g.layout;
    const errors = r.checks.filter((c) => !c.ok && c.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(r.checks.find((c) => c.id === "watertight")!.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "no-intersection")!.ok).toBe(true);
    expect(r.notes.join(" ")).not.toContain("left out");
    // the outline: the can's 70 mm + 0.3 clearance + 2.5 margin + 1.6 wall a side (+ 0.1 slack)
    expect(L.plan.exact?.shape).toBe("circle");
    expect(r.size_mm.w).toBeCloseTo(70 + 0.6 + 5 + 3.2 + 0.2, 1);
    expect(r.size_mm.h).toBeCloseTo(r.size_mm.w, 1);
    // concentric with the can's room
    const can = L.placed.find((p) => p.mech.id === "can")!;
    expect(Math.abs((can.min[0] + can.max[0]) / 2 - L.plan.cx)).toBeLessThan(0.05);
    expect(Math.abs((can.min[1] + can.max[1]) / 2 - L.plan.cy)).toBeLessThan(0.05);
    // every electronic part is above the socket's floor plate
    for (const p of L.placed) if (p !== can) expect(p.min[2], p.mech.id).toBeGreaterThan(can.max[2] + 1.2 - 1e-6);
    const h = r.held![0]!;
    expect(h).toMatchObject({ id: "can", engage_mm: 6, depth_mm: 6, proud_mm: 14, fit: "slip" });
    expect(h.sensing!.mounted_mm).toBeLessThanOrEqual(10);
    expect(h.sensing!.lifted_mm).toBeGreaterThan(10);
    expect(r.checks.find((c) => c.id === "held-sensor")!.message).toMatch(/when mounted \(within 10 mm: closed\).*lifted 8 mm \(open: beyond the [\d.]+ mm where it lets go\).*"set": "reed.magnet_mm"/);
    // the edges as planned
    expect(r.checks.find((c) => c.id === "edge-radius")!.facts).toMatchObject({ front_mm: 2.5, back_mm: 1 });

    // ---- the STLs as printed: closed, and their sizes
    const front = stlMesh(g.files.get("stl/front.stl")!);
    const back = stlMesh(g.files.get("stl/back.stl")!);
    for (const m of [front, back]) {
      const c = checkMesh(m);
      expect(c.closed).toBe(true);
      expect(c.shells).toBe(1);
    }
    const bf = bbox(front);
    const bb = bbox(back);
    expect(bf.size[0]).toBeCloseTo(r.size_mm.w, 0);
    expect(bb.size[0]).toBeCloseTo(r.size_mm.w, 0);
    // the two shells stack to the whole thickness (front + back = d, the lip inside)
    expect(bf.size[2]! + bb.size[2]!).toBeGreaterThan(r.size_mm.d - 0.1);

    // ---- the socket measured in the case frame: 6 mm deep from the outer back face to the floor,
    // the collar wall hugging the can (70.6 mm across)
    const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64")).buffer;
    const shells = g.mesh.bodies.filter((b) => b.kind === "shell").map((b) => ({ positions: new Float32Array(bytes(b.positions)), indices: new Uint32Array(bytes(b.indices)) }) as Mesh);
    const zOutB = L.zBack - L.params.wall_mm;
    const cx = (can.min[0] + can.max[0]) / 2;
    const cy = (can.min[1] + can.max[1]) / 2;
    const hits = zHits(shells, cx + 5.3, cy - 7.1);
    const floor = Math.min(...hits);
    expect(hits.some((z) => z < zOutB + 0.01)).toBe(false);
    expect(floor - zOutB).toBeCloseTo(6, 1);
    let inner = Infinity;
    for (const m of shells)
      for (let i = 0; i < m.positions.length; i += 3) {
        const z = m.positions[i + 2]!;
        // (a vertical wall's vertices sit at its ends: the mouth and the floor)
        if (z < zOutB - 0.01 || z > floor + 0.01) continue;
        const rr = Math.hypot(m.positions[i]! - cx, m.positions[i + 1]! - cy);
        if (rr > 30) inner = Math.min(inner, rr);
      }
    expect(2 * inner).toBeCloseTo(70.6, 1);
    // the back shell prints standing on the floor plate (no bridge over the socket)
    expect(g.files.has("stl/back.stl")).toBe(true);
    console.log(`lid-topper: ${r.size_mm.w} x ${r.size_mm.h} x ${r.size_mm.d} mm; front STL ${bf.size.map((v) => v.toFixed(2)).join(" x ")}, back STL ${bb.size.map((v) => v.toFixed(2)).join(" x ")}; socket ${(2 * inner).toFixed(2)} mm across, ${(floor - zOutB).toFixed(2)} mm deep; can stands ${h.proud_mm} mm proud, total with the can ${(r.size_mm.d + h.proud_mm!).toFixed(1)} mm; reed ${h.sensing!.mounted_mm} mm mounted / ${h.sensing!.lifted_mm} mm lifted ${h.sensing!.lift_mm} mm`);
  });
});
