// Round 15: an agent declares what the case holds (a tin) through design_case, and the report and the
// build kit carry its sizes and how to check them; a bad declaration says what to fix.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;
const TIN = { id: "tin", name: "round tin", shape: "cylinder", size_mm: { d: 66, h: 21 }, insert: "slide", from: "right", source: "measured with calipers", sensor: { part: "lid", max_mm: 12 } };

describe("round 15: design_case with a held object", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "faber-held-"));
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("check_fit and design_case take held; the report says the room, the opening and the walls", async () => {
    await call(s, "new_project", { template: "xiao-esp32c3" });
    await call(s, "place_part", { type: "epaper-154-ssd1681", id: "epd" });
    await call(s, "place_part", { type: "reed-switch", id: "lid" });
    await call(s, "place_part", { type: "lipo-battery", id: "bat", props: { capacity: 150 } });
    const fit = await call(s, "check_fit", { shape: "rounded-box", held: [TIN], costs: false });
    expect(JSON.stringify(fit.issues ?? [])).toMatch(/round tin/);
    const r = await call(s, "design_case", { shape: "rounded-box", held: [TIN], images: false, costs: false });
    const report = (r.report ?? r) as Record<string, any>;
    expect(report.held?.[0]).toMatchObject({ id: "tin", name: "round tin", room_mm: { w: 67, h: 67, d: 22 }, from: "right", source: "measured with calipers" });
    const checks = report.checks as { id: string; severity: string; message: string; ok: boolean }[];
    expect(checks.find((c) => c.id === "held-object" && c.severity === "info")!.message).toMatch(/slot of 67 x 22 mm on the right/);
    expect(checks.some((c) => c.id === "held-sensor")).toBe(true);
    expect(s.project.enclosure?.held?.[0]?.id).toBe("tin");
  });

  it("the build kit has a 'What it holds' section with the sizes and the calipers check", async () => {
    const k = await call(s, "get_build_kit", {});
    const holds = (k.kit ?? k).holds ?? k.holds;
    expect(holds?.[0]).toMatchObject({ name: "round tin", object_mm: { w: 66, h: 66, d: 21 }, room_mm: { w: 67, h: 67, d: 22 }, clearance_mm: 0.5 });
    const md = ["build-kit/holder-kit/KIT.md", ...[] as string[]].map((p) => join(dir, p)).find(existsSync) ?? findKitMd(dir);
    expect(md).toBeDefined();
    const text = readFileSync(md!, "utf8");
    expect(text).toMatch(/## What it holds/);
    expect(text).toMatch(/Measure your own round tin with calipers/);
  });

  it("a bad declaration says what is wrong, why and the fix", async () => {
    await expect(call(s, "update_case", { held: [{ ...TIN, size_mm: { d: 66 } }] })).rejects.toThrow(/cylinder but size_mm has no d \(diameter\) and h \(height\)/);
    await expect(call(s, "update_case", { held: [{ ...TIN, id: "lid" }] })).rejects.toThrow(/also a part id/);
  });
});

function findKitMd(dir: string): string | undefined {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const walk = (d: string): string | undefined => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        const f = walk(p);
        if (f) return f;
      } else if (n === "KIT.md") return p;
    }
    return undefined;
  };
  return existsSync(join(dir, "build-kit")) ? walk(join(dir, "build-kit")) : undefined;
}
