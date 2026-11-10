// Round 7, track shape: the case outline is whatever the agent or the person draws, at any size.
// Parsing and checking outlines (SVG paths and smoothed points), packing inside the real outline
// (a narrow top holds less), fixed sizes that report what misses with swaps from the library,
// auto sizes, and a full CAD design of an egg drawn as a custom outline.
import { describe, expect, it } from "vitest";
import { checkFit } from "../src/fit.ts";
import { layoutCase } from "../src/layout.ts";
import { OutlineError, parseOutline, presetOutline, signedArea } from "../src/outline.ts";
import { contains, type Plan, polyDistance, sizePoly } from "../src/plan.ts";
import { BEAN_POINTS, catalogX, EGG_POINTS, EGG_SVG, eggProject, HEART_SVG, partsX } from "./custom-fixtures.ts";

const widthAt = (poly: [number, number][], y: number) => {
  // width of a normalised outline at height y (crossings of the horizontal line)
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
  }
  return xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0;
};

describe("custom outlines: parsing", () => {
  it("reads an egg drawn as an SVG path (y down) with the narrow end on top", () => {
    const o = parseOutline(EGG_SVG);
    expect(o.w).toBeCloseTo(56, 0);
    expect(o.h).toBeCloseTo(73, 0);
    expect(o.h / o.w).toBeGreaterThan(1.25);
    // SVG's y points down, so the path's small y (-40, the pointed end) is the top of the case
    expect(widthAt(o.poly, 0.7)).toBeLessThan(widthAt(o.poly, -0.5));
    expect(signedArea(o.poly)).toBeGreaterThan(0); // counter-clockwise
    expect(o.ctrl.length).toBeGreaterThanOrEqual(32);
  });

  it("reads points (y up) as a smooth closed curve through them", () => {
    const o = parseOutline({ points: EGG_POINTS, smooth: true });
    expect(o.w).toBeGreaterThan(55);
    expect(o.h).toBeGreaterThan(73);
    expect(widthAt(o.poly, 0.7)).toBeLessThan(widthAt(o.poly, -0.3));
  });

  it("reads relative commands, H / V and arcs", () => {
    const o = parseOutline("m 10 10 h 40 a 10 10 0 0 1 10 10 v 20 a 10 10 0 0 1 -10 10 h -40 a 10 10 0 0 1 -10 -10 v -20 a 10 10 0 0 1 10 -10 z");
    expect(o.w).toBeCloseTo(60, 0);
    expect(o.h).toBeCloseTo(40, 0);
  });

  it("rounds the sharp corners of a straight-line outline so it prints", () => {
    const o = parseOutline({ points: [[0, 0], [50, 0], [50, 30], [0, 30]], smooth: false });
    expect(o.notes.join(" ")).toMatch(/4 sharp corners were rounded/);
  });

  it.each([
    ["M 0 0 L 40 0 L 40 40", /not closed: it ends 56.6 mm from where it starts.*Fix: end the path with Z/s],
    ["M 0 0 L 40 40 L 40 0 L 0 40 Z", /crosses itself near \(20, 20\) mm.*Why: a case wall cannot pass through itself.*Fix:/s],
    ["M 0 0 L 30 0 L 30 30 Z M 50 0 L 80 0 L 80 30 Z", /2 separate shapes.*Fix: draw one shape/s],
    ["M 0 0 L 30 0 X 30 30 Z", /"X 30 30 Z" at character 14, which is not SVG path data.*Fix:/s],
    ["M 0 0 L 30 0 L 60 0 Z", /flat \(all points on one line\)/],
    ["M 0 0 C 10 Z", /"C" command is missing a number.*Why: it needs 6 numbers/s],
  ])("refuses %s with what, why and fix", (d, re) => {
    let err: unknown;
    try {
      parseOutline(d);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OutlineError);
    expect((err as Error).message).toMatch(re);
    expect((err as Error).message).toMatch(/Why: .*Fix: /s);
  });

  it("refuses a crossing list of points and a missing outline", () => {
    expect(() => parseOutline({ points: [[0, 0], [40, 40], [40, 0], [0, 40]] })).toThrow(/crosses itself/);
    expect(() => parseOutline(undefined)).toThrow(/Shape "custom" needs an outline.*Fix: pass outline/s);
  });
});

