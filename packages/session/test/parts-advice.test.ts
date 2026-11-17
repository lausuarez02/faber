// Round 8 (parts-advice): Fabwright picks and suggests smaller parts by itself. check_design says which
// parts a device may not need (with the mm they cost) and plan_device picks the smallest parts that
// do the job when the person wants something to hold. The fixture is the talking egg a real Claude
// built in round 7 (jumper-evals/round7/egg/talking-egg-2: 78.2 x 102 x 34.3 mm, "bulky").
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "@fabwright/parts";
import { roleOf } from "@fabwright/enclosure";
import { parseProject, type Project } from "@fabwright/project-format";
import type { PartRegistry } from "@fabwright/sim-core";
import { checkDesign } from "../src/drc.ts";
import { planDevice } from "../src/planner.ts";
import { ProjectSession } from "../src/index.ts";

const EGG2 = parseProject(readFileSync(join(import.meta.dirname, "fixtures/talking-egg-2.json"), "utf8"));
const SENTENCE = "ok so i want something like of the shhpe of an egg, that will have eyes ... and a spekear to say stuff";
const dimsOf = (type: string, props?: Record<string, unknown>) => {
  if (type === "lipo-battery") {
    const cap = Number(props?.capacity ?? 500);
    return cap <= 100 ? { w: 30, h: 17, d: 4 } : cap <= 150 ? { w: 30, h: 20, d: 4 } : cap <= 250 ? { w: 30, h: 20, d: 5 } : cap <= 500 ? { w: 35, h: 30, d: 5 } : { w: 50, h: 34, d: 5.2 };
  }
  return registry.get(type)!.spec.dimensions_mm!;
};

function project(parts: [string, string, Record<string, unknown>?][], wires: [string, string][], extra: Partial<Project> = {}): Project {
  return parseProject({
    format: "fabwright/1",
    name: "t",
    parts: parts.map(([id, type, props], i) => ({ id, type, x: i * 100, y: 0, ...(props ? { props } : {}) })),
    wires: wires.map(([a, b], i) => {
      const [pa, ...ra] = a.split(".");
      const [pb, ...rb] = b.split(".");
      return { id: `w${i}`, from: { part: pa, pin: ra.join(".") }, to: { part: pb, pin: rb.join(".") } };
    }),
    ...extra,
  });
}

