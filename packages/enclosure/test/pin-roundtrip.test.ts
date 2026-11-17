// Round 8 (view): every proposal says, per part, the placements that pin it where it is. The Case
// view drags a part by adding the move to those values, so pinning a part at its own pin values must
// keep it there (the rest arranged around it), whatever the face its opening goes through.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@faber/project-format";
import { describe, expect, it } from "vitest";
import { layoutInput } from "../src/engine.ts";
import { layoutCase, proposeLayouts } from "../src/proposals.ts";
import { specOf } from "./helpers.ts";

function talkingEgg(): Project {
  const p = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/talking-egg-2.json"), "utf8")) as Project;
  return { ...p, scenarios: p.scenarios ?? [], wires: p.wires ?? [] };
}

const centre = (L: ReturnType<typeof layoutCase>, id: string) => {
  const p = L.placed.find((q) => q.mech.id === id)!;
  return [(p.bodyMin[0] + p.bodyMax[0]) / 2, (p.bodyMin[1] + p.bodyMax[1]) / 2] as const;
};

describe("proposal pins", { timeout: 120_000 }, () => {
  it("each part's pin values, given back as placements, keep every part where the proposal put it (every part pinned at once)", () => {
    const egg = talkingEgg();
    const r = proposeLayouts(layoutInput(egg, specOf));
    const bal = r.proposals.find((p) => p.id === "balanced")!;
    // every part has pin values; a side-wall part only slides along its wall
    for (const [id, pl] of Object.entries(bal.placements)) {
      expect(pl.pin, id).toBeDefined();
      if (pl.face === "left" || pl.face === "right") expect(pl.pin.x_mm, id).toBeUndefined();
      if (pl.face === "top" || pl.face === "bottom") expect(pl.pin.y_mm, id).toBeUndefined();
      if (pl.face === "back") expect(pl.pin.x_sign, id).toBe(-1);
    }
    const placements = { ...egg.enclosure!.placements };
    for (const [id, pl] of Object.entries(bal.placements)) placements[id] = { ...(placements[id] ?? {}), ...(pl.pin.x_mm !== undefined ? { x_mm: pl.pin.x_mm } : {}), ...(pl.pin.y_mm !== undefined ? { y_mm: pl.pin.y_mm } : {}) };
    const pinned = layoutCase(layoutInput({ ...egg, enclosure: { ...egg.enclosure!, placements } }, specOf));
    // the same arrangement: every part within half a millimetre of where the proposal had it, relative to the screen
    const ref0 = [bal.placements.eyes!.x_mm, bal.placements.eyes!.y_mm];
    const ref1 = centre(pinned, "eyes");
    for (const [id, pl] of Object.entries(bal.placements)) {
      const c = centre(pinned, id);
      expect(Math.abs(c[0] - ref1[0] - (pl.x_mm - ref0[0]!)), `${id} x`).toBeLessThan(0.6);
      expect(Math.abs(c[1] - ref1[1] - (pl.y_mm - ref0[1]!)), `${id} y`).toBeLessThan(0.6);
    }
    expect(pinned.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("moving one part by its pin values moves it by that much against the outline; the rest re-arranges", () => {
    const egg = talkingEgg();
    const r = proposeLayouts(layoutInput(egg, specOf));
    const bal = r.proposals.find((p) => p.id === "balanced")!;
    const bat = bal.placements.bat!;
    const placements = { ...egg.enclosure!.placements, bat: { x_mm: bat.pin.x_mm! + bat.pin.x_sign * 4, y_mm: bat.pin.y_mm! - 3 } };
    const L = layoutCase(layoutInput({ ...egg, enclosure: { ...egg.enclosure!, placements } }, specOf));
    const c = centre(L, "bat");
    // the outline is centred on the case, so its frame and the packing frame agree to within the centring shift
    const o = L.origin ?? [0, 0, 0];
    expect(c[0] - o[0] - (bat.pin.x_mm! + 4)).toBeCloseTo(0, 0);
    expect(c[1] - o[1] - (bat.pin.y_mm! - 3)).toBeCloseTo(0, 0);
    expect(L.placed.length).toBe(Object.keys(bal.placements).length);
  });
});