describe("custom outlines: point in the outline", () => {
  it("agrees with a brute-force test (inside and at least the wall + inset from the edge)", () => {
    const o = parseOutline(HEART_SVG);
    const w0 = 1.6;
    const plan: Plan = { kind: "poly", cx: 3, cy: -2, a: 30 - w0, b: 33 - w0, rc: 0, flats: [], poly: o.poly, ctrl: o.ctrl, w0 };
    const P = o.poly.map(([x, y]) => [3 + x * 30, -2 + y * 33] as [number, number]);
    const brute = (x: number, y: number, inset: number) => {
      let inside = false;
      let d = Infinity;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [ax, ay] = P[j]!;
        const [bx, by] = P[i]!;
        if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
        const ex = bx - ax;
        const ey = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
        d = Math.min(d, Math.hypot(ax + ex * t - x, ay + ey * t - y));
      }
      return inside && d >= w0 + inset - 1e-6;
    };
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    let bad = 0;
    for (let i = 0; i < 3000; i++) {
      const x = 3 + rnd() * 36;
      const y = -2 + rnd() * 40;
      const inset = Math.abs(rnd()) * 6;
      if (contains(plan, x, y, inset) !== brute(x, y, inset)) bad++;
    }
    expect(bad).toBe(0);
    expect(polyDistance(plan, 3, -2 + 33 + 5)).toBeLessThan(0); // above the top: outside
  });

  it("grows an outline to the smallest size that holds the points (auto) and reports the scale for a fixed size", () => {
    const o = parseOutline(EGG_SVG);
    const needs = [-15, 15].flatMap((x) => [-20, 20].map((y) => ({ x, y, inset: 2 })));
    const spec = { poly: o.poly, ctrl: o.ctrl, w0: 1.6, A0: 28, B0: 36.5 };
    const auto = sizePoly(needs, { ...spec, fixed: false });
    for (const q of needs) expect(contains(auto.plan, q.x, q.y, q.inset)).toBe(true);
    const fixed = sizePoly(needs, { ...spec, A0: 20, B0: 26, fixed: true });
    expect(fixed.scale).toBeGreaterThan(1);
    expect(fixed.plan.a + 1.6).toBeCloseTo(20, 6); // a fixed size is never scaled
  });
});