describe("check_design: parts you may not need", () => {
  const issues = checkDesign(EGG2, registry);
  const codes = issues.map((i) => i.code);

  it("the round-7 egg: its boost converter feeds only the XIAO's VBUS and the DFPlayer, which run from the cell", () => {
    const b = issues.find((i) => i.code === "boost-not-needed")!;
    expect(b.severity).toBe("info");
    expect(b.parts).toEqual(expect.arrayContaining(["boost", "xiao", "voice"]));
    expect(b.message).toMatch(/^boost \(5 V boost\) may not be needed/);
    expect(b.message).toMatch(/Why: .*DFPlayer Mini VCC takes 3.2 to 5 V/);
    expect(b.message).toMatch(/36 x 17 x 6 mm \(612 mm² of footprint, 3 g\)/);
    expect(b.message).toMatch(/Fix: remove boost and wire sw\.1 straight/);
    expect(b.message).toMatch(/keep the Schottky diode before xiao\.VBUS/);
  });

  it("…and its 28 mm speaker could be a 20 mm one, with the mm saved", () => {
    const s = issues.find((i) => i.code === "smaller-speaker")!;
    expect(s.message).toMatch(/Why: .*saves 384 mm² of footprint and 1 mm of depth.*Fix: .*speaker-20mm/);
  });

  it("only info: the egg still has no errors from the advisor and nothing else changed", () => {
    for (const c of ["boost-not-needed", "smaller-speaker"]) expect(issues.find((i) => i.code === c)!.severity).toBe("info");
    expect(codes).not.toContain("board-bigger-than-needed"); // the XIAO is already the smallest board
    expect(codes).not.toContain("combine-charge-boost"); // the boost is not needed at all, so no combined module either
  });

  const nanoServo = (cap: number) =>
    project(
      [["nano", "arduino-nano"], ["s1", "servo-sg90"], ["bat", "lipo-battery", { capacity: cap }], ["chg", "tp4056-charger"], ["sw", "slide-switch"], ["boost", "boost-converter"], ["d1", "schottky-diode"]],
      [["bat.POS", "chg.BAT"], ["bat.NEG", "chg.GND.2"], ["chg.OUT", "sw.2"], ["sw.1", "boost.VIN+"], ["boost.VIN-", "chg.GND.3"], ["boost.VOUT+", "d1.A"], ["d1.C", "nano.5V"], ["boost.VOUT-", "nano.GND.1"], ["s1.VCC", "nano.5V"], ["s1.GND", "nano.GND.2"], ["s1.SIG", "nano.D9"]],
    );

  it("a 5 V board really needs its boost: no boost-not-needed", () => {
    expect(checkDesign(nanoServo(500), registry).map((i) => i.code)).not.toContain("boost-not-needed");
  });

  it("TP4056 + boost on a 2000 mAh cell: one charge-boost module, with the footprint it saves", () => {
    const c = checkDesign(nanoServo(2000), registry).find((i) => i.code === "combine-charge-boost")!;
    expect(c.message).toMatch(/Why: charge-boost-5v .*25 x 21 x 4.5 mm.*577 mm² less footprint than both \(1102 → 525 mm²\)/);
    expect(c.message).toMatch(/45 mA/);
    expect(c.message).toMatch(/Fix: remove chg and boost, place_part charge-boost-5v/);
  });

  it("…but not on a 500 mAh cell, which its 2 A charge would stress", () => {
    expect(checkDesign(nanoServo(500), registry).map((i) => i.code)).not.toContain("combine-charge-boost");
  });

  it("an Uno in a battery device with three pins used: the Nano has the same chip (sketch unchanged) and is a fraction of the size", () => {
    const p = project(
      [["uno", "arduino-uno"], ["led1", "led"], ["r1", "resistor"], ["b1", "pushbutton"], ["bz", "buzzer"], ["bat", "battery-pack"]],
      [["uno.D13", "r1.1"], ["r1.2", "led1.A"], ["led1.C", "uno.GND.1"], ["b1.1a", "uno.D2"], ["b1.2a", "uno.GND.2"], ["bz.POS", "uno.D8"], ["bz.NEG", "uno.GND.3"], ["bat.POS", "uno.VIN"], ["bat.NEG", "uno.GND.1"]],
    );
    const b = checkDesign(p, registry).find((i) => i.code === "board-bigger-than-needed")!;
    expect(b.severity).toBe("info");
    expect(b.message).toMatch(/uses 3 GPIO pins/);
    expect(b.message).toMatch(/Arduino Nano.*same chip, so the sketch stays the same/);
    expect(b.message).toMatch(/Fix: swap uno for arduino-nano/);
    // a desk Uno (no battery, no case) is left alone
    const desk = project([["uno", "arduino-uno"], ["led1", "led"], ["r1", "resistor"]], [["uno.D13", "r1.1"], ["r1.2", "led1.A"], ["led1.C", "uno.GND.1"]]);
    expect(checkDesign(desk, registry).map((i) => i.code)).not.toContain("board-bigger-than-needed");
  });

  it("a separate charger when the board charges the LiPo itself (any board that says so in its data)", () => {
    const xiao = registry.get("seeed-xiao-rp2040")!;
    const charging = { ...xiao, spec: { ...xiao.spec, limits: { ...(xiao.spec.limits ?? {}), chargerBuiltIn: 1 } } };
    const reg: PartRegistry = { get: (t) => (t === "seeed-xiao-rp2040" ? charging : registry.get(t)), list: () => registry.list() };
    const c = checkDesign(EGG2, reg).find((i) => i.code === "charger-not-needed")!;
    expect(c.message).toMatch(/chg \(LiPo charger\) may not be needed: .*Why: .*28 x 17.5 x 5 mm.*Fix: remove chg/);
    // no simulated board charges a cell today, so the real registry never says it
    expect(checkDesign(EGG2, registry).map((i) => i.code)).not.toContain("charger-not-needed");
  });
});

describe("check_design knows the charge-boost module's power path", () => {
  it("cell → BAT, OUT (5 V) → switch → diode → a Nano's 5V: powered, no missing-pin errors, no overvoltage", () => {
    const p = project(
      [["nano", "arduino-nano"], ["bat", "lipo-battery", { capacity: 2000 }], ["pwr", "charge-boost-5v"], ["sw", "slide-switch"], ["d1", "schottky-diode"]],
      [["bat.POS", "pwr.BAT"], ["bat.NEG", "pwr.GND.2"], ["pwr.OUT", "sw.2"], ["sw.1", "d1.A"], ["d1.C", "nano.5V"], ["pwr.GND.3", "nano.GND.1"]],
      { power: { usb: false } },
    );
    const issues = checkDesign(p, registry);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain("no-power-path");
  });

  it("OUT left unconnected: says it is the 5 V output and how to wire it", () => {
    const p = project([["xiao", "seeed-xiao-rp2040"], ["bat", "lipo-battery"], ["pwr", "charge-boost-5v"]], [["bat.POS", "pwr.BAT"], ["bat.NEG", "pwr.GND.2"]]);
    const m = checkDesign(p, registry).find((i) => i.code === "unconnected-supply" && i.pins?.includes("pwr.OUT"))!;
    expect(m.message).toMatch(/5 V, the boosted battery output/);
  });
});

