// Round 15: the held-object case through the CAD kernel: closed solids, the slot really cut, and the
// object's room free of shell material (the tin goes in).
import { describe, expect, it } from "vitest";
import type { HeldObject, Project } from "@faber/project-format";
import { generateCase } from "../src/engine.ts";
import { specOf } from "./helpers.ts";

const TIN: HeldObject = { id: "tin", name: "round tin", shape: "cylinder", size_mm: { d: 66, h: 21 }, clearance_mm: 0.5, insert: "slide", from: "right" };
const project = (held: HeldObject[], shape = "rounded-box", params: Record<string, unknown> = {}): Project =>
  ({
    format: "faber/1",
    name: "holder",
    parts: [
      { id: "xiao", type: "seeed-xiao-esp32c3", x: 0, y: 0, rotation: 0 },
      { id: "epd", type: "epaper-154-ssd1681", x: 0, y: 0, rotation: 0 },
      { id: "lid", type: "reed-switch", x: 0, y: 0, rotation: 0 },
      { id: "bat", type: "lipo-battery", x: 0, y: 0, rotation: 0, props: { capacity: 150 } },
    ],
    wires: [],
    scenarios: [],
    enclosure: { shape, params, held },
  }) as unknown as Project;

describe("held objects through the CAD kernel (round 15)", { timeout: 300_000 }, () => {
  for (const [label, held, shape, params] of [
    ["slide-in from the right, rounded box", [TIN], "rounded-box", {}],
    ["pocket in the back, pebble with a flat back", [{ ...TIN, insert: "pocket", from: "back" } as HeldObject], "pebble", { edge_radius_back_mm: 2, dome_back_mm: 0 }],
  ] as const) {
    it(label, async () => {
      const g = await generateCase(project([...held], shape, { ...params }), specOf, { renders: false, stepImages: false });
      const r = g.report;
      const errors = r.checks.filter((c) => !c.ok && c.severity === "error");
      expect(errors, JSON.stringify(errors)).toEqual([]);
      expect(r.checks.find((c) => c.id === "watertight")!.ok).toBe(true);
      expect(r.held?.[0]).toMatchObject({ id: "tin", room_mm: { w: 67, h: 67, d: 22 } });
      // the shells leave the room empty: the tin's envelope does not hit them
      expect(r.checks.find((c) => c.id === "no-intersection")!.ok, JSON.stringify(r.checks.find((c) => c.id === "no-intersection"))).toBe(true);
      console.log(`${label}: ${r.size_mm.w} x ${r.size_mm.h} x ${r.size_mm.d} mm, ${r.pocket}; ${r.checks.find((c) => c.id === "held-object" && c.severity === "info")!.message}`);
    });
  }
});

