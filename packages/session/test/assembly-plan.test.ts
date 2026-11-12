// Round 12: "can I ask Claude for all the pieces I need to build it, and what to print, and how it
// goes inside". get_assembly_plan on the Muse in a pebble: what to buy (parts + wire + Kapton +
// foam), what to print (each STL with its bed face), the steps with a picture each, how each part
// is held; design_case's answer summarises it; check_design carries the assembly checks; the
// factory pack's ASSEMBLY.md is the plan with its pictures and WIRE-CUTS.csv has the book slack.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

// the Muse as Claude built it (with its slide switch and diode in the battery path)
const MUSE = JSON.parse(readFileSync(new URL("../../../examples/agent-built/claude-pocket-muse/jumper.json", import.meta.url), "utf8")) as Record<string, unknown>;
const T = 300_000;

let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeAll(() => {
  process.env.JUMPER_CASE_PDF = "0";
  process.env.JUMPER_COSTS_BUDGET_MS = "1000";
  dir = mkdtempSync(join(tmpdir(), "jumper-assembly-"));
  writeFileSync(join(dir, "jumper.json"), JSON.stringify({ ...MUSE, enclosure: undefined }));
  s = new ProjectSession({ dir, actor: "test" });
});
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("get_assembly_plan", () => {
  it("without a case says what to do first", async () => {
    await expect(call("get_assembly_plan")).rejects.toThrow(/No case yet.*the assembly plan is how the parts go into the case.*design_case/s);
  });

  it(
    "the pieces to buy and print, and the steps with pictures",
    async () => {
      const d = await call("design_case", { shape: "pebble", costs: false, images: false });
      // design_case's answer summarises the plan and points at it
      expect(d.assembly.steps).toBeGreaterThan(10);
      expect(d.assembly.order.front).toContain("eye");
      expect(d.assembly.how).toMatch(/get_assembly_plan/);
      expect(d.next).toMatch(/get_assembly_plan/);
      expect(d.checks.some((c: { id: string }) => c.id === "assembly-wires")).toBe(true);

      const r = await call("get_assembly_plan", { images: true });
      // to buy: the parts, and what the build needs on top (wire, Kapton and a foam pad for the cell)
      const buy = r.buy.map((b: { name: string }) => b.name).join(" | ");
      expect(buy).toMatch(/Seeed XIAO RP2040/);
      expect(buy).toMatch(/Hook-up wire 24 AWG/);
      expect(buy).toMatch(/Kapton/);
      expect(buy).toMatch(/Foam pad/);
      // to print: every STL, with the face that goes on the bed
      expect(r.print.map((p: { file: string }) => p.file)).toEqual(expect.arrayContaining(["case/stl/front.stl", "case/stl/back.stl", "case/stl/cap-pet.stl"]));
      expect(r.print.find((p: { file: string }) => p.file === "case/stl/front.stl").face_down).toBe("front");
      // the steps: plain words, a picture each (on disk), flash first, the battery late, closing near the end
      expect(r.steps.length).toBe(d.assembly.steps);
      for (const st of r.steps) {
        expect(st.say.length).toBeGreaterThan(20);
        expect(existsSync(st.image_file), st.image_file).toBe(true);
      }
      const titles = r.steps.map((st: { title: string }) => st.title);
      expect(titles.findIndex((t: string) => /Flash/.test(t))).toBeLessThan(titles.findIndex((t: string) => /^Solder/.test(t)));
      expect(titles.findIndex((t: string) => /Test it on USB/.test(t))).toBeLessThan(titles.findIndex((t: string) => /battery bat/.test(t)));
      expect(titles.at(-2)).toBe("Close the case");
      expect(r.image_files.length).toBeGreaterThanOrEqual(3);
      expect(r.mounts.find((m: { part: string }) => m.part === "pwr").insert).toBe("slide");
      expect(r.consumables.map((c: { item: string }) => c.item).join(" ")).toMatch(/Kapton/);
      expect(r.tools.join(" ")).toMatch(/soldering iron/);
      expect(r.opens_on).toMatch(/left|right|top|bottom/);
      expect(r.next).toMatch(/what to buy and print/);
    },
    T,
  );

  it("check_design carries the assembly warnings of the built case", async () => {
    const c = await call("check_design");
    expect(c.case).toBeUndefined();
    expect(c.issues.some((i: string) => /\[assembly-/.test(i))).toBe(true);
  }, T);

  it(
    "the factory pack: ASSEMBLY.md is the plan with its pictures, the cut list has the book slack",
    async () => {
      const r = await call("export_manufacturing", { zip: false });
      const md = readFileSync(join(r.dir, "assembly", "ASSEMBLY.md"), "utf8");
      expect(md).toMatch(/## Print/);
      expect(md).toMatch(/## How each part is held/);
      expect(md).toMatch(/!\[Step 1\]\(\.\.\/enclosure\/assembly\/step-01\.png\)/);
      expect(md).toMatch(/Open it like a book/);
      expect(existsSync(join(r.dir, "enclosure", "assembly", "step-01.png"))).toBe(true);
      const plan = (await call("get_assembly_plan")) as { wires: { id: string; length_mm: number; open_mm?: number }[] };
      const csv = readFileSync(join(r.dir, "electronics", "WIRE-CUTS.csv"), "utf8").trim().split("\n").slice(1);
      for (const w of plan.wires.filter((x) => x.open_mm)) {
        const row = csv.find((l) => l.startsWith(`${w.id},`))!;
        expect(Number(row.split(",")[4]), w.id).toBeGreaterThanOrEqual(w.open_mm!);
      }
      expect(readFileSync(join(r.dir, "BOM.csv"), "utf8")).toMatch(/Kapton/);
    },
    T,
  );
  it(
    "after a rewire the plan is made again (no CAD) and says its pictures are from the last build",
    async () => {
      const w = (s.project.wires as { id: string }[])[0]!.id;
      await call("disconnect", { wire: w });
      const r = await call("get_assembly_plan");
      expect(r.pictures).toMatch(/the wires changed since the case was built/);
      expect(r.steps.every((st: { image_file?: string }) => !st.image_file)).toBe(true);
      expect(r.wires.some((x: { id: string }) => x.id === w)).toBe(false);
    },
    T,
  );

});
