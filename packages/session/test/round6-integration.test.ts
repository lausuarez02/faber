// Round 6 integration (lead): the five tracks together on the pocket Muse, the plan's case step and
// board-aware wiring in get_part.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { registry } from "@faber/parts";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { AGENT_LOOP } from "../src/catalog.ts";
import { ProjectSession, planDevice } from "../src/index.ts";

const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};
let dir = "";
let s: ProjectSession | undefined;
afterEach(() => {
  s?.dispose();
  s = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});
const call = (op: string, args: Record<string, unknown> = {}) => s!.call(op, args) as Promise<Record<string, any>>;

describe("round 6 integration", () => {
  it("the Muse example: battery-powered, 0 DRC errors, colour frames in its log, pebble case + puck variant", () => {
    const p = JSON.parse(readFileSync(join(MUSE, "faber.json"), "utf8"));
    expect(p.power).toEqual({ usb: false });
    expect(p.enclosure?.shape).toBe("pebble");
    const log = readFileSync(join(MUSE, "agent-actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const colour = log.filter((e) => JSON.stringify(e).includes('"color":{'));
    expect(colour.length).toBeGreaterThan(0);
    for (const v of ["case", "case/variants/puck"]) {
      const r = JSON.parse(readFileSync(join(MUSE, v, "report.json"), "utf8"));
      expect(r.ok, v).toBe(true);
      for (const f of ["stl/front.stl", "stl/back.stl", "case.3mf", "step/assembly.step", "renders/front.png", "drawing/drawing.svg", "PRINT.md"]) expect(existsSync(join(MUSE, v, f)), `${v}/${f}`).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(MUSE, "case/report.json"), "utf8")).shape).toBe("pebble");
    expect(JSON.parse(readFileSync(join(MUSE, "case/variants/puck/report.json"), "utf8")).shape).toBe("puck");
  });

  it("the Muse's check_design has 0 errors and its case is current (no regeneration needed)", async () => {
    dir = mkdtempSync(join(tmpdir(), "faber-r6-"));
    cpSync(MUSE, dir, { recursive: true });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "firmware/main.hex"), later, later);
    s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
    const c = await call("check_design");
    expect(c.errors, c.issues.join("\n")).toBe(0);
    const g = await call("get_case", { images: false });
    expect(g.regenerated ?? false).toBe(false);
    expect(g.report?.shape ?? g.shape).toBe("pebble");
  }, 60_000);

  it("get_part gives the wiring for the project's own board", async () => {
    dir = mkdtempSync(join(tmpdir(), "faber-r6-"));
    s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
    await call("new_project", { template: "blank" });
    await call("place_part", { type: "seeed-xiao-rp2040", id: "xiao" });
    const g = await call("get_part", { type: "ssd1306" });
    expect(g.wiring_on_this_board).toMatch(/GP6/);
    expect(g.wiring_on_this_board).toMatch(/xiao\.<pin>/);
  });

  it("plan_device and the agent loop end with the case and the factory pack", () => {
    const p = planDevice("a virtual pet that fits in my pocket", { pocket: true }, registry);
    const last = p.next.at(-1)!;
    expect(last).toMatch(/design_case/);
    expect(last).toMatch(/export_manufacturing/);
    expect(p.cannot_check.join(" ")).not.toMatch(/does not model the enclosure/);
    expect(AGENT_LOOP).toMatch(/design_case[\s\S]*export_manufacturing/);
  });
});

describe("round 6 integration: errors", () => {
  it("move_part with 'part' instead of 'id' says which argument to pass (no internal error)", async () => {
    dir = mkdtempSync(join(tmpdir(), "faber-r6-"));
    s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
    await call("new_project", { template: "blink" });
    await expect(call("move_part", { part: "led1", x: 10, y: 10 })).rejects.toThrow(/No part id was given/);
  });
});
