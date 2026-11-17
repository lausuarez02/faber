// Round 12: the mounting features the case now adds (seat posts, hold-downs, backstops, guides,
// cell corners and strap slots) are real printable geometry: every STL stays a closed solid, no
// part body runs into a shell, and the plan and a picture per step are among the case's files.
// Slow (OpenCascade wasm).
import { describe, expect, it } from "vitest";
import type { Project } from "@fabwright/project-format";
import { generateCase } from "../src/engine.ts";
import { checkMesh, readStl } from "../src/mesh.ts";
import { muse, specOf } from "./helpers.ts";
import { egg, starPoints } from "./assembly-fixtures.ts";

const T = 400_000;

describe("mounting features are printable, and the steps are pictured", () => {
  it.each([
    ["egg (custom outline)", egg, true],
    ["Muse in a puffy star (custom, concave)", () => ({ ...muse(), enclosure: { shape: "custom", outline: { points: starPoints(), smooth: true } } }) as Project, false],
    ["Muse rounded-box with screws", () => ({ ...muse(), enclosure: { shape: "rounded-box", params: { closure: "screws" } } }) as Project, false],
  ] as const)(
    "%s",
    async (_n, make, renders) => {
      const p = make();
      const g = await generateCase(p, specOf, { renders });
      for (const id of ["watertight", "no-intersection", "size-match", "min-wall"]) expect(g.report.checks.find((c) => c.id === id), id).toMatchObject({ ok: true });
      for (const k of [...g.files.keys()].filter((f) => f.endsWith(".stl"))) {
        const c = checkMesh(readStl(g.files.get(k)!));
        expect(c.closed, `${k}: ${c.badEdges} open edges`).toBe(true);
        expect(c.volume, k).toBeGreaterThan(0);
      }
      // the generator added what was missing: posts that seat or hold down a part, ribs that stop or guide one
      const L = g.layout;
      expect(L.mounts.length).toBe(L.placed.length);
      expect(L.posts.some((q) => q.kind === "hold-down" || q.kind === "seat"), "a seat or hold-down post").toBe(true);
      expect(L.ribs.some((r) => r.kind === "backstop" || r.kind === "guide"), "a backstop or guide").toBe(true);
      for (const m of L.mounts) expect(m.how.length, m.part).toBeGreaterThan(0);
      // its checks are in the report, and the plan is a case file
      expect(g.report.checks.some((c) => c.id.startsWith("assembly-"))).toBe(true);
      expect(g.report.assembly!.steps).toBeGreaterThan(10);
      const plan = JSON.parse(new TextDecoder().decode(g.files.get("assembly/plan.json")!));
      expect(plan.steps.length).toBe(g.report.assembly!.steps);
      if (renders) {
        expect(g.report.assembly!.images.length).toBe(plan.steps.length);
        for (const img of g.report.assembly!.images) {
          const b = g.files.get(img)!;
          expect([...b.slice(1, 4)].map((c) => String.fromCharCode(c)).join(""), img).toBe("PNG");
          expect(b.length, img).toBeGreaterThan(2000);
        }
      } else expect(g.report.assembly!.images).toEqual([]);
    },
    T,
  );
});
