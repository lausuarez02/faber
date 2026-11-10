// Round 7: a full design of the talking egg (XIAO RP2040 + GC9A01 eyes + LiPo + TP4056 + a 28 mm
// speaker) in an egg DRAWN as a custom outline: watertight print-oriented STLs, the speaker grille's
// holes really cut through the domed back, every fit check, the pocket verdict, the real silhouette
// in the drawing and the report. Slow (OpenCascade wasm).
import { describe, expect, it } from "vitest";
import { generateCase } from "../src/engine.ts";
import { checkMesh, readStl } from "../src/mesh.ts";
import { EGG_SVG, eggProject, specOfX } from "./custom-fixtures.ts";

const T = 400_000;

function decode(b64: string, T: Float32ArrayConstructor | Uint32ArrayConstructor) {
  const buf = Buffer.from(b64, "base64");
  return new T(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Crossings of the line through (x, y) along z with a triangle mesh (case frame). */
function zHits(P: Float32Array, I: Uint32Array, x: number, y: number): number {
  let n = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t]!;
    const b = 3 * I[t + 1]!;
    const c = 3 * I[t + 2]!;
    const d = (P[b + 1]! - P[c + 1]!) * (P[a]! - P[c]!) + (P[c]! - P[b]!) * (P[a + 1]! - P[c + 1]!);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((P[b + 1]! - P[c + 1]!) * (x - P[c]!) + (P[c]! - P[b]!) * (y - P[c + 1]!)) / d;
    const l2 = ((P[c + 1]! - P[a + 1]!) * (x - P[c]!) + (P[a]! - P[c]!) * (y - P[c + 1]!)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= 0 && l2 >= 0 && l3 >= 0) n++;
  }
  return n;
}

describe("the talking egg, drawn as a custom outline", () => {
  it(
    "designs a printable egg: watertight STLs, grille holes through the dome, checks, pocket verdict",
    async () => {
      const p = eggProject({ shape: "custom", outline: EGG_SVG, params: { dome_mm: 2 } });
      const g = await generateCase(p, specOfX, { renders: false });
      const bad = g.report.checks.filter((c) => !c.ok && c.severity === "error");
      expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
      expect(g.report.ok).toBe(true);
      for (const id of ["fits", "watertight", "no-intersection", "size-match", "min-wall", "screen-window", "connector-access"]) expect(g.report.checks.some((c) => c.id === id && c.ok), id).toBe(true);
      // an egg: taller than wide by about the drawn 1.3, rounded and domed
      const { w, h, d } = g.report.size_mm;
      expect(h / w).toBeGreaterThan(1.2);
      expect(h / w).toBeLessThan(1.4);
      expect(g.layout.plan.kind).toBe("poly");
      expect(g.layout.dome?.front.crown).toBeCloseTo(2, 5);
      expect(g.report.pocket).toMatch(/^(fits|tight|no)$/);
      expect(g.report.checks.find((c) => c.id === "pocket")!.message).toContain(`${w} x ${h} x ${d} mm`);
      expect(g.report.volume_cm3).toBeGreaterThan(20);
      expect(g.report.fit?.fits).toBe(true);
      expect(g.report.outline_mm!.length).toBeGreaterThan(60);
      expect(g.report.enclosure.shape).toBe("custom");
      // every STL is a closed solid on the bed
      const stls = [...g.files.keys()].filter((k) => k.endsWith(".stl"));
      expect(stls).toEqual(expect.arrayContaining(["stl/front.stl", "stl/back.stl"]));
      for (const k of stls) {
        const c = checkMesh(readStl(g.files.get(k)!));
        expect(c.closed, `${k}: ${c.badEdges} open edges`).toBe(true);
        expect(c.volume, k).toBeGreaterThan(0);
        expect(c.bbox.min[2], `${k} on the bed`).toBeCloseTo(0, 3);
      }
      for (const f of ["case.3mf", "step/assembly.step", "step/front.step", "step/back.step", "drawing/drawing.svg", "PRINT.md", "report.json"]) expect(g.files.has(f), f).toBe(true);
      // the drawing has the egg's real silhouette (a polygon with many points, not an ellipse)
      const svg = new TextDecoder().decode(g.files.get("drawing/drawing.svg")!);
      const pts = /<polygon class="o" points="([^"]+)"/.exec(svg)![1]!.trim().split(/\s+/);
      expect(pts.length).toBeGreaterThan(100);
      // the speaker grille: a field of 1.8 mm holes, each cut right through the domed back shell
      const grille = g.layout.openings.find((o) => o.kind === "grille" && o.part === "spk")!;
      expect(grille.face).toBe("back");
      expect(grille.holes!.length).toBeGreaterThanOrEqual(19);
      expect(grille.holes![0]!.d).toBeCloseTo(1.8, 5);
      const back = g.mesh.bodies.find((b) => b.body === "back")!;
      const P = decode(back.positions, Float32Array) as Float32Array;
      const I = decode(back.indices, Uint32Array) as Uint32Array;
      for (const hole of grille.holes!) expect(zHits(P, I, hole.at[0], hole.at[1]), `hole at ${hole.at[0].toFixed(1)}, ${hole.at[1].toFixed(1)}`).toBe(0);
      // control: just outside the grille the back wall is solid
      expect(zHits(P, I, grille.at[0] + grille.u / 2 + 2.5, grille.at[1])).toBeGreaterThan(0);
    },
    T,
  );
});
