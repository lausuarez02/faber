// Round 8 (view): the parts advice as notes for the Case view, and its Apply button. Apply runs the
// same operations an agent would (remove, place_part, connect) as one undoable step, and afterwards
// the advice no longer fires and nothing new is wrong. Fixture: the talking egg a real Claude built.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registry } from "@jumper/parts";
import { parseProject } from "@jumper/project-format";
import { checkDesign } from "../src/drc.ts";
import { adviceNotes, opsForApply, ProjectSession } from "../src/index.ts";

const RAW = readFileSync(join(import.meta.dirname, "fixtures/talking-egg-2.json"), "utf8");
const EGG = parseProject(RAW);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function session(): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-advice-"));
  dirs.push(dir);
  writeFileSync(join(dir, "jumper.json"), RAW);
  return new ProjectSession({ dir, actor: "test" });
}

async function apply(s: ProjectSession, id: string) {
  const ops = opsForApply(s.project, s.registry, id);
  for (const o of ops) await s.call(o.op, { ...o.args, why: `apply ${id}` }, { actor: "web" });
  return ops;
}

describe("advice notes", () => {
  it("say what may not be needed in plain words, with the mm saved, and which ones one click can make", () => {
    const notes = adviceNotes(EGG, registry);
    const boost = notes.find((n) => n.code === "boost-not-needed")!;
    expect(boost.title).toBe("The 5 V booster (boost) may not be needed");
    expect(boost.saves.area_mm2).toBe(612);
    expect(boost.apply?.label).toBe("Remove boost");
    const spk = notes.find((n) => n.code === "smaller-speaker")!;
    expect(spk.saves).toEqual({ area_mm2: 384, depth_mm: 1 });
    expect(spk.apply?.label).toBe("Swap to 20 mm");
    for (const n of notes) expect(`${n.title} ${n.why}`).not.toMatch(/check_design|place_part|get_part|plan_device|update_case/);
  });

  it("Apply on the speaker swaps it for the 20 mm one, same id, same wires, one step", async () => {
    const s = session();
    try {
      const before = s.project.wires.filter((w) => w.from.part === "spk" || w.to.part === "spk").map((w) => [w.from, w.to].map((e) => `${e.part}.${e.pin}`).sort().join("-")).sort();
      const steps0 = s.history.steps.length;
      await apply(s, "smaller-speaker:spk");
      expect(s.project.parts.find((p) => p.id === "spk")!.type).toBe("speaker-20mm");
      const after = s.project.wires.filter((w) => w.from.part === "spk" || w.to.part === "spk").map((w) => [w.from, w.to].map((e) => `${e.part}.${e.pin}`).sort().join("-")).sort();
      expect(after).toEqual(before);
      expect(s.history.steps.length - steps0).toBe(1);
      expect(adviceNotes(s.project, s.registry).some((n) => n.code === "smaller-speaker")).toBe(false);
      // the case placement for spk (grille at the back) still applies to the new part
      expect(s.project.enclosure?.placements?.spk?.face).toBe("back");
    } finally {
      s.dispose();
    }
  });

  it("Apply on the boost removes it and wires the switched battery straight to what it fed; nothing new is wrong", async () => {
    const s = session();
    try {
      const errs0 = checkDesign(s.project, s.registry).filter((i) => i.severity === "error").map((i) => i.code);
      const ops = await apply(s, "boost-not-needed:boost");
      expect(ops[0]!.op).toBe("remove");
      expect(s.project.parts.some((p) => p.id === "boost")).toBe(false);
      const ws = s.project.wires.map((w) => [w.from, w.to].map((e) => `${e.part}.${e.pin}`).sort().join("-"));
      expect(ws).toContain("d1.A-sw.1"); // the diode before the XIAO's VBUS stays
      // the XIAO's ground (it was on the boost's output ground) is still ground
      const { buildNets } = await import("@jumper/project-format");
      const gnd = buildNets(s.project).find((n) => n.pins.some((p) => p.part === "chg" && p.pin === "GND.3"))!;
      expect(gnd.pins.some((p) => p.part === "xiao" && p.pin.startsWith("GND"))).toBe(true);
      // and undo takes the whole change back in one step
      await s.call("undo", {}, { actor: "web" });
      expect(s.project.parts.some((p) => p.id === "boost")).toBe(true);
      await apply(s, "boost-not-needed:boost");
      const after = checkDesign(s.project, s.registry);
      expect(after.some((i) => i.code === "boost-not-needed")).toBe(false);
      expect(after.filter((i) => i.severity === "error").map((i) => i.code)).toEqual(errs0);
    } finally {
      s.dispose();
    }
  });

  it("a note that no longer holds cannot be applied, and says why and what to do", () => {
    expect(() => opsForApply(EGG, registry, "board-bigger-than-needed:xiao")).toThrow(/no longer holds.*Fix: reload/);
  });
});
