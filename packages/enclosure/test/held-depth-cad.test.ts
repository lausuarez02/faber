// Round 17: a held object's pocket / socket depth is measured from the OUTER face of the wall it
// enters through. Round 15 measured it from the inside of the wall, so the can sat a wall deeper
// than declared (floor 15.4 mm below the outer face instead of 13.6): these tests measure the floor
// on the printed mesh.
import { describe, expect, it } from "vitest";
import type { Project } from "@faber/project-format";
import { buildCase } from "../src/geometry.ts";
import { layoutInput } from "../src/engine.ts";
import { meshOf } from "../src/mesh.ts";
import { layoutCase } from "../src/proposals.ts";
import { specOf, zHits } from "./helpers.ts";

const ROUND15 = { format: "faber/1", name: "pouch-tin-case-2", parts: [{"id": "xiao", "type": "seeed-xiao-esp32c3", "x": 0, "y": 0, "rotation": 0}, {"id": "epd", "type": "epaper-154-ssd1681", "x": 0, "y": 0, "rotation": 0}, {"id": "reed", "type": "reed-switch", "props": {"magnet_mm": 3}, "x": 0, "y": 0, "rotation": 0}, {"id": "btn", "type": "pushbutton", "x": 0, "y": 0, "rotation": 0}, {"id": "rtc", "type": "ds3231-rtc", "x": 0, "y": 0, "rotation": 0}, {"id": "bat", "type": "lipo-battery", "props": {"capacity": 500}, "x": 0, "y": 0, "rotation": 0}, {"id": "rpu", "type": "resistor", "props": {"resistance": 1000000}, "x": 0, "y": 0, "rotation": 0}, {"id": "rbtn", "type": "resistor", "props": {"resistance": 100000}, "x": 0, "y": 0, "rotation": 0}], wires: [], scenarios: [], enclosure: {"shape": "rounded-box", "params": {"corner_radius_mm": 12, "color": "#2B3038", "edge_radius_front_mm": 2, "dome_mm": 0}, "placements": {"can": {"face": "front", "y_mm": 24}, "epd": {"face": "front", "y_mm": -40, "rotation": 90}, "reed": {"x_mm": 37, "y_mm": 26, "layer": 0}}, "held": [{"id": "can", "name": "Zyn can body (lid stands proud)", "shape": "cylinder", "size_mm": {"d": 70, "h": 13}, "orientation": "flat", "clearance_mm": 0.3, "insert": "pocket", "from": "front", "removable": true, "source": "user's own measurement (70 mm across, 20 mm tall with lid); pocket holds the lower ~13 mm of the can so the ~7 mm lid skirt stays outside and can pop off; Zyn 15-pouch can about 68-70 mm, EU 20-pouch about 68.5 x 24 mm", "sensor": {"part": "reed", "max_mm": 10}}]} } as unknown as Project;

describe("a held object's depth counts from the outer face (round 17)", { timeout: 300_000 }, () => {
  it("round 15's front pocket: the floor is the declared 13.6 mm below the outer face, measured on the mesh", async () => {
    const L = layoutCase(layoutInput(ROUND15, specOf));
    const B = await buildCase(L);
    const t = L.params.wall_mm;
    const zOut = L.zFront + t;
    const can = L.placed.find((p) => p.mech.id === "can")!;
    const cx = (can.min[0] + can.max[0]) / 2;
    const cy = (can.min[1] + can.max[1]) / 2;
    const meshes = B.bodies.filter((b) => b.kind === "shell").map((b) => meshOf(b.shape, 0.02, 0.2));
    // nothing over the opening; the first surface down is the floor
    const hits = zHits(meshes, cx + 3.1, cy + 2.7);
    const floor = Math.max(...hits.filter((z) => z < zOut - 0.01));
    expect(hits.some((z) => z > zOut - 0.01)).toBe(false);
    expect(zOut - floor).toBeCloseTo(13.6, 1);
    const h = L.held![0]!;
    expect(h.depth_mm).toBeCloseTo(13.6, 1);
    // the can (13 mm declared) sits 0.6 mm below the face
    expect(h.proud_mm).toBeCloseTo(-0.6, 1);
    expect(L.issues.find((i) => i.id === "held-object" && i.severity === "info")!.message).toMatch(/the floor is 13.6 mm below the outer front face, so .* sits 0.6 mm below it/);
  });
});