describe("custom outlines: packing", () => {
  it("packs inside the real outline: a teardrop with a narrow top keeps the big parts in its wide bottom", () => {
    // a teardrop: pointed top, round bottom (y up)
    const drop: [number, number][] = [[0, 50], [10, 30], [22, 6], [26, -14], [20, -30], [0, -38], [-20, -30], [-26, -14], [-22, 6], [-10, 30]];
    const p = eggProject({ shape: "custom", outline: { points: drop, smooth: true }, size_mm: { w: 78, h: 122 } });
    const L = layoutCase({ parts: partsX(p), enclosure: p.enclosure! });
    expect(L.fit?.fits, JSON.stringify(L.fit)).toBe(true);
    expect(L.outer.w).toBeCloseTo(78, 1);
    expect(L.outer.h).toBeCloseTo(122, 1);
    const mid = (L.outer.min[1] + L.outer.max[1]) / 2;
    const cy = (id: string) => {
      const q = L.placed.find((x) => x.mech.id === id)!;
      return (q.bodyMin[1] + q.bodyMax[1]) / 2;
    };
    // the screen (36 mm round) and the cell (35 x 30) sit where the drop is wide, not up in its point
    expect(cy("eyes")).toBeLessThan(mid + 0.1 * L.outer.h);
    expect(cy("bat")).toBeLessThan(mid + 0.1 * L.outer.h);
    // and nothing is in the pointed top quarter
    for (const q of L.placed) expect(q.bodyMax[1], q.mech.id).toBeLessThan(L.outer.max[1] - 0.2 * L.outer.h);
  });

  it("auto size: the egg grows uniformly to the smallest that holds the parts", () => {
    const p = eggProject({ shape: "custom", outline: EGG_SVG });
    const L = layoutCase({ parts: partsX(p), enclosure: p.enclosure! });
    expect(L.fit?.fits).toBe(true);
    expect(L.issues.filter((i) => i.severity === "error")).toEqual([]);
    // the egg's proportions are kept (h = 1.3 w)
    expect(L.outer.h / L.outer.w).toBeGreaterThan(1.22);
    expect(L.outer.h / L.outer.w).toBeLessThan(1.38);
    expect(L.plan.kind).toBe("poly");
  });

  it("a preset with a fixed size becomes an outline of exactly that size", () => {
    const o = presetOutline("pebble", 70, 90);
    expect(o.w).toBeCloseTo(70, 0);
    const p = eggProject({ shape: "pebble", size_mm: { w: 72, h: 96 } });
    const L = layoutCase({ parts: partsX(p), enclosure: p.enclosure! });
    expect(L.fit?.fits, JSON.stringify(L.fit)).toBe(true);
    expect([L.outer.w, L.outer.h]).toEqual([72, 96]);
  });
});