describe("plan_device: the smallest parts that do the job", () => {
  const plan = planDevice(SENTENCE, {}, registry);
  const types = plan.bom.map((l) => l.type);

  it("the person's egg sentence (typos and all) is compact: XIAO, SSD1306 eyes, DFPlayer, 20 mm speaker, a small cell, no booster", () => {
    expect(plan.board.type).toBe("seeed-xiao-rp2040");
    expect(types).toEqual(expect.arrayContaining(["ssd1306-oled-i2c", "dfplayer-mini", "speaker-20mm", "lipo-battery", "tp4056-charger", "slide-switch", "schottky-diode"]));
    expect(types).not.toContain("boost-converter");
    expect(types).not.toContain("speaker");
    const cell = plan.bom.find((l) => l.type === "lipo-battery")!;
    expect(Number(cell.props!.capacity)).toBeLessThanOrEqual(250);
    expect(plan.bom.find((l) => l.type === "tp4056-charger")!.props).toEqual({ chargeCurrentmA: Number(cell.props!.capacity) });
    expect(plan.battery!.hours).toBeGreaterThanOrEqual(3);
  });

  it("states the size budget and why each part is the small one", () => {
    expect(plan.summary).toMatch(/Size budget: the smallest parts that do the job, \d+ mm² laid flat/);
    const ch = plan.size_budget.choices.join("\n");
    expect(ch).toMatch(/no 5 V boost converter: .*36 x 17 x 6 mm \(612 mm²\)/);
    expect(ch).toMatch(/20 x 20 x 4 mm\) instead of the .*28 x 28 x 5 mm\): 384 mm² less/);
    expect(ch).toMatch(/250 mAh cell \(502030, 30 x 20 x 5 mm\) instead of 500 mAh/);
    expect(ch).toMatch(/a XIAO nRF52840 \(seeed-xiao-nrf52840\) charges a LiPo on the board itself.*needs Docker/);
    expect(plan.size_budget.thickest).toMatch(/DFPlayer/);
    expect(plan.warnings.join("\n")).toMatch(/power the DFPlayer from the switched battery/);
  });

  it("a smaller bill of materials than the egg Claude built in round 7 (sum of footprints, thickest part)", () => {
    let egg2Area = 0;
    let egg2Thick = 0;
    for (const p of EGG2.parts) {
      const d = dimsOf(p.type, p.props as Record<string, unknown>);
      egg2Area += d.w * d.h;
      egg2Thick = Math.max(egg2Thick, d.d);
    }
    let planArea = 0;
    let planThick = 0;
    for (const l of plan.bom) {
      const d = dimsOf(l.type!, l.props);
      planArea += d.w * d.h * l.qty;
      planThick = Math.max(planThick, d.d);
    }
    expect(Math.round(egg2Area)).toBe(4582);
    expect(planArea).toBeLessThan(egg2Area * 0.7);
    expect(plan.size_budget.footprint_mm2).toBe(Math.round(planArea));
    // the DFPlayer (8 mm) is the thickest part in both: no thinner MP3 module in the library
    expect(planThick).toBeLessThanOrEqual(egg2Thick);
    expect(planThick).toBe(8);
  });

  it("a runtime picks the cell: 8 h needs a bigger one, and says so", () => {
    const p = planDevice(SENTENCE, { battery_hours: 8 }, registry);
    expect(Number(p.bom.find((l) => l.type === "lipo-battery")!.props!.capacity)).toBe(1000);
    expect(p.battery!.hours).toBeGreaterThanOrEqual(8);
  });

  it("a desk device is not shrunk: the Uno stays, no choices", () => {
    const p = planDevice("a night light that plays a song on my desk", {}, registry);
    expect(p.board.type).toBe("arduino-uno");
    expect(p.size_budget.choices).toEqual([]);
    expect(p.summary).not.toMatch(/Size budget/);
  });

  it("compact: false turns it off; compact: true turns it on for any goal", () => {
    expect(planDevice(SENTENCE, { compact: false }, registry).bom.map((l) => l.type)).toContain("speaker");
    expect(planDevice("a box that talks", { compact: true }, registry).bom.map((l) => l.type)).toContain("speaker-20mm");
  });
});

describe("check_fit can suggest the new smaller parts", () => {
  it("the 20 and 15 mm speakers share the speaker role", () => {
    const role = roleOf(registry.get("speaker")!.spec);
    expect(roleOf(registry.get("speaker-20mm")!.spec)).toBe(role);
    expect(roleOf(registry.get("speaker-15mm")!.spec)).toBe(role);
  });

  it("the round-7 egg at a fixed size too small for it: a smaller speaker is among the swaps, tried with the layout", async () => {
    process.env.FABWRIGHT_CASE_PDF = "0";
    const dir = mkdtempSync(join(tmpdir(), "fabwright-r8-"));
    const s = new ProjectSession({ dir, actor: "test" });
    try {
      await s.call("new_project", { template: "blank", name: "egg" });
      for (const p of EGG2.parts) await s.call("place_part", { type: p.type, id: p.id, ...(p.props ? { props: p.props } : {}) });
      const r = (await s.call("check_fit", { shape: "custom", outline: EGG2.enclosure!.outline, size_mm: { w: 62, h: 80 }, try_suggestions: true })) as { fits: boolean; suggestions: { kind: string; to?: string; message: string }[] };
      expect(r.fits).toBe(false);
      const swap = r.suggestions.find((x) => x.kind === "swap" && /^speaker-(20|15)mm$/.test(x.to ?? ""));
      expect(swap, JSON.stringify(r.suggestions.map((x) => x.message))).toBeDefined();
    } finally {
      s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
