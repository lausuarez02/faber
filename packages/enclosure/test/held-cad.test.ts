// Round 15: the held-object case through the CAD kernel: closed solids, the slot really cut, and the
// object's room free of shell material (the tin goes in).
import { describe, expect, it } from "vitest";
import type { HeldObject, Project } from "@jumper/project-format";
import { generateCase } from "../src/engine.ts";
import { specOf } from "./helpers.ts";

const TIN: HeldObject = { id: "tin", name: "round tin", shape: "cylinder", size_mm: { d: 66, h: 21 }, clearance_mm: 0.5, insert: "slide", from: "right" };
const project = (held: HeldObject[], shape = "rounded-box", params: Record<string, unknown> = {}): Project =>
  ({
    format: "jumper/1",
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
