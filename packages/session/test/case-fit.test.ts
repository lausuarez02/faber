// Round 7, track shape: check_fit, design_case {dry_run} and fixed sizes on the Muse. A custom
// outline is something the agent draws; a size that cannot hold the parts comes back as misses
// and tried suggestions, and nothing is saved.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

const MUSE = JSON.parse(readFileSync(new URL("../../enclosure/test/fixtures/pocket-muse.json", import.meta.url), "utf8")) as Record<string, unknown>;
const EGG = "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z";

let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeAll(() => {
  process.env.JUMPER_CASE_PDF = "0";
  dir = mkdtempSync(join(tmpdir(), "jumper-fit-"));
  writeFileSync(join(dir, "jumper.json"), JSON.stringify(MUSE));
  s = new ProjectSession({ dir, actor: "test" });
});
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("check_fit and custom outlines", () => {
  it("tests an egg the agent drew, auto size, in under a second, writing nothing", async () => {
    await call("check_fit", { shape: "custom", outline: EGG }); // warm up (JIT, the outline's distance field)
    // CPU time, best of three: the wall clock depends on what else the machine runs (the full
    // suite and other worktrees share the cores); the work itself is what must stay under a second
    const runs: Record<string, any>[] = [];
    const cpu: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c0 = process.cpuUsage();
      runs.push(await call("check_fit", { shape: "custom", outline: EGG }));
      const c = process.cpuUsage(c0);
      cpu.push((c.user + c.system) / 1000);
    }
    const r = runs[0]!;
    expect(r.fits).toBe(true);
    expect(r.size_mm.h / r.size_mm.w).toBeGreaterThan(1.2);
    expect(Math.min(...cpu)).toBeLessThan(1000);
    expect(r.misses).toEqual([]);
    expect(r.next).toMatch(/It fits .* design_case/);
    expect(r.preview).toBeUndefined();
    expect(existsSync(join(dir, "case"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")).enclosure).toBeUndefined();
    const withPreview = await call("check_fit", { outline: { points: [[0, 40], [24, 16], [28, -4], [13, -32], [-13, -32], [-28, -4], [-24, 16]], smooth: true }, preview: true });
    expect(withPreview.shape).toBe("custom"); // an outline alone means shape "custom"
    expect(withPreview.preview.outline.length).toBeGreaterThan(50);
    expect(withPreview.preview.parts.length).toBeGreaterThan(3);
  }, 60_000); // five fit tests: the CPU time of each is what is checked; the wall clock waits for a busy machine

  it("a fixed size that is too small: misses, suggestions with the calls that make them, and design_case saves nothing", async () => {
    const r = await call("check_fit", { shape: "custom", outline: EGG, size_mm: { w: 44, h: 57 } });
    expect(r.fits).toBe(false);
    expect(r.asked_mm).toEqual({ w: 44, h: 57 });
    expect(r.misses.length).toBeGreaterThan(0);
    expect(r.misses[0].message).toMatch(/sticks out [\d.]+ mm at the/);
    const bigger = r.suggestions.find((x: { kind: string }) => x.kind === "bigger");
    expect(bigger.change[0].tool).toBe("update_case");
    expect(r.next).toMatch(/does not fit/);
    const d = await call("design_case", { shape: "custom", outline: EGG, size_mm: { w: 44, h: 57 } });
    expect(d.saved).toBe(false);
    expect(d.fits).toBe(false);
    expect(d.next).toMatch(/Nothing was saved: the parts do not fit 44 x 57 x auto mm/);
    expect(JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")).enclosure).toBeUndefined();
    expect(existsSync(join(dir, "case", "report.json"))).toBe(false);
  }, 120_000);

  it("design_case dry_run is check_fit", async () => {
    const r = await call("design_case", { shape: "custom", outline: EGG, dry_run: true });
    expect(r.fits).toBe(true);
    expect(existsSync(join(dir, "case"))).toBe(false);
  });

  it("refuses bad outlines with what, why and fix", async () => {
    await expect(call("design_case", { shape: "custom" })).rejects.toThrow(/Shape "custom" needs an outline: a custom case is the front outline you draw.*Fix: pass outline/s);
    await expect(call("check_fit", { shape: "custom", outline: "M 0 0 L 40 40 L 40 0 L 0 40 Z" })).rejects.toThrow(/crosses itself near \(20, 20\) mm: a case wall cannot pass through itself. Fix:/s);
    await expect(call("design_case", { shape: "pebble", outline: EGG })).rejects.toThrow(/An outline was given with shape "pebble".*Fix: pass shape "custom"/s);
    await expect(call("design_case", { shape: "egg" })).rejects.toThrow(/Unknown case shape "egg".*an egg or a heart is a custom outline.*Fix:/s);
    await expect(call("check_fit", { shape: "custom", outline: EGG, size_mm: { w: 5 } })).rejects.toThrow(/The case setting size_mm\.w is not valid: .*Fix:/s);
  });

  it("plan_device turns a named shape into a custom outline, never a preset", async () => {
    const r = await call("plan_device", { goal: "something like the shape of an egg, with eyes and a speaker to say stuff, in my pocket" });
    const last = (r.next as string[]).find((n) => n.includes("design_case"))!;
    expect(last).toMatch(/design_case \{"shape": "custom", "outline": <the egg drawn as an SVG path in mm/);
    expect(last).toMatch(/there is no "egg" preset: draw it; check_fit first/);
  });

  it("check_fit with nothing to test says so", async () => {
    await expect(call("check_fit", {})).rejects.toThrow(/Nothing to test.*Fix: pass a shape/s);
  });
});
