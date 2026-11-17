// Round 17: an agent makes a case that rides on a held object (a puck on a can's lid) through
// design_case: a socket (engage_mm), a magnet on the object, and an outline that follows it. The
// report says how deep the socket is, how far the can stands proud and the switch's gap mounted
// and lifted; bad declarations say what to fix.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;
const CAN = { id: "can", name: "pouch can", shape: "cylinder", size_mm: { d: 70, h: 20 }, from: "back", engage_mm: 6, fit: "slip", clearance_mm: 0.3, source: "test", magnet: { beyond_mm: 2.5, d_mm: 6, t_mm: 2 }, sensor: { part: "reed", max_mm: 10, lift_mm: 8 } };
const ENC = { shape: "puck", params: { edge_radius_front_mm: 2.5, edge_radius_back_mm: 1, dome_mm: 0, dome_back_mm: 0 }, follow: { held: "can", margin_mm: 2.5 }, placements: { reed: { x_mm: 0, y_mm: -33.5, layer: 1 } }, held: [CAN] };

describe("round 17: a lid-topper through design_case", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fabwright-socket-"));
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("design_case takes a socket, a magnet on the object and follow; the report says depth, proud and the gaps", async () => {
    await call(s, "new_project", { template: "xiao-esp32c3" });
    await call(s, "place_part", { type: "epaper-154-ssd1681", id: "epd" });
    await call(s, "place_part", { type: "reed-switch", id: "reed" });
    await call(s, "place_part", { type: "lipo-battery", id: "bat", props: { capacity: 300 } });
    const r = await call(s, "design_case", { ...ENC, images: false, costs: false });
    const report = (r.report ?? r) as Record<string, any>;
    expect(report.size_mm.w).toBeCloseTo(79, 0);
    expect(report.held?.[0]).toMatchObject({ id: "can", engage_mm: 6, depth_mm: 6, proud_mm: 14 });
    expect(report.held[0].sensing.mounted_mm).toBeLessThanOrEqual(10);
    expect(report.held[0].sensing.lifted_mm).toBeGreaterThan(10);
    const checks = report.checks as { id: string; severity: string; message: string }[];
    expect(checks.find((c) => c.id === "held-sensor")!.message).toMatch(/"set": "reed.magnet_mm"/);
    expect(s.project.enclosure?.follow).toEqual({ held: "can", margin_mm: 2.5 });
  });

  it("check_design shows the held-sensor warning when the switch would not let go at the lift (hysteresis, round 17 proof)", async () => {
    // a 6 x 2 mm magnet closing at 10 mm: the reed lets go only past ~12 mm; a 1 mm lift is not enough
    await call(s, "update_case", { held: [{ ...CAN, sensor: { part: "reed", max_mm: 10, lift_mm: 1 } }], images: false, costs: false });
    const d = await call(s, "check_design");
    const w = (d.issues as string[]).find((i) => i.includes("[held-sensor]"));
    expect(w).toMatch(/^warning \[held-sensor\] reed still sees .* only lets go beyond [\d.]+ mm .*Why: .*hysteresis.*Fix: /);
  });

  it("follow without its held object, or with size_mm, and a too-deep socket say what to fix", async () => {
    await expect(call(s, "update_case", { follow: { held: "tin" } })).rejects.toThrow(/follow names "tin", which is not a held object/);
    await expect(call(s, "update_case", { size_mm: { w: 90 } })).rejects.toThrow(/follow and size_mm w \/ h are both set/);
    await expect(call(s, "update_case", { held: [{ ...CAN, engage_mm: 25 }] })).rejects.toThrow(/engage_mm 25, but the object is only 20 mm long/);
  });
});