describe("custom outlines: rethink the pieces", () => {
  it("a fixed size that is too small reports each miss and swaps that fit, never growing by itself", () => {
    // the egg device in a 56 x 73 mm egg (auto makes it bigger): the 1.28" round screen is the trouble
    const p = eggProject({ shape: "custom", outline: EGG_SVG, size_mm: { w: 56, h: 73 } });
    const r = checkFit({ parts: partsX(p), enclosure: p.enclosure!, catalog: catalogX() }, { budgetMs: 60_000 });
    expect(r.fits).toBe(false);
    expect(r.size_mm.w).toBeCloseTo(56, 1); // the case stays the asked size
    expect(r.size_mm.h).toBeCloseTo(73, 1);
    expect(r.needed_mm.w).toBeGreaterThan(56);
    expect(r.misses.length).toBeGreaterThan(0);
    for (const m of r.misses) {
      expect(m.short_mm).toBeGreaterThan(0);
      expect(m.dimension).toBe("outline");
      expect(m.message).toMatch(/sticks out [\d.]+ mm at the (top|bottom|left|right)/);
    }
    const by = (kind: string, to?: string) => r.suggestions.find((s) => s.kind === kind && (to === undefined || s.to === to));
    // the round screen for a smaller one (the sketch's display code changes), tried: it fits
    const oled = by("swap", "ssd1306-oled-i2c")!;
    expect(oled.part).toBe("eyes");
    expect(oled.fits).toBe(true);
    expect(oled.tradeoff).toMatch(/display code changes/);
    expect(oled.change.map((c) => c.tool)).toEqual(["remove", "place_part", "connect"]);
    // rounder edges take room: a smaller round-over, tried
    expect(by("finish")?.fits).toBe(true);
    // a smaller LiPo cell is considered (it does not fit on its own here, so it may be left out as not helping)
    // and "or make it N mm bigger" with the size that holds every part
    const bigger = by("bigger")!;
    expect(bigger.message).toMatch(/Or make it [\d.]+ mm wider and [\d.]+ mm taller/);
    expect(bigger.change[0]).toEqual({ tool: "update_case", args: { size_mm: { w: expect.any(Number), h: expect.any(Number) } } });
    expect((bigger.change[0]!.args.size_mm as { w: number }).w).toBeGreaterThanOrEqual(r.needed_mm.w);
    // every other suggestion was tried: it says whether it then fits and the size it needs
    for (const s of r.suggestions.filter((x) => x.kind !== "bigger")) {
      expect(typeof s.fits).toBe("boolean");
      expect(s.size_mm!.w).toBeGreaterThan(0);
    }
    // the preview marks the parts that stick out
    expect(r.preview.parts.some((q) => q.collides)).toBe(true);
    expect(r.preview.outline.length).toBeGreaterThan(50);
  }, 120_000);

  it("suggests the 20 mm speaker when the 28 mm one does not fit, and a smaller cell when the cell is the trouble", () => {
    // a small egg with a board, a speaker and a cell: the 28 mm speaker is the widest thing
    const p = eggProject({ shape: "custom", outline: EGG_SVG, size_mm: { w: 42 } });
    p.parts = p.parts.filter((x) => ["xiao", "spk", "bat"].includes(x.id)).map((x) => (x.id === "bat" ? { ...x, props: { capacity: 150 } } : x));
    const r = checkFit({ parts: partsX(p), enclosure: p.enclosure!, catalog: catalogX() }, { budgetMs: 60_000 });
    expect(r.fits).toBe(false);
    expect(r.asked_mm?.w).toBe(42);
    const spk = r.suggestions.find((s) => s.kind === "swap" && s.part === "spk")!;
    expect(spk.to).toBe("speaker-20mm");
    expect(spk.fits).toBe(true);
    expect(spk.tradeoff).toMatch(/quieter/);
    // a 1000 mAh cell (50 x 34 mm) in an egg that holds the 500 mAh one
    const q = eggProject({ shape: "custom", outline: EGG_SVG, size_mm: { w: 60, h: 78 } });
    const fits500 = checkFit({ parts: partsX(q), enclosure: q.enclosure! }, { suggest: false });
    expect(fits500.fits).toBe(true);
    q.parts = q.parts.map((x) => (x.id === "bat" ? { ...x, props: { capacity: 1000 } } : x));
    const r2 = checkFit({ parts: partsX(q), enclosure: q.enclosure!, catalog: catalogX() }, { budgetMs: 60_000 });
    expect(r2.fits).toBe(false);
    const cell = r2.suggestions.find((s) => s.kind === "smaller-cell")!;
    expect(cell.part).toBe("bat");
    expect(cell.to).toMatch(/^500 mAh \(503035, 35 x 30 x 5 mm\)/);
    expect(cell.fits).toBe(true);
    expect(cell.change).toEqual([{ tool: "set_part_property", args: { id: "bat", prop: "capacity", value: 500 } }]);
    expect(cell.tradeoff).toMatch(/50 % of the battery life/);
  }, 120_000);

  it("a fixed depth that is too thin is a depth miss naming the thickest parts", () => {
    const p = eggProject({ shape: "custom", outline: EGG_SVG, size_mm: { d: 12 } });
    const L = layoutCase({ parts: partsX(p), enclosure: p.enclosure! }, { quick: true });
    expect(L.fit?.fits).toBe(false);
    expect(L.fit?.depthMiss?.available_mm).toBe(12);
    expect(L.fit?.depthMiss?.needed_mm).toBeGreaterThan(12);
    expect(L.issues.find((i) => i.id === "fits")?.message).toMatch(/stack is .* mm deep for a 12 mm case.*Why: the size is fixed.*Fix: swap a part/s);
  });

  it("answers a fit test in under a second without CAD", () => {
    const p = eggProject({ shape: "custom", outline: { points: BEAN_POINTS, smooth: true }, size_mm: { w: 80, h: 60 } });
    checkFit({ parts: partsX(p), enclosure: p.enclosure! }, { suggest: false }); // warm up (JIT, distance field)
    // CPU time, best of three: the wall clock depends on what else the machine runs
    const ms = [0, 1, 2].map(() => {
      const c0 = process.cpuUsage();
      checkFit({ parts: partsX(p), enclosure: p.enclosure! }, { suggest: false });
      const c = process.cpuUsage(c0);
      return (c.user + c.system) / 1000;
    });
    expect(Math.min(...ms)).toBeLessThan(1000);
  });
});
