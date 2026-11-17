// Round 6, case track (decision 0004, R3 to R5): design_case / update_case / get_case /
// export_manufacturing on the Muse. The case config is an undoable faber.json edit; the files in
// case/ are outputs regenerated from the config + the parts' mechanical data.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

const MUSE = JSON.parse(readFileSync(new URL("../../enclosure/test/fixtures/pocket-muse.json", import.meta.url), "utf8")) as Record<string, unknown>;
const T = 240_000;

let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeAll(() => {
  process.env.FABER_CASE_PDF = "0";
  dir = mkdtempSync(join(tmpdir(), "faber-case-"));
  writeFileSync(join(dir, "faber.json"), JSON.stringify(MUSE));
  s = new ProjectSession({ dir, actor: "test" });
});
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("case tools", () => {
  it("says there is no case yet, with the fix", async () => {
    await expect(call("get_case")).rejects.toThrow(/No case yet.*Fix: design_case \{"shape": "pebble"\}/s);
    await expect(call("update_case", { params: { wall_mm: 2 } })).rejects.toThrow(/No case yet/);
  });

  it("refuses bad settings with what, why and fix", async () => {
    await expect(call("design_case", { shape: "cube" })).rejects.toThrow(/Unknown case shape "cube".*rounded-box, pill, pebble, puck, keychain/s);
    await expect(call("design_case", { shape: "pebble", params: { wall_mm: 0.8 } })).rejects.toThrow(/wall_mm.*at least 1\.2/s);
    await expect(call("design_case", { shape: "pebble", placements: { ghost: { face: "left" } } })).rejects.toThrow(/"ghost".*not in the project/s);
  });

  it(
    "design_case saves the config (undoable) and writes every file",
    async () => {
      const r = await call("design_case", { shape: "rounded-box", why: "a box first" });
      expect(r.ok).toBe(true);
      expect(r.pocket).toMatch(/fits|tight|no/); // thickness first: the Muse in a box is about 24.7 mm thick (bulky)
      expect(r.size_mm.w).toBeGreaterThan(30);
      expect(r.image_files.map((p: string) => p.split("/").slice(-2).join("/"))).toEqual(["renders/front.png", "renders/exploded.png"]);
      for (const f of ["stl/front.stl", "stl/back.stl", "stl/cap-pet.stl", "case.3mf", "step/assembly.step", "step/front.step", "step/back.step", "renders/front.png", "renders/back.png", "renders/exploded.png", "renders/inside.png", "drawing/drawing.svg", "PRINT.md", "report.json", "manifest.json"]) expect(existsSync(join(dir, "case", f)), f).toBe(true);
      expect(r.missing.map((m: { item: string }) => m.item)).toEqual(["drawing/drawing.pdf"]);
      const saved = JSON.parse(readFileSync(join(dir, "faber.json"), "utf8"));
      expect(saved.enclosure).toEqual({ shape: "rounded-box" });
      // undo takes the config away; get_case then has nothing
      await call("undo");
      expect(JSON.parse(readFileSync(join(dir, "faber.json"), "utf8")).enclosure).toBeUndefined();
      await expect(call("get_case")).rejects.toThrow(/No case yet/);
      await call("redo");
      const g = await call("get_case");
      expect(g.stale).toBe(false);
      expect(g.shape).toBe("rounded-box");
    },
    T,
  );

  it(
    "update_case merges params and placements (null removes one); get_case regenerates stale files",
    async () => {
      const u = await call("update_case", { params: { closure: "screws", color: "#2B3038" }, placements: { pet: { face: "left" } } });
      expect(u.enclosure.params.closure).toBe("screws");
      expect(u.checks.find((c: { id: string }) => c.id === "buttons-reachable").message).toMatch(/on the left/);
      const u2 = await call("update_case", { placements: { pet: null } });
      expect(u2.enclosure.placements).toEqual({});
      expect(u2.enclosure.params.color).toBe("#2B3038");
      // a stale manifest (another branch, a changed part) → regenerated on read
      const mf = join(dir, "case", "manifest.json");
      writeFileSync(mf, readFileSync(mf, "utf8").replace(/"hash": "[0-9a-f]+"/, '"hash": "old"'));
      const g = await call("get_case");
      expect(g.stale).toBe(true);
      expect(JSON.parse(readFileSync(mf, "utf8")).hash).toBe(g.hash);
    },
    T,
  );

  it(
    "design_case {save: false} writes a variant and leaves faber.json alone",
    async () => {
      const before = readFileSync(join(dir, "faber.json"), "utf8");
      const r = await call("design_case", { shape: "puck", save: false, images: false });
      expect(r.dir).toBe(join(dir, "case", "variants", "puck"));
      expect(existsSync(join(dir, "case", "variants", "puck", "stl", "front.stl"))).toBe(true);
      expect(readFileSync(join(dir, "faber.json"), "utf8")).toBe(before);
      expect(r.image_files).toBeUndefined();
    },
    T,
  );

  it(
    "export_manufacturing writes the factory pack and a zip, and says what is missing",
    async () => {
      const r = await call("export_manufacturing", {});
      expect(r.dir).toMatch(/manufacturing\/pocket-muse-v\d+$/);
      for (const f of ["README.md", "README.zh-CN.md", "NOTES.md", "BOM.csv", "BOM.md", "electronics/WIRING.md", "electronics/netlist.csv", "electronics/faber.net", "electronics/WIRE-CUTS.csv", "assembly/ASSEMBLY.md", "test/TEST-PLAN.md", "test/TEST-ON-HARDWARE.md", "enclosure/stl/front.stl", "enclosure/step/assembly.step", "manifest.json"]) expect(r.files, f).toContain(f);
      expect(r.files.some((f: string) => f.startsWith("enclosure/variants"))).toBe(false);
      // the fixture has no firmware: the pack says so and how to fix it
      expect(r.missing.find((m: { item: string }) => m.item === "firmware/")).toMatchObject({ fix: expect.stringContaining("build") });
      const bom = readFileSync(join(r.dir, "BOM.csv"), "utf8").split("\n");
      expect(bom[0]).toBe("line,refs,qty,name,value,mpn,manufacturer,lcsc,jlc,package,generic,unit_usd,ext_usd,buy_url,source,notes");
      expect(bom.find((l) => l.startsWith("1,xiao,"))).toContain("102010428");
      expect(bom.some((l) => l.includes("Heat-set insert"))).toBe(true); // screws closure from update_case
      expect(bom.some((l) => /breadboard|Dupont/i.test(l))).toBe(false); // soldered build
      expect(readFileSync(join(r.dir, "electronics/faber.net"), "utf8")).toMatch(/^\(export \(version D\)/);
      expect(readFileSync(join(r.dir, "electronics/netlist.csv"), "utf8").split("\n")[0]).toBe("net,part,pin");
      expect(readFileSync(join(r.dir, "README.zh-CN.md"), "utf8")).toContain("没有 PCB");
      const mf = JSON.parse(readFileSync(join(r.dir, "manifest.json"), "utf8"));
      expect(mf.case_hash).toBeTruthy();
      expect(mf.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
      const z = unzipSync(readFileSync(r.zip));
      expect(Object.keys(z).some((k) => k.endsWith("/BOM.csv"))).toBe(true);
    },
    T,
  );
});
