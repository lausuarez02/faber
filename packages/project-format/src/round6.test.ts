import { describe, expect, it } from "vitest";
import { safeParseProject } from "./index.ts";

// Decision 0004 (R2, R3): the round-6 project fields are optional and validated.
describe("round 6 project fields", () => {
  const base = { format: "fabwright/1", name: "Muse", parts: [{ id: "xiao", type: "seeed-xiao-rp2040", x: 0, y: 0 }] };

  it("old projects parse unchanged", () => {
    const r = safeParseProject(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.enclosure).toBeUndefined();
  });

  it("accepts assembly, power and an enclosure", () => {
    const r = safeParseProject({
      ...base,
      assembly: "soldered",
      power: { usb: false },
      enclosure: { shape: "pebble", params: { wall_mm: 1.6, color: "#F2EDE4", closure: "screws" }, front: "eye", placements: { pet: { face: "right", y_mm: 4 } } },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a wall under 1.2 mm and an unknown shape", () => {
    expect(safeParseProject({ ...base, enclosure: { shape: "pebble", params: { wall_mm: 0.8 } } }).ok).toBe(false);
    expect(safeParseProject({ ...base, enclosure: { shape: "cube" } }).ok).toBe(false);
  });
});
