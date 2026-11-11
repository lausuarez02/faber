// Round 8b: what each case choice costs, and a fixed outline steered to thin. Evidence: a real Claude
// rebuilt the talking egg on round-8 code at 74 x 96 x 44.4 mm (round 7 was 34.3): its parts were
// small, its own choices (a 6 mm dome, the eyes and the speaker pinned on the front, a fixed
// 74 x 96 mm outline) made it thick, and nothing said what they cost.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@jumper/project-format";
import { describe, expect, it } from "vitest";
import { choiceCosts, choicesOf, mergeChanges } from "../src/costs.ts";
import { layoutInput } from "../src/engine.ts";
import { DOME_WARN_MM } from "../src/layout.ts";
import { layoutCase, proposeLayouts } from "../src/proposals.ts";
import { muse, specOf } from "./helpers.ts";

const T = 180_000;

function egg8(): Project {
  const p = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/talking-egg-round8.json"), "utf8")) as Project;
  return { ...p, scenarios: p.scenarios ?? [], wires: p.wires ?? [] };
}
const withEnc = (p: Project, patch: Record<string, unknown>): Project => ({ ...p, enclosure: { ...p.enclosure!, ...patch } as Project["enclosure"] });

describe("choice costs", { timeout: T }, () => {
  it("lists every choice the agent made, each with the update_case call that relaxes it", () => {
    const ch = choicesOf(layoutInput(egg8(), specOf));
    const ids = ch.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["dome", "size", "pin:eyes", "pin:spk", "face:spk", "face:sw"]));
    // the speaker pinned on the front: the alternative is its grille on the back
    const spk = ch.find((c) => c.id === "face:spk")!;
    expect(spk.change).toEqual({ placements: { spk: { face: "back", y_mm: null, x_mm: null } } });
    expect(spk.tradeoff).toMatch(/back/);
    expect(ch.find((c) => c.id === "dome")!.change).toEqual({ params: { dome_mm: 1.5 } });
    expect(ch.find((c) => c.id === "size")!.change).toEqual({ size_mm: { w: null, h: null } });
    // the dome first, then the size, then pins (the likeliest costs first in the time box)
    expect(ids.indexOf("dome")).toBeLessThan(ids.indexOf("pin:eyes"));
    // a case with no choices has nothing to relax
    expect(choicesOf(layoutInput({ ...muse(), enclosure: { shape: "pebble" } }, specOf))).toEqual([]);
  });

  it("the round-8 egg: the dome and the fixed size are the costly ones, with mm before and after; relaxing all is pocket-thin", () => {
    const r = choiceCosts(layoutInput(egg8(), specOf), { budgetMs: 30_000 });
    expect(r.skipped).toEqual([]);
    expect(r.base.fits).toBe(true);
    const dome = r.costs.find((c) => c.id === "dome")!;
    expect(dome, JSON.stringify(r.costs.map((c) => c.id))).toBeDefined();
    // 6 mm on both faces against 1.5: about 9 mm of thickness
    expect(dome.adds_mm).toBeGreaterThanOrEqual(7);
    expect(dome.without.d).toBeCloseTo(dome.with.d - dome.adds_mm, 1);
    expect(dome.message).toMatch(/^A 6 mm dome on both faces adds [\d.]+ mm of thickness \([\d.]+ -> [\d.]+ mm thick with a 1\.5 mm dome\)\. Fix: update_case \{"params":\{"dome_mm":1\.5\}\}/);
    // people's text: no tool names
    for (const c of r.costs) {
      expect(c.say).not.toMatch(/update_case|design_case|placements|params|_mm/);
      expect(c.label).not.toMatch(/update_case|_mm/);
    }
    expect(r.costs.some((c) => c.id === "size")).toBe(true);
    // sorted, the costliest first
    for (let i = 1; i < r.costs.length; i++) expect(r.costs[i - 1]!.adds_mm).toBeGreaterThanOrEqual(r.costs[i]!.adds_mm);
    // every choice relaxed at once: within a pocket's 22 mm
    expect(r.relax_all).toBeDefined();
    expect(r.relax_all!.without.fits).toBe(true);
    expect(r.relax_all!.without.d).toBeLessThanOrEqual(22);
    expect(r.relax_all!.change).toMatchObject({ params: { dome_mm: 1.5 }, size_mm: { w: null, h: null }, placements: { spk: { face: "back" }, eyes: { x_mm: null, y_mm: null } } });
    // a fixed outline: the sizes it works at, flat first
    expect(r.sizes_that_work?.[0]?.layers).toBe(1);
    expect(r.sizes_that_work![0]!.change).toEqual({ size_mm: { w: r.sizes_that_work![0]!.size_mm.w, h: r.sizes_that_work![0]!.size_mm.h } });
  });

  it("is time-boxed: what is not reached is listed as skipped", () => {
    const r = choiceCosts(layoutInput(egg8(), specOf), { budgetMs: 1 });
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(r.costs).toEqual([]);
  });

  it("a fixed size that fails: the choice that breaks it is named and the sizes that work are given", () => {
    const p = withEnc(egg8(), { size_mm: { w: 44, h: 57 } });
    const r = choiceCosts(layoutInput(p, specOf), { budgetMs: 30_000 });
    expect(r.base.fits).toBe(false);
    expect(r.sizes_that_work?.length).toBeGreaterThan(0);
    for (const z of r.sizes_that_work!) expect(z.size_mm.w).toBeGreaterThan(44);
    // relaxing the size makes it fit (the costliest is a choice that breaks the fit)
    expect(r.costs[0]!.breaks_fit).toBe(true);
    expect(r.costs[0]!.message).toMatch(/keeps the parts from fitting/);
  });

  it("merges update_case changes (params, size, placements per part)", () => {
    expect(mergeChanges({ params: { dome_mm: 1.5 }, placements: { spk: { y_mm: null } } }, { params: { wall_mm: 1.6 }, placements: { spk: { face: "back" }, eyes: { x_mm: null } }, size_mm: { w: null } })).toEqual({ params: { dome_mm: 1.5, wall_mm: 1.6 }, placements: { spk: { y_mm: null, face: "back" }, eyes: { x_mm: null } }, size_mm: { w: null } });
  });
});

