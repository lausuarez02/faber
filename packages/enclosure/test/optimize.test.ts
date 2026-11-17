// Round 8: the automatic distribution optimizer. Flat first, then stacked; any outline; pinned parts
// stay; the screen behind its window, the grille on its face, every port reaching its wall; the same
// project always gives the same proposals; and the talking egg a real Claude built (34.3 mm thick
// with round 7's front-to-back stacker) comes out at most 22 mm thick.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@faber/project-format";
import { describe, expect, it } from "vitest";
import { layoutInput } from "../src/engine.ts";
import { contains } from "../src/plan.ts";
import { layoutCase, proposeLayouts, proposeWithLayouts } from "../src/proposals.ts";
import { EGG_SVG, eggProject, partsX, specOfX } from "./custom-fixtures.ts";
import { muse, partsOf, specOf } from "./helpers.ts";

const T = 120_000;

function talkingEgg(): Project {
  const p = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/talking-egg-2.json"), "utf8")) as Project;
  return { ...p, scenarios: p.scenarios ?? [], wires: p.wires ?? [] };
}

const strip = (r: ReturnType<typeof proposeLayouts>) => JSON.stringify({ ...r, ms: 0 });

describe("layout proposals", { timeout: T }, () => {
  it("are deterministic: the same project gives the same proposals", () => {
    const input = layoutInput(talkingEgg(), specOf);
    const a = proposeLayouts(input);
    const b = proposeLayouts(input);
    expect(strip(a)).toBe(strip(b));
    expect(a.proposals.map((p) => p.id)).toEqual(["thinnest", "smallest", "balanced"]);
    expect(a.best).toBe("balanced");
  });

  it("the talking egg (round 7: 78.2 x 102 x 34.3 mm, stacked) is at most 22 mm thick, every check of the layout ok", () => {
    const input = layoutInput(talkingEgg(), specOf);
    const t0 = performance.now();
    const r = proposeWithLayouts(input);
    const ms = performance.now() - t0;
    const thin = r.proposals.find((p) => p.id === "thinnest")!;
    const bal = r.proposals.find((p) => p.id === "balanced")!;
    expect(thin.size_mm.d).toBeLessThanOrEqual(22);
    expect(bal.size_mm.d).toBeLessThan(34.3 - 8);
    expect(thin.layers.length).toBe(1); // flat: every part side by side
    for (const g of ["thinnest", "balanced"] as const) {
      const L = r.layouts[g];
      expect(L.issues.filter((i) => i.severity === "error"), g).toEqual([]);
      // the screen behind its window on the front, the grille on the back, both USB ports and the button / switch on their walls
      const kinds = L.openings.map((o) => `${o.part}:${o.kind}:${o.face}`);
      expect(kinds).toContain("eyes:window:front");
      expect(kinds).toContain("spk:grille:back");
      expect(kinds.filter((k) => k.includes(":connector:")).length).toBe(2);
      expect(kinds).toContain("btn:button:top");
      expect(kinds).toContain("sw:slot:left");
    }
    expect(thin.why.join(" ")).toMatch(/side by side/);
    expect(r.parts_volume_cm3).toBeGreaterThan(15);
    expect(thin.fill_ratio).toBeGreaterThan(0.1);
    // time budget: about 2 s on a laptop; generous here for a loaded test machine
    expect(ms).toBeLessThan(8000);
  });

  it("flat first: a roomy fixed outline gets one layer in every proposal", () => {
    const p = eggProject({ shape: "custom", outline: EGG_SVG, size_mm: { w: 120, h: 156 } });
    const r = proposeLayouts({ parts: partsX(p), enclosure: p.enclosure! });
    for (const q of r.proposals) {
      expect(q.layers.length, q.id).toBe(1);
      expect(q.misses, q.id).toEqual([]);
    }
  });

  it("a pinned part stays where it is pinned and the rest is arranged around it", () => {
    const p = talkingEgg();
    p.enclosure = { ...p.enclosure!, placements: { ...p.enclosure!.placements, bat: { x_mm: 0, y_mm: -24 } } };
    const L = layoutCase(layoutInput(p, specOf));
    const bat = L.placed.find((q) => q.mech.id === "bat")!;
    const eyes = L.placed.find((q) => q.mech.id === "eyes")!;
    // the case is centred afterwards, so compare with the screen, which is pinned too (x 0, y_mm 6)
    const scr = eyes.mech.features.find((f) => f.kind === "screen")!;
    const tip = [eyes.T[0] + eyes.R[0][0] * scr.tip[0] + eyes.R[0][1] * scr.tip[1], eyes.T[1] + eyes.R[1][0] * scr.tip[0] + eyes.R[1][1] * scr.tip[1]];
    expect((bat.bodyMin[0] + bat.bodyMax[0]) / 2 - tip[0]!).toBeCloseTo(0, 1);
    expect((bat.bodyMin[1] + bat.bodyMax[1]) / 2 - tip[1]!).toBeCloseTo(-24 - 6, 1);
    expect(L.proposal?.source).toMatch(/optimizer/);
    expect(L.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("respects the egg's narrow top: every part inside the outline, the heaviest part low", () => {
    const p = talkingEgg();
    const L = layoutCase(layoutInput(p, specOf));
    for (const q of L.placed.filter((x) => !x.bound?.feature.passThrough)) // (a switch lever pokes through the wall on purpose)
      for (const x of [q.bodyMin[0], q.bodyMax[0]])
        for (const y of [q.bodyMin[1], q.bodyMax[1]]) expect(contains(L.plan, x, y), `${q.mech.id} at (${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(true);
    const bat = L.placed.find((q) => q.mech.id === "bat")!;
    expect((bat.min[1] + bat.max[1]) / 2).toBeLessThan((L.outer.min[1] + L.outer.max[1]) / 2);
  });

  it("presets too: the Muse in a rounded box gets a thinner, pocket-sized proposal than stacking", () => {
    const r = proposeWithLayouts({ parts: partsOf(muse()), enclosure: { shape: "rounded-box" } });
    const bal = r.proposals.find((q) => q.id === "balanced")!;
    expect(bal.size_mm.d).toBeLessThan(22);
    expect(r.layouts.balanced.issues.filter((i) => i.severity === "error")).toEqual([]);
    for (const q of r.proposals) expect(Object.keys(q.placements).sort()).toEqual(r.layouts.balanced.placed.map((x) => x.mech.id).sort());
    // the views draw it: an outline and a rectangle per part, front and side
    const v = bal.views;
    expect(v.front.outline.length).toBeGreaterThan(20);
    expect(v.front.parts.length).toBe(r.layouts.balanced.placed.length);
    expect(v.side.parts.every((s) => s.z[0] < s.z[1] && s.y[0] < s.y[1])).toBe(true);
  });

  it("enclosure.layout picks the proposal the case is built from", () => {
    const p = eggProject({ shape: "custom", outline: EGG_SVG });
    for (const goal of ["thinnest", "smallest", "balanced"] as const) {
      const L = layoutCase({ parts: partsX(p), enclosure: { ...p.enclosure!, layout: goal } });
      expect(L.proposal?.id).toBe(goal);
    }
    const L = layoutCase({ parts: partsX(p), enclosure: p.enclosure! });
    expect(L.proposal?.id).toBe("balanced");
    expect(L.proposal?.asked).toBe("auto");
    void specOfX;
  });
});
