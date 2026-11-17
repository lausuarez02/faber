// Round 7 integration (lead): the two tracks together. The talking egg built with the REAL voice
// parts (dfplayer-mini + speaker) inside an egg the agent DRAWS as a custom outline (no preset):
// it fits at auto size, the speaker's grille is cut in the back, and a fixed size that is too small
// says what misses and which pieces to rethink. Quick layout only (no CAD); the full CAD egg is
// packages/enclosure/test/custom-cad.test.ts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registry } from "@fabwright/parts";
import { layoutCase, layoutInput } from "@fabwright/enclosure";
import { ProjectSession } from "../src/index.ts";
import { planDevice } from "../src/planner.ts";

const EGG = "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z";
let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeAll(async () => {
  process.env.FABWRIGHT_CASE_PDF = "0";
  dir = mkdtempSync(join(tmpdir(), "fabwright-r7-"));
  s = new ProjectSession({ dir, actor: "test" });
  await call("new_project", { template: "blank", name: "Talking egg" });
  for (const [type, id, props] of [
    ["seeed-xiao-rp2040", "xiao", undefined],
    ["gc9a01-round-tft", "eyes", undefined],
    ["dfplayer-mini", "df1", { clips: "1: hello, I am an egg\n2: whoa, I am dizzy" }],
    ["speaker", "spk1", undefined],
    ["resistor", "r1", { resistance: 1000 }],
    ["lipo-battery", "bat", { capacity: 500 }],
    ["tp4056-charger", "chg", undefined],
    ["slide-switch", "sw1", undefined],
  ] as const) await call("place_part", { type, id, ...(props ? { props } : {}) });
  for (const [from, to] of [["xiao.D6", "r1.1"], ["r1.2", "df1.RX"], ["df1.TX", "xiao.D7"], ["df1.SPK_1", "spk1.+"], ["df1.SPK_2", "spk1.-"]]) await call("connect", { from: from!, to: to! });
});
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("round 7 integration: the talking egg", () => {
  it("plan_device turns the person's words into a screen for the eyes, a voice, and a drawn custom outline", () => {
    const p = planDevice("ok so i want something like of the shape of an egg, that will have eyes, it should fit there and i want it to have eyes and a speaker to say stuff", {}, registry);
    const types = p.bom.map((l) => l.type);
    expect(types).toContain("dfplayer-mini");
    expect(types.some((t) => /^speaker/.test(t ?? ""))).toBe(true); // round 8: a compact egg picks the 20 mm speaker
    expect(types.some((t) => /oled|tft/.test(t ?? ""))).toBe(true);
    expect(p.next.join("\n")).toMatch(/"shape": "custom", "outline"/);
    expect(p.next.join("\n")).toMatch(/there is no "egg" preset: draw it/);
  });

  it("the real voice parts fit an egg the agent drew, auto size, with the speaker grille in the back", async () => {
    const r = await call("check_fit", { shape: "custom", outline: EGG });
    expect(r.fits).toBe(true);
    expect(r.shape).toBe("custom");
    expect(r.size_mm.h / r.size_mm.w).toBeGreaterThan(1.2);
    expect(r.size_mm.h / r.size_mm.w).toBeLessThan(1.4);
    expect(r.misses).toEqual([]);
    // the same layout design_case cuts: the speaker's grille is a field of holes in the back
    const p = JSON.parse(readFileSync(join(dir, "fabwright.json"), "utf8"));
    const L = layoutCase(layoutInput({ ...p, enclosure: { shape: "custom", outline: EGG } }, (t) => registry.get(t)?.spec));
    const g = L.openings.find((o) => o.kind === "grille" && o.part === "spk1")!;
    expect(g.face).toBe("back");
    expect(g.holes!.length).toBeGreaterThanOrEqual(19);
    expect(L.placed.map((x) => x.mech.id)).toEqual(expect.arrayContaining(["eyes", "df1", "spk1", "bat", "chg", "sw1", "xiao"]));
  }, 60_000);

  it("a fixed egg a bit too small: what misses, and the pieces to rethink, each tried", async () => {
    const r = await call("check_fit", { shape: "custom", outline: EGG, size_mm: { w: 60, h: 78 }, try_suggestions: true });
    expect(r.fits).toBe(false);
    expect(r.misses.length).toBeGreaterThan(0);
    const kinds = r.suggestions.map((x: { kind: string }) => x.kind);
    expect(kinds).toContain("bigger");
    // rethinking pieces, not only growing: a smaller cell, a smaller screen for the eyes, or flatter rims
    expect(kinds.some((k: string) => k === "smaller-cell" || k === "swap" || k === "finish")).toBe(true);
    for (const x of r.suggestions) expect(x.change.length).toBeGreaterThan(0);
    const d = await call("design_case", { shape: "custom", outline: EGG, size_mm: { w: 60, h: 78 } });
    expect(d.saved).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "fabwright.json"), "utf8")).enclosure).toBeUndefined();
  }, 120_000);
});
