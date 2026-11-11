// Round 8b: the case tools say what each of the agent's choices costs, steer a fixed size to the
// sizes that work, and tell agents (tool descriptions, server instructions, AGENTS.md, plan_device)
// not to pin, dome or size by guesswork. The talking egg a real Claude rebuilt on round-8 code:
// 74 x 96 x 44.4 mm, a 6 mm dome, the eyes and the speaker pinned on the front.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "@jumper/parts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_LOOP, planDevice, ProjectSession, TOOLS } from "../src/index.ts";

const EGG = readFileSync(new URL("../../enclosure/test/fixtures/talking-egg-round8.json", import.meta.url), "utf8");
const AGENTS_MD = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8");

let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeAll(() => {
  process.env.JUMPER_CASE_PDF = "0";
  dir = mkdtempSync(join(tmpdir(), "jumper-costs-"));
  writeFileSync(join(dir, "jumper.json"), EGG);
  s = new ProjectSession({ dir, actor: "test" });
});
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("costs in the case tools", () => {
  it("propose_layout: the saved egg's costs, the dome among the costliest, each with the update_case call; the next step says to relax them", async () => {
    const r = await call("propose_layout", {});
    // the fixed outline is laid out thin: no longer round 7's 44.4 mm stack
    expect(r.proposals.find((p: any) => p.id === "balanced").size_mm.d).toBeLessThan(40);
    expect(r.costs.base.d).toBeGreaterThan(0);
    const dome = r.costs.costs.find((c: any) => c.id === "dome");
    expect(dome.adds_mm).toBeGreaterThanOrEqual(7);
    expect(dome.message).toMatch(/Fix: update_case \{"params":\{"dome_mm":1\.5\}\}/);
    expect(r.costs.relax_all.without.d).toBeLessThanOrEqual(22);
    expect(r.next).toMatch(/What makes it bigger \(costs\): /);
    expect(r.next).toMatch(/Relax the costly choices unless the person asked for them/);
    // costs: false skips them (the Case view asks for them on their own)
    const q = await call("propose_layout", { costs: false });
    expect(q.costs).toBeUndefined();
  }, 120_000);

  it("check_fit has costs too; a fixed size that fails gives the sizes that work instead of a guess", async () => {
    const r = await call("check_fit", {});
    expect(r.fits).toBe(true);
    expect(r.costs.costs.length).toBeGreaterThan(0);
    // design_case at a size that is too small: nothing saved, the sizes that work (flat and stacked) and what breaks it
    const before = readFileSync(join(dir, "jumper.json"), "utf8");
    const m = await call("design_case", { shape: "custom", outline: JSON.parse(EGG).enclosure.outline, size_mm: { w: 44, h: 57 }, params: { dome_mm: 6 }, images: false });
    expect(m.saved).toBe(false);
    expect(m.sizes_that_work.length).toBeGreaterThan(0);
    expect(m.sizes_that_work[0].label).toMatch(/flat \(1 layer\)|stacked/);
    expect(m.next).toMatch(/Sizes this outline works at: .*size_mm \{"w": [\d.]+, "h": [\d.]+\}/);
    expect(m.next).toMatch(/do not guess sizes/);
    expect(readFileSync(join(dir, "jumper.json"), "utf8")).toBe(before);
  }, 180_000);
});

describe("agent guidance", () => {
  const desc = (name: string) => TOOLS.find((t) => t.name === name)!.description;
  it("tool descriptions: do not pin unless asked, dome and edges on auto, propose_layout first, read costs, 20 mm for a pocket", () => {
    expect(desc("design_case")).toMatch(/Before it: propose_layout/);
    expect(desc("design_case")).toMatch(/Do not pin positions \(placements\) unless the person asked; leave dome_mm and the edges on auto/);
    expect(desc("design_case")).toMatch(/20 mm thick or less/);
    expect(desc("design_case")).not.toMatch(/"dome_mm": 3/);
    expect(desc("propose_layout")).toMatch(/costs/);
    expect(desc("propose_layout")).toMatch(/relax the costly choices/);
    expect(desc("check_fit")).toMatch(/sizes_that_work/);
    const params = JSON.stringify(TOOLS.find((t) => t.name === "design_case")!.inputSchema);
    expect(params).toMatch(/Only for what the person asked for/);
    expect(params).toMatch(/each mm adds a mm of thickness on each face/);
  });

  it("server instructions and AGENTS.md say the same", () => {
    for (const text of [AGENT_LOOP, AGENTS_MD.replace(/\s+/g, " ")]) {
      expect(text).toMatch(/do not pin/i);
      expect(text).toMatch(/dome_mm`? and the edges on auto/);
      expect(text).toMatch(/costs/);
      expect(text).toMatch(/20 mm thick or less/);
    }
    expect(AGENT_LOOP).toMatch(/call propose_layout before design_case/);
  });

  it("plan_device for a small / pocket / egg goal puts the case guidance in its plan; a desk device does not", () => {
    for (const goal of ["a talking egg with eyes that says things", "a tiny pocket pet that beeps", "a small handheld dice roller with a screen"]) {
      const p = planDevice(goal, {}, registry);
      const line = p.next.find((n) => n.startsWith("case: "));
      expect(line, goal).toBeDefined();
      expect(line).toMatch(/20 mm thick or less/);
      expect(line).toMatch(/Do not pin positions/);
      expect(line).toMatch(/leave dome_mm and the edges on auto/);
      expect(line).toMatch(/propose_layout before design_case/);
      expect(line).toMatch(/costs/);
    }
    const desk = planDevice("a desk clock that shows the temperature, plugged into USB", {}, registry);
    expect(desk.next.some((n) => n.startsWith("case: "))).toBe(false);
  });
});