// Round 15 proof (a pouch-tin case): a custom outline with an arc top, the tin in a front pocket and
// its sleeve walls clipped to the rounded rim. OpenCascade's fuse of those walls left the back
// shell's rim unsewn (200 open edges, 2 pieces); the shell fuse now checks the solid and nudges or
// leaves out the piece that breaks it.
describe("held object sleeve walls on a rounded custom outline (round 15 proof)", { timeout: 300_000 }, () => {
  it("both shells are closed solids", async () => {
    const proj = { format: "faber/1", name: "pouch-tin-case", parts: [{"id": "xiao", "type": "seeed-xiao-esp32c3", "x": 0, "y": 0, "rotation": 0}, {"id": "epd", "type": "epaper-154-ssd1681", "x": 0, "y": 0, "rotation": 0}, {"id": "lid", "type": "hall-switch-drv5032", "props": {"magnet_d_mm": 6, "magnet_grade": "N35", "magnet_mm": 3, "magnet_t_mm": 2, "version": "FB"}, "x": 0, "y": 0, "rotation": 0}, {"id": "btn", "type": "pushbutton", "x": 0, "y": 0, "rotation": 0}, {"id": "rtc", "type": "ds3231-rtc", "props": {"startTime": "2026-06-15T08:30:00"}, "x": 0, "y": 0, "rotation": 0}, {"id": "bat", "type": "lipo-battery", "props": {"capacity": 500}, "x": 0, "y": 0, "rotation": 0}], wires: [], scenarios: [], enclosure: {"shape": "custom", "params": {"color": "#2B3038", "gap_mm": 1.5, "edge_radius_front_mm": 2, "edge_radius_back_mm": 3, "dome_mm": 0, "dome_back_mm": 0}, "placements": {"lid": {"x_mm": 25, "y_mm": -1, "layer": 0}, "xiao": {"on_edge": true}}, "outline": "M -38 -30 A 38 38 0 0 1 38 -30 L 38 58 Q 38 66 30 66 L -30 66 Q -38 66 -38 58 Z", "held": [{"id": "can", "name": "Zyn can (lid on)", "shape": "cylinder", "size_mm": {"d": 70, "h": 20}, "orientation": "flat", "clearance_mm": 0.5, "insert": "pocket", "from": "front", "removable": true, "source": "measured by the owner: ~70 mm across, ~20 mm tall with the lid on (US 15-pouch can); other cans up to ~72 mm across, EU 20-pouch ~68.5 x 24 mm", "sensor": {"part": "lid", "max_mm": 8}}]} } as unknown as Project;
    const g = await generateCase(proj, specOf, { renders: false, stepImages: false });
    const wt = g.report.checks.find((c) => c.id === "watertight")!;
    expect(wt.ok, wt.message).toBe(true);
    expect(g.report.checks.filter((c) => !c.ok && c.severity === "error"), JSON.stringify(g.report.checks.filter((c) => !c.ok))).toEqual([]);
    expect(g.report.held?.[0]).toMatchObject({ id: "can", room_mm: { w: 71, h: 71, d: 21 } });
    // one sleeve wall under the arc still breaks the solid and is left out: said, not hidden
    const out = g.report.notes.filter((n) => n.includes("left out"));
    expect(out.length).toBeLessThanOrEqual(1);
    if (out.length) expect(out[0]).toMatch(/Why: .* Fix: /);
  });

  // The second proof run: the tin's lower 13 mm in a front pocket, its floor a plate just above the
  // seam. Fused under the front wall, the floor and sleeve close a void until the opening is cut:
  // a sound solid with two shells, which the first version of the check mistook for a broken one
  // and left the floor out (the tin would have dropped into the case).
  it("a pocket floor that encloses a void before its opening is cut is kept", async () => {
    const proj = { format: "faber/1", name: "pouch-tin-case-2", parts: [{"id": "xiao", "type": "seeed-xiao-esp32c3", "x": 0, "y": 0, "rotation": 0}, {"id": "epd", "type": "epaper-154-ssd1681", "x": 0, "y": 0, "rotation": 0}, {"id": "reed", "type": "reed-switch", "props": {"magnet_mm": 3}, "x": 0, "y": 0, "rotation": 0}, {"id": "btn", "type": "pushbutton", "x": 0, "y": 0, "rotation": 0}, {"id": "rtc", "type": "ds3231-rtc", "x": 0, "y": 0, "rotation": 0}, {"id": "bat", "type": "lipo-battery", "props": {"capacity": 500}, "x": 0, "y": 0, "rotation": 0}, {"id": "rpu", "type": "resistor", "props": {"resistance": 1000000}, "x": 0, "y": 0, "rotation": 0}, {"id": "rbtn", "type": "resistor", "props": {"resistance": 100000}, "x": 0, "y": 0, "rotation": 0}], wires: [], scenarios: [], enclosure: {"shape": "rounded-box", "params": {"corner_radius_mm": 12, "color": "#2B3038", "edge_radius_front_mm": 2, "dome_mm": 0}, "placements": {"can": {"face": "front", "y_mm": 24}, "epd": {"face": "front", "y_mm": -40, "rotation": 90}, "reed": {"x_mm": 37, "y_mm": 26, "layer": 0}}, "held": [{"id": "can", "name": "Zyn can body (lid stands proud)", "shape": "cylinder", "size_mm": {"d": 70, "h": 13}, "orientation": "flat", "clearance_mm": 0.3, "insert": "pocket", "from": "front", "removable": true, "source": "user's own measurement (70 mm across, 20 mm tall with lid); pocket holds the lower ~13 mm of the can so the ~7 mm lid skirt stays outside and can pop off; Zyn 15-pouch can about 68-70 mm, EU 20-pouch about 68.5 x 24 mm", "sensor": {"part": "reed", "max_mm": 10}}]} } as unknown as Project;
    const g = await generateCase(proj, specOf, { renders: false, stepImages: false });
    const wt = g.report.checks.find((c) => c.id === "watertight")!;
    expect(wt.ok, wt.message).toBe(true);
    expect(g.report.notes.join(" ")).not.toContain("left out");
    expect(g.report.held?.[0]).toMatchObject({ id: "can", room_mm: { d: 13.6 }, sleeve: expect.arrayContaining(["back"]) });
    // the floor stays out of the tin's room (it is not grown 0.3 mm towards the front like a hanging rib)
    const hit = g.report.checks.find((c) => c.id === "no-intersection")!;
    expect(hit.ok, hit.message).toBe(true);
  });
});
