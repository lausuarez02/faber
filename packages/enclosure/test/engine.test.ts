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
      const f = checkMesh(readStl(g.files.get("stl/front.stl")!)).bbox;
      const b = checkMesh(readStl(g.files.get("stl/back.stl")!)).bbox;
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