describe("a fixed outline is steered to thin", { timeout: T }, () => {
  it("at the agent's fixed 74 x 96 mm, balanced is the thinnest layout that fits (round 8 built 44.4 mm, round 7's stack)", () => {
    const r = proposeLayouts(layoutInput(egg8(), specOf));
    const by = Object.fromEntries(r.proposals.map((p) => [p.id, p]));
    expect(by.balanced!.misses).toEqual([]);
    expect(by.balanced!.size_mm.w).toBe(74);
    expect(by.balanced!.size_mm.h).toBe(96);
    expect(by.balanced!.size_mm.d).toBe(by.thinnest!.size_mm.d);
    expect(by.balanced!.size_mm.d).toBeLessThan(44.4 - 5);
    expect(by.balanced!.source).toMatch(/optimizer/);
  });

  it("the same outline with the default dome and no pins: under 30 mm at that size", () => {
    const p = withEnc(egg8(), { params: { color: "#F4EBDD" }, placements: { sw: { face: "right" } } });
    const L = layoutCase(layoutInput(p, specOf));
    expect(L.fit?.fits).toBe(true);
    expect(L.outer.w).toBe(74);
    expect(L.outer.d).toBeLessThan(30);
  });
});

describe("dome warning", { timeout: T }, () => {
  it(`a dome over ${DOME_WARN_MM} mm is a warning with what it costs; 1.5 mm or auto is not`, () => {
    const big = layoutCase(layoutInput(withEnc(egg8(), { size_mm: undefined, placements: undefined }), specOf));
    const w = big.issues.find((i) => i.id === "dome");
    expect(w?.severity).toBe("warning");
    expect(w!.message).toMatch(/^The 6 mm dome on both faces adds [\d.]+ mm of thickness over the default bulge.*Why: .*Fix: dome_mm 1\.5/);
    const extra = Number(/adds ([\d.]+) mm/.exec(w!.message)![1]);
    expect(extra).toBeGreaterThan(9);
    expect(extra).toBeLessThan(12);
    for (const dome of [1.5, "auto", 3] as const) {
      const L = layoutCase(layoutInput(withEnc(egg8(), { size_mm: undefined, placements: undefined, params: { dome_mm: dome } }), specOf));
      expect(L.issues.some((i) => i.id === "dome"), String(dome)).toBe(false);
    }
  });
});
