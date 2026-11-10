// Decision 0004 "Validation": every STL is a closed 2-manifold with volume > 0, no part body
// intersects the shell (OpenCascade common volume < 0.001 mm³), generated sizes within 0.1 mm of
// the layout. Slow (OpenCascade wasm): one generation per shape.
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { generateCase } from "../src/engine.ts";
import { checkMesh, readStl } from "../src/mesh.ts";
import { muse, specOf } from "./helpers.ts";

const T = 240_000;

describe("case engine on the Muse", () => {
  it.each([
    ["pebble", {}],
    ["puck", { closure: "screws" }],
    ["rounded-box", { belt_clip: true }],
    ["keychain", {}],
    ["pill", { process: "resin" }],
  ] as const)(
    "%s %o: watertight files, no part in the shell, sizes match",
    async (shape, params) => {
      const p = { ...muse(), enclosure: { shape, params } };
      const g = await generateCase(p, specOf, { renders: shape === "pebble" });
      const bad = g.report.checks.filter((c) => !c.ok && c.severity === "error");
      expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
      expect(g.report.ok).toBe(true);
      for (const id of ["watertight", "no-intersection", "size-match", "min-wall", "screen-window", "connector-access", "buttons-reachable"]) expect(g.report.checks.some((c) => c.id === id && c.ok), id).toBe(true);
      // re-read every STL from its bytes and check it independently
      const stls = [...g.files.keys()].filter((k) => k.endsWith(".stl"));
      expect(stls).toContain("stl/front.stl");
      expect(stls).toContain("stl/back.stl");
      expect(stls).toContain("stl/cap-pet.stl");
      for (const k of stls) {
        const c = checkMesh(readStl(g.files.get(k)!));
        expect(c.closed, `${k}: ${c.badEdges} open edges`).toBe(true);
        expect(c.volume, k).toBeGreaterThan(0);
        expect(g.files.get(k)!.length, `${k} stays small`).toBeLessThan(2_000_000);
      }
      // every STL stands on the bed: its lowest point on z = 0, centred on x = y = 0
      for (const k of stls) {
        const bb = checkMesh(readStl(g.files.get(k)!)).bbox;
        expect(bb.min[2], `${k} on the bed`).toBeCloseTo(0, 3);
        expect(Math.abs(bb.min[0] + bb.max[0]), k).toBeLessThan(0.01);
      }
      // the front shell prints face down: its outer face (front) is the flat bottom, open side up
      const fs = readStl(g.files.get("stl/front.stl")!);
      const flatOnBed = (m: ReturnType<typeof readStl>) => {
        let a = 0;
        for (let t = 0; t < m.indices.length; t += 3) {
          const zs = [0, 1, 2].map((j) => m.positions[3 * m.indices[t + j]! + 2]!);
          if (Math.max(...zs) < 0.01) {
            const P = (j: number) => [0, 1, 2].map((q) => m.positions[3 * m.indices[t + j]! + q]!);
            const [p0, p1, p2] = [P(0), P(1), P(2)];
            a += Math.abs((p1[0]! - p0[0]!) * (p2[1]! - p0[1]!) - (p2[0]! - p0[0]!) * (p1[1]! - p0[1]!)) / 2;
          }
        }
        return a;
      };
      expect(flatOnBed(fs), "front shell has a flat face on the bed").toBeGreaterThan(100);
      expect(flatOnBed(readStl(g.files.get("stl/back.stl")!)), "back shell has a flat face on the bed").toBeGreaterThan(100);
      // sizes in the case frame (the web meshes)
      const frame = (body: string) => {
        const m = g.mesh.bodies.find((x) => x.body === body)!;
        const buf = Buffer.from(m.positions, "base64");
        const pos = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        return checkMesh({ positions: pos, indices: new Uint32Array(0) }).bbox;
      };
      const f = frame("front");
      const b = frame("back");
      const size = [0, 1, 2].map((k) => Math.max(f.max[k]!, b.max[k]!) - Math.min(f.min[k]!, b.min[k]!));
      expect(Math.abs(size[0]! - g.report.size_mm.w)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(size[1]! - g.report.size_mm.h)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(size[2]! - g.report.size_mm.d)).toBeLessThanOrEqual(0.1);
      // front shell above back shell, split between them
      expect(f.min[2]).toBeGreaterThan(b.min[2]!);
      // 3MF: a zip with a model naming every body
      const z = unzipSync(g.files.get("case.3mf")!);
      const model = strFromU8(z["3D/3dmodel.model"]!);
      for (const k of stls) expect(model).toContain(`name="${k.slice(4, -4)}"`);
      // one build plate: every item placed with a transform, footprints apart
      const items = [...model.matchAll(/<item objectid="(\d+)" transform="([^"]+)"\/>/g)];
      expect(items.length).toBe(stls.length);
      const foot = items.map(([, id, tr]) => {
        const obj = model.split(`<object id="${id}"`)[1]!.split("</object>")[0]!;
        const xs = [...obj.matchAll(/x="([-\d.]+)" y="([-\d.]+)"/g)].map((v) => [Number(v[1]), Number(v[2])] as const);
        const [tx, ty] = tr!.split(" ").slice(9, 11).map(Number) as [number, number];
        return { x0: Math.min(...xs.map((v) => v[0])) + tx, x1: Math.max(...xs.map((v) => v[0])) + tx, y0: Math.min(...xs.map((v) => v[1])) + ty, y1: Math.max(...xs.map((v) => v[1])) + ty };
      });
      for (const [i, p] of foot.entries()) for (const q of foot.slice(i + 1)) expect(p.x1 <= q.x0 || q.x1 <= p.x0 || p.y1 <= q.y0 || q.y1 <= p.y0, "plate items overlap").toBe(true);
      expect(strFromU8(g.files.get("step/assembly.step")!.slice(0, 13))).toBe("ISO-10303-21;");
      expect(new TextDecoder().decode(g.files.get("step/assembly.step")!)).toContain("part-eye");
      expect(new TextDecoder().decode(g.files.get("drawing/drawing.svg")!)).toContain(`${g.report.size_mm.w.toFixed(1)}`);
      if (shape === "pebble") for (const v of ["front", "back", "exploded", "inside"]) expect([...g.files.get(`renders/${v}.png`)!.slice(1, 4)]).toEqual([80, 78, 71]);
      if (shape === "puck") expect(new TextDecoder().decode(g.files.get("PRINT.md")!)).toContain("heat-set");
      if (shape === "rounded-box") expect(stls).toContain("stl/belt-clip.stl");
      if (shape === "keychain") expect(g.layout.tab).toBeDefined();
    },
    T,
  );
});
