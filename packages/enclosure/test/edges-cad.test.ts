// Round 17: the rounded front / back edges really come out rounded. Round 15's rim on a fixed-size
// rounded box came out sharp (OpenCascade's fillet failed silently, the report only had a note):
// each rim is now filleted, or lofted through offsets of the outline, or chamfered, and the
// edge-radius check says what it got. These tests measure the radius on the printed mesh.
import { describe, expect, it } from "vitest";
import type { Project } from "@fabwright/project-format";
import { buildCase } from "../src/geometry.ts";
import { layoutInput } from "../src/engine.ts";
import { meshOf, checkMesh, type Mesh } from "../src/mesh.ts";
import { layoutCase } from "../src/proposals.ts";
import { specOf } from "./helpers.ts";

/**
 * The rim radius measured on a mesh: along direction (ux, uy) in plan, the points within d = 0.03 mm
 * of the side wall's full extent; the highest of them is h below the face, where a rim of radius r
 * is inset by d: r = h + d + sqrt(2 h d). A sharp rim measures about 0.
 */
export function rimRadius(m: Mesh, face: "front" | "back", ux: number, uy: number): number {
  const P = m.positions;
  let ext = -Infinity;
  let zMax = -Infinity;
  let zMin = Infinity;
  for (let i = 0; i < P.length; i += 3) {
    ext = Math.max(ext, P[i]! * ux + P[i + 1]! * uy);
    zMax = Math.max(zMax, P[i + 2]!);
    zMin = Math.min(zMin, P[i + 2]!);
  }
  // (points of the face itself are at full extent only on a sharp rim)
  let near = face === "front" ? -Infinity : Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i]! * ux + P[i + 1]! * uy < ext - 0.03) continue;
    near = face === "front" ? Math.max(near, P[i + 2]!) : Math.min(near, P[i + 2]!);
  }
  const h = face === "front" ? zMax - near : near - zMin;
  const d = 0.03;
  return h < 0.02 ? 0 : h + d + Math.sqrt(2 * h * d);
}

const project = (enclosure: Record<string, unknown>): Project =>
  ({
    format: "fabwright/1",
    name: "edges",
    parts: [
      { id: "xiao", type: "seeed-xiao-esp32c3", x: 0, y: 0, rotation: 0 },
      { id: "epd", type: "epaper-154-ssd1681", x: 0, y: 0, rotation: 0 },
      { id: "bat", type: "lipo-battery", x: 0, y: 0, rotation: 0, props: { capacity: 150 } },
    ],
    wires: [],
    scenarios: [],
    enclosure,
  }) as unknown as Project;

describe("rounded front / back edges, measured on the mesh (round 17)", { timeout: 300_000 }, () => {
  for (const [label, enc, askedF, askedB] of [
    // round 15's case: a rounded box at a fixed size (drawn as an outline) came out sharp
    ["a rounded box at a fixed size", { shape: "rounded-box", size_mm: { w: 84, h: 100 }, params: { corner_radius_mm: 12, edge_radius_front_mm: 2, dome_mm: 0 } }, 2, 2],
    ["a round puck", { shape: "puck", params: { edge_radius_front_mm: 3, edge_radius_back_mm: 1.5 } }, 3, 1.5],
    ["a round puck at a fixed size", { shape: "puck", size_mm: { w: 74, h: 74 }, params: { edge_radius_front_mm: 2.5, edge_radius_back_mm: 1 } }, 2.5, 1],
  ] as [string, Record<string, unknown>, number, number][]) {
    it(`${label}: front ${askedF} mm, back ${askedB} mm`, async () => {
      const L = layoutCase(layoutInput(project(enc), specOf));
      // the layout may trim a radius a little (the straight band a side opening needs): it says so
      expect(L.rf).toBeGreaterThan(askedF - 0.45);
      expect(L.rfBack).toBeGreaterThan(askedB - 0.45);
      const B = await buildCase(L);
      expect(B.edgeHow).not.toBe("sharp");
      expect(B.rf).toBeCloseTo(L.rf, 2);
      expect(B.rfBack).toBeCloseTo(L.rfBack, 2);
      const front = B.rf;
      const back = B.rfBack;
      const fm = meshOf(B.bodies.find((b) => b.name === "front")!.shape, 0.01, 0.1);
      const bm = meshOf(B.bodies.find((b) => b.name === "back")!.shape, 0.01, 0.1);
      for (const m of [fm, bm]) expect(checkMesh(m).closed).toBe(true);
      for (const [ux, uy] of [[1, 0], [0, 1], [-1, 0]] as const) {
        expect(rimRadius(fm, "front", ux, uy), `front rim along ${ux},${uy}`).toBeGreaterThan(front - 0.3);
        expect(rimRadius(fm, "front", ux, uy)).toBeLessThan(front + 0.3);
        expect(rimRadius(bm, "back", ux, uy), `back rim along ${ux},${uy}`).toBeGreaterThan(back - 0.3);
        expect(rimRadius(bm, "back", ux, uy)).toBeLessThan(back + 0.3);
      }
    });
  }
});
