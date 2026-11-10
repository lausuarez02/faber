import { describe, expect, it } from "vitest";
import { MechanicalSchema, SourcingSchema } from "./part.ts";

// Decision 0004 (R1): the part.json "mechanical" and "sourcing" blocks.
describe("part.json mechanical block", () => {
  it("parses a board with a side USB-C port and a round screen", () => {
    const m = MechanicalSchema.parse({
      pcb_mm: 1,
      keepout_bottom_mm: 0.5,
      mounting_holes: [],
      features: [
        { id: "usb", kind: "connector", face: "-y", x: 10.5, y: 0, z: 2.6, w: 9, h: 3.3, connector: "usb-c", plug_clearance_mm: 1.5 },
        { id: "active-area", kind: "screen", face: "+z", x: 18, y: 18, shape: "round", d: 32.4, bezel_mm: 1 },
      ],
    });
    expect(m.features).toHaveLength(2);
  });

  it("rejects an unknown face and a made-up LCSC number format", () => {
    expect(MechanicalSchema.safeParse({ features: [{ id: "x", kind: "led", face: "front", x: 0, y: 0 }] }).success).toBe(false);
    expect(SourcingSchema.safeParse({ lcsc: "8598" }).success).toBe(false);
    expect(SourcingSchema.safeParse({ lcsc: "C8598", jlc: "basic" }).success).toBe(true);
  });
});
