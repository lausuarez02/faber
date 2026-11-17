import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@faber/parts";
import type { Project } from "@faber/project-format";
import type { Mesh } from "../src/mesh.ts";

const ROOT = join(import.meta.dirname, "../../..");

/** The Muse: the committed example when present (power track), else the fixture copy. */
export function muse(): Project {
  const ex = join(ROOT, "examples/agent-built/claude-pocket-muse/faber.json");
  const file = existsSync(ex) ? ex : join(import.meta.dirname, "fixtures/pocket-muse.json");
  const p = JSON.parse(readFileSync(file, "utf8")) as Project;
  return { ...p, scenarios: p.scenarios ?? [], wires: p.wires ?? [] };
}

export const specOf = (t: string) => registry.get(t)?.spec;

export function partsOf(p: Project) {
  return p.parts.map((x) => ({ id: x.id, type: x.type, spec: specOf(x.type)! }));
}

/** The surfaces of the meshes along the vertical line through (x, y): every z where a triangle crosses it. */
export function zHits(meshes: Mesh[], x: number, y: number): number[] {
  const out: number[] = [];
  for (const m of meshes) {
    const P = m.positions;
    const I = m.indices;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k]! * 3, b = I[k + 1]! * 3, c = I[k + 2]! * 3;
      const ax = P[a]!, ay = P[a + 1]!, bx = P[b]!, by = P[b + 1]!, cx = P[c]!, cy = P[c + 1]!;
      const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / d;
      const v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
      out.push(u * P[a + 2]! + v * P[b + 2]! + w * P[c + 2]!);
    }
  }
  return out.sort((p, q) => p - q);
}
