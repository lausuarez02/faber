// Round 8b: the screen-window check looks through the window. Round 8's exploded render of the
// talking egg showed a red part (the speaker) in the window, and the check (sizes only) passed: it
// could not tell. Now rays straight in through the window must land on the display's active area.
import { describe, expect, it } from "vitest";
import { layoutInput } from "../src/engine.ts";
import type { Layout } from "../src/layout.ts";
import { layoutCase } from "../src/proposals.ts";
import { windowSight } from "../src/sight.ts";
import { muse, specOf } from "./helpers.ts";

const T = 120_000;

function museLayout(shape: "pebble" | "rounded-box" = "pebble"): Layout {
  return layoutCase(layoutInput({ ...muse(), enclosure: { shape } }, specOf));
}

describe("window sight", { timeout: T }, () => {
  it("the Muse: every line of sight through the window lands on the screen", () => {
    for (const shape of ["pebble", "rounded-box"] as const) {
      const s = windowSight(museLayout(shape))!;
      expect(s.ok, s.message).toBe(true);
      expect(s.seen).toBe(s.samples);
      expect(s.samples).toBeGreaterThan(10);
      expect(s.offset_mm).toBeLessThanOrEqual(0.5);
    }
  });

  it("a window cut from a stale position (8 mm off the screen) fails and says so", () => {
    const L = museLayout();
    const win = L.openings.find((o) => o.kind === "window")!;
    const moved = { ...L, openings: L.openings.map((o) => (o === win ? { ...o, at: [o.at[0] + 8 * o.uAxis[0], o.at[1] + 8 * o.uAxis[1], o.at[2] + 8 * o.uAxis[2]] as typeof o.at } : o)) };
    const s = windowSight(moved)!;
    expect(s.ok).toBe(false);
    expect(s.offset_mm).toBeCloseTo(8, 1);
    expect(s.message).toMatch(/^The screen window does not show eye's active area: .* Why: .* Fix: /);
  });

  it("another part between the window and the screen fails and is named", () => {
    const L = museLayout();
    const eye = L.placed.find((p) => p.mech.id === L.front)!;
    const other = L.placed.find((p) => p.mech.id !== L.front)!;
    // put the other part's body as a thin slab right in front of the screen
    const z = eye.bodyMax[2];
    const slab = { ...other, bodyMin: [eye.bodyMin[0] - 2, eye.bodyMin[1] - 2, z + 0.1] as typeof eye.bodyMin, bodyMax: [eye.bodyMax[0] + 2, eye.bodyMax[1] + 2, z + 0.6] as typeof eye.bodyMax };
    const s = windowSight({ ...L, placed: L.placed.map((p) => (p === other ? slab : p)) })!;
    expect(s.ok).toBe(false);
    expect(s.seen).toBe(0);
    expect(s.blocked[0]!.by).toBe(other.mech.id);
    expect(s.message).toMatch(/another part sits between the window and the screen/);
  });

  it("the display moved away from its window (nothing behind it) fails", () => {
    const L = museLayout();
    const eye = L.placed.find((p) => p.mech.id === L.front)!;
    const away = { ...eye, bodyMin: [eye.bodyMin[0] + 60, eye.bodyMin[1], eye.bodyMin[2]] as typeof eye.bodyMin, bodyMax: [eye.bodyMax[0] + 60, eye.bodyMax[1], eye.bodyMax[2]] as typeof eye.bodyMax };
    const s = windowSight({ ...L, placed: L.placed.map((p) => (p === eye ? away : p)) })!;
    expect(s.ok).toBe(false);
    expect(s.seen).toBe(0);
  });

  it("no window, no answer", () => {
    const L = museLayout();
    expect(windowSight({ ...L, openings: L.openings.filter((o) => o.kind !== "window") })).toBeUndefined();
  });
});
