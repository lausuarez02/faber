import { describe, expect, it } from "vitest";
import { safeParseProject } from "./index.ts";

// Round 17: a held object may be a socket the case rides on (engage_mm), with a fit and a magnet on
// the object; the case outline may follow a held object. All optional: round 15 projects parse unchanged.
describe("round 17 held sockets, fits, magnets and outlines that follow", () => {
  const base = { format: "jumper/1", name: "Topper", parts: [{ id: "reed", type: "reed-switch", x: 0, y: 0 }] };
  const can = { id: "can", shape: "cylinder", size_mm: { d: 70, h: 20 }, from: "back" };

  it("a round 15 held object (insert required then) still parses; insert may now be left out", () => {
    expect(safeParseProject({ ...base, enclosure: { shape: "pebble", held: [{ ...can, insert: "pocket" }] } }).ok).toBe(true);
    expect(safeParseProject({ ...base, enclosure: { shape: "pebble", held: [can] } }).ok).toBe(true);
  });

  it("accepts a socket with a fit, a magnet on the object, a sensor lift and an outline that follows it", () => {
    const r = safeParseProject({
      ...base,
      enclosure: {
        shape: "puck",
        follow: { held: "can", margin_mm: 2.5 },
        held: [{ ...can, engage_mm: 6, fit: "snap", lip_mm: 0.5, magnet: { beyond_mm: 2.5, angle_deg: 270, d_mm: 6, t_mm: 2 }, sensor: { part: "reed", max_mm: 10, lift_mm: 8 } }],
      },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.project.enclosure!.held![0]).toMatchObject({ engage_mm: 6, fit: "snap", magnet: { beyond_mm: 2.5 } });
  });

  it("rejects a bad fit, a negative engage, unknown magnet keys and a follow without its held id", () => {
    const enc = (h: Record<string, unknown>, more: Record<string, unknown> = {}) => safeParseProject({ ...base, enclosure: { shape: "puck", held: [{ ...can, ...h }], ...more } }).ok;
    expect(enc({ fit: "glue" })).toBe(false);
    expect(enc({ engage_mm: -1 })).toBe(false);
    expect(enc({ magnet: { beyond_mm: 2, strength: 9 } })).toBe(false);
    expect(enc({ magnet: { angle_deg: 90 } })).toBe(false);
    expect(enc({}, { follow: { margin_mm: 1 } })).toBe(false);
    expect(enc({}, { follow: { held: "can", margin_mm: -1 } })).toBe(false);
  });
});
