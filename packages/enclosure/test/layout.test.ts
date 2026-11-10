import { describe, expect, it } from "vitest";
import { layoutCase } from "../src/layout.ts";
import { contains, sizePlan } from "../src/plan.ts";
import { resolveMech, ROTATIONS } from "../src/mech.ts";
import { pocketVerdict } from "../src/engine.ts";
import { muse, partsOf, specOf } from "./helpers.ts";

describe("part mechanics", () => {
  it("has the 24 axis rotations", () => expect(ROTATIONS).toHaveLength(24));
  it("puts the XIAO's USB-C on its -x edge, 1 mm proud", () => {
    const m = resolveMech("xiao", specOf("seeed-xiao-rp2040")!);
    const usb = m.features.find((f) => f.id === "usb")!;
    expect(usb.n).toEqual([-1, 0, 0]);
    expect(usb.tip[0]).toBeCloseTo(-10.5 - 1, 5);
    expect(usb.expose).toBe(true);
    expect(m.features.find((f) => f.id === "rgb-led")!.expose).toBe(false);
  });
  it("reads the GC9A01 footprint as a disc plus a header tab", () => {
    const m = resolveMech("eye", specOf("gc9a01-round-tft")!);
    expect(m.footprint.map((f) => f.shape)).toEqual(["round", "rect"]);
  });
});

describe("plans", () => {
  const needs = [
    { x: -10, y: -5, inset: 0 },
    { x: 10, y: 5, inset: 1 },
  ];
  it.each(["rrect", "stadium", "circle", "ellipse"] as const)("%s contains every need", (kind) => {
    const p = sizePlan(kind, needs, { cornerRadius: 2 });
    for (const q of needs) expect(contains(p, q.x, q.y, q.inset)).toBe(true);
  });
  it("pocket verdict uses the plan_device limit", () => {
    expect(pocketVerdict({ w: 46, h: 38, d: 17 })).toBe("fits");
    expect(pocketVerdict({ w: 76, h: 72, d: 25 })).toBe("tight");
    expect(pocketVerdict({ w: 140, h: 90, d: 40 })).toBe("no");
  });
});

describe("layout of the Muse", () => {
  it.each(["pebble", "puck", "rounded-box", "pill", "keychain"] as const)("%s: every part placed, no overlaps, screen / USB / button / grille exposed", (shape) => {
    const L = layoutCase({ parts: partsOf(muse()), enclosure: { shape } });
    expect(L.placed.map((p) => p.mech.id).sort()).toEqual(muse().parts.map((p) => p.id).sort());
    expect(L.issues.filter((i) => i.severity === "error")).toEqual([]);
    for (const a of L.placed)
      for (const b of L.placed) {
        if (a === b) continue;
        const sep = [0, 1, 2].some((k) => a.max[k]! <= b.min[k]! + 1e-6 || b.max[k]! <= a.min[k]! + 1e-6);
        expect(sep, `${a.mech.id} overlaps ${b.mech.id}`).toBe(true);
      }
    const kinds = L.openings.map((o) => `${o.part}:${o.kind}:${o.face}`).sort();
    for (const k of ["chg:connector:bottom", "eye:window:front", "pet:button:right", "squeak:grille:back", "xiao:connector:bottom"]) expect(kinds).toContain(k);
    // outer box centred on the origin (R3)
    for (let k = 0; k < 3; k++) expect(L.outer.min[k]! + L.outer.max[k]!).toBeCloseTo(0, 6);
    expect(L.inner.d).toBeLessThan(L.outer.d);
  });

  it("a slide switch's lever goes through a slot in the top wall (pass-through feature)", () => {
    const p = muse();
    const parts = [...partsOf(p).filter((x) => x.id !== "pwr"), { id: "pwr", type: "slide-switch", spec: specOf("slide-switch")! }];
    for (const shape of ["pebble", "rounded-box"] as const) {
      const L = layoutCase({ parts, enclosure: { shape } });
      const slot = L.openings.find((o) => o.part === "pwr")!;
      expect(slot, shape).toBeDefined();
      expect(slot.kind).toBe("slot");
      expect(slot.face).toBe("top");
      expect(slot.standoff, "lever tip is past the inner wall").toBeLessThan(0);
      expect(L.issues.filter((i) => i.parts?.includes("pwr"))).toEqual([]);
    }
  });

  it("honours placements and exclude", () => {
    const L = layoutCase({ parts: partsOf(muse()), enclosure: { shape: "rounded-box", placements: { pet: { face: "left" } }, exclude: ["imu"] } });
    expect(L.openings.find((o) => o.part === "pet")!.face).toBe("left");
    expect(L.placed.some((p) => p.mech.id === "imu")).toBe(false);
    expect(L.outside).toEqual([{ id: "imu", why: "excluded in enclosure.exclude" }]);
  });
});
