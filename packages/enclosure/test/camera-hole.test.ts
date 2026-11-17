// Round 13: a camera lens is a feature the case opens a hole for, wide enough that the wall stays
// out of the picture (the hole grows with the wall and the lens' field of view).
import { describe, expect, it } from "vitest";
import { resolveMech } from "../src/mech.ts";
import { layoutCase } from "../src/proposals.ts";
import { specOf } from "./helpers.ts";

const parts = (extra: { id: string; type: string }[] = []) => [{ id: "sense", type: "seeed-xiao-esp32s3-sense" }, ...extra].map((x) => ({ ...x, spec: specOf(x.type)! }));

describe("camera lens holes", () => {
  it("the Sense's lens is an exposed camera feature with its field of view", () => {
    const m = resolveMech("sense", specOf("seeed-xiao-esp32s3-sense")!);
    const lens = m.features.find((f) => f.id === "lens")!;
    expect(lens.kind).toBe("camera");
    expect(lens.expose).toBe(true);
    expect(lens.fov).toBe(66);
    expect(lens.n).toEqual([0, 0, 1]);
  });

  for (const shape of ["rounded-box", "pebble"] as const) {
    it(`${shape}: a round lens hole bigger than the lens by the wall's share of the view cone`, () => {
      const L = layoutCase({ parts: parts(), enclosure: { shape } });
      const o = L.openings.find((x) => x.part === "sense" && x.feature === "lens");
      expect(o, JSON.stringify(L.openings.map((x) => `${x.part}.${x.feature}`))).toBeDefined();
      expect(o!.shape).toBe("round");
      expect(o!.kind).toBe("lens");
      const behind = Math.max(0, o!.standoff) + o!.depth;
      expect(o!.u).toBeGreaterThan(6 + 2 * behind * Math.tan((33 * Math.PI) / 180));
      expect(o!.u).toBeLessThan(6 + 2 * behind * Math.tan((33 * Math.PI) / 180) + 1.5);
      // the USB-C port is still reachable
      expect(L.openings.some((x) => x.part === "sense" && x.feature === "usb")).toBe(true);
    });
  }

  it("an OV2640 module beside a round screen gets its lens hole too", () => {
    const L = layoutCase({ parts: parts([{ id: "cam", type: "ov2640-camera" }, { id: "eye", type: "gc9a01-round-tft" }]), enclosure: { shape: "rounded-box" } });
    expect(L.openings.some((x) => x.part === "cam" && x.feature === "lens")).toBe(true);
  });
});

describe("camera-view check (round 14)", () => {
  it("the case report says the lens hole is there, where, and that the view clears the wall", async () => {
    const { generateCase } = await import("../src/engine.ts");
    const p = { format: "faber/1", name: "cam", parts: [{ id: "sense", type: "seeed-xiao-esp32s3-sense", x: 0, y: 0, rotation: 0 }, { id: "bat", type: "lipo-battery", x: 0, y: 0, rotation: 0 }], wires: [], scenarios: [], enclosure: { shape: "rounded-box", params: {} } } as unknown as Parameters<typeof generateCase>[0];
    const g = await generateCase(p, specOf, { renders: false });
    const c = g.report.checks.find((x) => x.id === "camera-view");
    expect(c, JSON.stringify(g.report.checks.map((x) => x.id))).toBeDefined();
    expect(c!.ok).toBe(true);
    expect(c!.message).toMatch(/^sense\.lens: Ø\d+\.\d mm lens hole on the front at \(-?\d+\.\d, -?\d+\.\d\) mm from the centre, lens \d+\.\d mm behind the outer surface: its 66° field of view clears the wall\.$/);
    expect(c!.parts).toEqual(["sense"]);
  }, 240_000);
});
