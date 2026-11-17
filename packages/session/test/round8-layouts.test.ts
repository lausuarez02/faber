// Round 8: propose_layout, check_fit's proposals and design_case / update_case {layout} on the Muse.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

const MUSE = JSON.parse(readFileSync(new URL("../../enclosure/test/fixtures/pocket-muse.json", import.meta.url), "utf8")) as Record<string, unknown>;

let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeAll(() => {
  process.env.FABER_CASE_PDF = "0";
  dir = mkdtempSync(join(tmpdir(), "faber-layouts-"));
  writeFileSync(join(dir, "faber.json"), JSON.stringify(MUSE));
  s = new ProjectSession({ dir, actor: "test" });
});
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("layout proposals through the tools", () => {
  it("propose_layout: thinnest, smallest and balanced with reasons, placements and layers; nothing written", async () => {
    const r = await call("propose_layout", { shape: "rounded-box" });
    expect(r.proposals.map((p: any) => p.id)).toEqual(["thinnest", "smallest", "balanced"]);
    expect(r.best).toBe("balanced");
    expect(r.chosen).toBe("balanced");
    const thin = r.proposals[0];
    expect(thin.size_mm.d).toBeLessThanOrEqual(r.proposals[2].size_mm.d);
    expect(thin.why.length).toBeGreaterThan(0);
    expect(Object.keys(thin.placements).length).toBeGreaterThan(4);
    expect(thin.placements.eye.face).toBe("front");
    expect(thin.views).toBeUndefined();
    expect(r.next).toMatch(/layout/);
    expect(JSON.parse(readFileSync(join(dir, "faber.json"), "utf8")).enclosure).toBeUndefined();
    const v = await call("propose_layout", { shape: "rounded-box", views: true });
    expect(v.proposals[0].views.front.parts.length).toBe(Object.keys(thin.placements).length);
    // the same project, the same answer
    expect(JSON.stringify({ ...v, ms: 0, proposals: v.proposals.map((p: any) => ({ ...p, views: undefined })) })).toBe(JSON.stringify({ ...r, ms: 0, proposals: r.proposals.map((p: any) => ({ ...p, views: undefined })) }));
  }, 60_000);

  it("check_fit returns the proposals and which one the case would use", async () => {
    const r = await call("check_fit", { shape: "rounded-box", layout: "thinnest" });
    expect(r.proposals.chosen).toBe("thinnest");
    expect(r.proposals.proposals.length).toBe(3);
    expect(r.size_mm.d).toBe(r.proposals.proposals.find((p: any) => p.id === "thinnest").size_mm.d);
  }, 60_000);

  it("design_case {layout: thinnest} builds that proposal and records it; update_case goes back to auto", async () => {
    const d = await call("design_case", { shape: "rounded-box", layout: "thinnest", images: false });
    expect(d.ok).toBe(true);
    const enc = JSON.parse(readFileSync(join(dir, "faber.json"), "utf8")).enclosure;
    expect(enc.layout).toBe("thinnest");
    const rep = JSON.parse(readFileSync(join(dir, "case", "report.json"), "utf8"));
    expect(rep.layout.goal).toBe("thinnest");
    expect(rep.layout.fill_ratio).toBeGreaterThan(0.05);
    const u = await call("update_case", { layout: "auto", images: false });
    expect(u.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "faber.json"), "utf8")).enclosure.layout).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "case", "report.json"), "utf8")).layout.goal).toBe("balanced");
  }, 240_000);
});
