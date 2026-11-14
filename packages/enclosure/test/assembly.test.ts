// Round 12: the assembly plan on any case shape (an egg drawn by an agent, the Muse pebble, a
// rounded box, a concave star): the order is physically possible, every part is held, and the
// design-for-assembly checks fire on crafted bad layouts with the sizes behind them. No CAD here
// (the layout only); the mounting features' CAD is in assembly-cad.test.ts.
import { describe, expect, it } from "vitest";
import type { Project } from "@jumper/project-format";
import { assemblyPlan, type AssemblyPlan } from "../src/assembly.ts";
import { layoutInput } from "../src/engine.ts";
import type { Layout } from "../src/layout.ts";
import { layoutCase } from "../src/proposals.ts";
import { muse, specOf } from "./helpers.ts";
import { egg, starPoints } from "./assembly-fixtures.ts";

const T = 120_000;

const CASES: [string, () => Project][] = [
  ["egg (custom outline, an agent's)", egg],
  ["Muse pebble", () => ({ ...muse(), enclosure: { shape: "pebble" } })],
  ["Muse rounded-box", () => ({ ...muse(), enclosure: { shape: "rounded-box" } })],
  ["Muse in a puffy star (custom, concave)", () => ({ ...muse(), enclosure: { shape: "custom", outline: { points: starPoints(), smooth: true } } }) as Project],
];

function planOf(p: Project, tweak?: (L: Layout) => void): { L: Layout; plan: AssemblyPlan } {
  const L = layoutCase(layoutInput(p, specOf));
  tweak?.(L);
  return { L, plan: assemblyPlan({ project: p, layout: L, specOf }) };
}

function overlapXY(a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }): boolean {
  return a.min[0]! < b.max[0]! - 0.05 && b.min[0]! < a.max[0]! - 0.05 && a.min[1]! < b.max[1]! - 0.05 && b.min[1]! < a.max[1]! - 0.05;
}

describe("assembly plan: a physically possible order on any shape", () => {
  it.each(CASES)(
    "%s",
    (_name, make) => {
      const p = make();
      const { L, plan } = planOf(p);
      const ids = L.placed.map((q) => q.mech.id);
      // every part has a mount, a shell, and goes in exactly once
      expect(plan.mounts.map((m) => m.part).sort()).toEqual([...ids].sort());
      const placedSteps = plan.steps.filter((s) => ["place", "press-fit", "tape", "glue"].includes(s.action) && (s.shell === "front" || s.shell === "back"));
      const inOrder = placedSteps.flatMap((s) => s.parts).filter((x) => ids.includes(x));
      expect([...inOrder].sort(), "each part placed once").toEqual([...ids].sort());
      expect(new Set(inOrder).size).toBe(ids.length);
      // a part another one covers (same shell, overlapping in plan, nearer the shell's wall) goes in first
      const at = (id: string) => inOrder.indexOf(id);
      const shell = new Map(plan.mounts.map((m) => [m.part, m.shell]));
      for (const a of L.placed)
        for (const b of L.placed) {
          if (a === b || shell.get(a.mech.id) !== shell.get(b.mech.id) || !overlapXY(a, b)) continue;
          const sh = shell.get(a.mech.id);
          const under = sh === "front" ? a.min[2] >= b.max[2] - 0.5 : a.max[2] <= b.min[2] + 0.5;
          if (under) expect(at(a.mech.id), `${a.mech.id} before ${b.mech.id} (it is under it in the ${sh} shell)`).toBeLessThan(at(b.mech.id));
        }
      // the case can close: no front-shell part behind an overlapping back-shell part
      for (const a of L.placed)
        for (const b of L.placed)
          if (shell.get(a.mech.id) === "front" && shell.get(b.mech.id) === "back" && overlapXY(a, b)) expect(a.max[2], `${a.mech.id} (front) is not behind ${b.mech.id} (back)`).toBeGreaterThan(b.min[2] + 0.05);
      expect(plan.checks.filter((c) => c.id === "assembly-close" || c.id === "assembly-insert")).toEqual([]);
      // flashing first, wires soldered only once their parts are in, the power test before the battery, closing near the end
      const n = (pred: (s: AssemblyPlan["steps"][number]) => boolean) => plan.steps.findIndex(pred);
      const flash = n((s) => s.action === "flash");
      const firstSolderInShell = n((s) => s.action === "solder" && (s.shell === "front" || s.shell === "back"));
      expect(flash).toBeGreaterThanOrEqual(0);
      if (firstSolderInShell >= 0) expect(flash).toBeLessThan(firstSolderInShell);
      for (const [i, s] of plan.steps.entries()) {
        if (s.action !== "solder" || (s.shell !== "front" && s.shell !== "back")) continue;
        const before = new Set(plan.steps.slice(0, i).flatMap((x) => (["place", "press-fit", "tape"].includes(x.action) ? x.parts : [])));
        // (an end on a part riding in the wiring, a resistor in line, was soldered on the bench)
        for (const w of s.wires) for (const e of [w.from, w.to]) if (ids.includes(e.split(".")[0]!)) expect(before.has(e.split(".")[0]!), `step ${s.n}: ${e} is in before ${w.id} is soldered`).toBe(true);
      }
      // a wire to a part riding in the wiring has its other end soldered once that end's part is in (not only on the bench)
      for (const w of plan.wires.filter((x) => x.route === "harness")) {
        const placedEnds = [w.from, w.to].filter((e) => ids.includes(e.split(".")[0]!));
        if (!placedEnds.length) continue;
        expect(plan.steps.some((x) => x.shell !== "bench" && x.wires.some((y) => y.id === w.id)), `${w.id} (${w.from} to ${w.to}) is soldered to its part in a step`).toBe(true);
      }
      // the tests name only what this device has
      const look = plan.steps.filter((x) => x.action === "test" && /USB before the battery|Final test/.test(x.title)).map((x) => x.say).join(" ");
      const kinds = new Set(L.placed.flatMap((q) => q.mech.features.filter((f) => f.expose !== false).map((f) => f.kind)));
      if (!kinds.has("screen")) expect(look).not.toMatch(/screen/);
      if (!kinds.has("button")) expect(look).not.toMatch(/button/);
      if (!kinds.has("grille")) expect(look).not.toMatch(/sound/);
      const usbTest = n((s) => s.action === "test" && /USB before the battery/.test(s.title));
      const battery = n((s) => /battery/i.test(s.title) && s.action === "tape");
      const close = n((s) => s.action === "close" || s.action === "screw");
      expect(usbTest).toBeGreaterThan(0);
      if (battery >= 0) {
        expect(usbTest).toBeLessThan(battery);
        expect(battery).toBeLessThan(close);
        expect(plan.steps[battery]!.cautions.join(" ")).toMatch(/swell|pierce|press/);
      }
      expect(close).toBe(plan.steps.length - 2);
      expect(plan.steps.at(-1)!.action).toBe("test");
      // the wires between the shells are long enough to open it like a book
      for (const w of plan.wires.filter((x) => x.route === "between")) expect(w.length_mm).toBeGreaterThanOrEqual(w.open_mm ?? 0);
      // every step says something in plain words, numbered from 1
      plan.steps.forEach((s, i) => {
        expect(s.n).toBe(i + 1);
        expect(s.say.length).toBeGreaterThan(20);
      });
      // consumables: wire and solder always; a cell brings Kapton and a foam pad
      expect(plan.consumables.some((c) => /hook-up wire/.test(c.item))).toBe(p.wires.length > 0);
      if (L.placed.some((q) => q.mech.soft)) expect(plan.consumables.map((c) => c.item).join(" ")).toMatch(/Kapton.*Foam pad/);
    },
    T,
  );

  it("a part whose lever pokes through a hole in one shell slides in before what would block its way", () => {
    const { plan } = planOf({ ...muse(), enclosure: { shape: "pebble" } });
    const pwr = plan.mounts.find((m) => m.part === "pwr")!;
    expect(pwr.insert).toBe("slide");
    const step = plan.steps.find((s) => s.parts.includes("pwr") && s.action === "place")!;
    expect(step.title).toMatch(/^Slide pwr/);
    expect(step.cautions.join(" ")).toMatch(/push the lever through its slot/);
  }, T);

  it("a cell nothing goes over is placed last, connected after the USB test, insulated", () => {
    const { plan } = planOf({ ...muse(), enclosure: { shape: "pebble" } });
    const bat = plan.steps.find((s) => s.parts.includes("bat") && s.action === "tape")!;
    expect(bat.title).toMatch(/battery/);
    expect(bat.wires.map((w) => w.id).sort()).toEqual(["w17", "w18"]);
    expect(bat.say).toMatch(/foam pad/);
    expect(bat.say).toMatch(/Kapton/);
    expect(plan.checks.find((c) => c.id === "assembly-battery")!.severity).toBe("info");
  }, T);
});

describe("design-for-assembly checks fire on bad layouts, with the facts", () => {
  const pebble = () => ({ ...muse(), enclosure: { shape: "pebble" as const } });

  it("wires that do not fit the wiring room", () => {
    const { plan } = planOf(pebble(), (L) => {
      L.params.gap_mm = 0.8;
    });
    const c = plan.checks.find((x) => x.id === "assembly-wires")!;
    expect(c.ok).toBe(false);
    expect(c.severity).toBe("error");
    expect(c.message).toMatch(/thickest is 1.3 mm .* wiring room round each part is 0.8 mm/);
    expect(c.message).toMatch(/Fix: update_case \{"params": \{"gap_mm"/);
    expect(c.facts!.wiring_room_mm).toBe(0.8);
  }, T);

  it("a front-shell part behind a back-shell part: the case cannot close", () => {
    const { plan } = planOf(pebble(), (L) => {
      // move the screen (front-bound) behind the cell (back shell) where they overlap in plan
      const eye = L.placed.find((p) => p.mech.id === "eye")!;
      const bat = L.placed.find((p) => p.mech.id === "bat")!;
      const dz = bat.min[2] - 0.5 - eye.max[2];
      for (const k of ["min", "max", "bodyMin", "bodyMax"] as const) eye[k] = [eye[k][0], eye[k][1], eye[k][2] + dz];
    });
    const c = plan.checks.find((x) => x.id === "assembly-close" && x.parts?.includes("bat"))!;
    expect(c.severity).toBe("error");
    expect(c.message).toMatch(/cannot close: eye goes into the front shell but sits behind bat .* \(they overlap [\d.]+ x [\d.]+ mm seen from the front\)/);
    expect(c.parts).toEqual(["eye", "bat"]);
  }, T);

  it("a lever that cannot slide in: no room behind it", () => {
    const { plan } = planOf(pebble(), (L) => {
      const m = L.mounts.find((x) => x.part === "pwr")!;
      m.slide = { ...m.slide!, have_mm: 1.5 };
    });
    const c = plan.checks.find((x) => x.id === "assembly-insert")!;
    expect(c.severity).toBe("error");
    expect(c.message).toMatch(/pwr .* cannot go in: .* only 1.5 mm of room behind it/);
    expect(c.facts).toEqual({ need_mm: 4.5, have_mm: 1.5 });
  }, T);

  it("two parts that each must go in before the other", () => {
    const { plan } = planOf(pebble(), (L) => {
      // the switch slides out from its wall: put the charger in its slide path and under it
      const pwr = L.placed.find((p) => p.mech.id === "pwr")!;
      const chg = L.placed.find((p) => p.mech.id === "chg")!;
      const cx = (pwr.bodyMin[0] + pwr.bodyMax[0]) / 2 - (chg.min[0] + chg.max[0]) / 2;
      const cy = pwr.bodyMin[1] - 3 - (chg.min[1] + chg.max[1]) / 2;
      const cz = pwr.min[2] - 0.2 - chg.max[2];
      for (const k of ["min", "max", "bodyMin", "bodyMax"] as const) chg[k] = [chg[k][0] + cx, chg[k][1] + cy, chg[k][2] + cz];
      // make it overlap the switch in plan and sit just behind it, in the switch's path
      chg.max = [chg.max[0], Math.max(chg.max[1], pwr.min[1] + 1), pwr.min[2] + 0.4];
    });
    const c = plan.checks.find((x) => x.id === "assembly-insert" && /No order/.test(x.message))!;
    expect(c.severity).toBe("error");
    expect(c.message).toMatch(/pwr must slide in before chg .* but chg goes in first because it lies under pwr/);
  }, T);

  it("a hard edge near the cell", () => {
    const { plan } = planOf(pebble(), (L) => {
      const bat = L.placed.find((p) => p.mech.id === "bat")!;
      L.posts.push({ x: (bat.bodyMin[0] + bat.bodyMax[0]) / 2, y: (bat.bodyMin[1] + bat.bodyMax[1]) / 2, z0: bat.bodyMax[2] + 0.2, z1: L.zFront, d: 3, shell: "front", why: "holds down something", kind: "hold-down" });
    });
    const c = plan.checks.find((x) => x.id === "assembly-battery")!;
    expect(c.severity).toBe("warning");
    expect(c.message).toMatch(/may be pressed by a hard edge: a post \(holds down something\) 0.2 mm from the cell/);
    expect(c.facts!.closest_mm).toBe(0.2);
  }, T);

  it("no USB access when closed", () => {
    const { plan } = planOf(pebble(), (L) => {
      L.openings = L.openings.filter((o) => o.part !== "xiao");
    });
    const c = plan.checks.find((x) => x.id === "assembly-access" && !x.ok)!;
    expect(c.severity).toBe("warning");
    expect(c.message).toMatch(/xiao .* usb-c \(flashing and power\) is inside the closed case/);
    expect(c.message).toMatch(/Fix: put xiao against a wall/);
  }, T);

  it("a hidden BOOT button on a board whose firmware deep-sleeps: updates need it awake (round 17)", () => {
    const p = pebble();
    const L = layoutCase(layoutInput(p, specOf));
    const awake = assemblyPlan({ project: p, layout: L, specOf, firmwareText: "void loop() { delay(10); }" }).checks.find((x) => x.id === "assembly-access" && x.ok)!;
    const asleep = assemblyPlan({ project: p, layout: L, specOf, firmwareText: "void setup() { esp_deep_sleep_start(); }" }).checks.find((x) => x.id === "assembly-access" && x.ok)!;
    expect(String(awake.facts!.hidden_buttons)).toMatch(/boot/i);
    expect(awake.message).toMatch(/later updates go over USB without it/);
    expect(asleep.message).not.toMatch(/later updates go over USB without it/);
    expect(asleep.message).toMatch(/later updates need the board awake: it deep-sleeps.*Why: .*Fix: give the firmware a way to stay awake/);
    expect(asleep.facts!.firmware_deep_sleeps).toBe(1);
  }, T);

  it("a screw under the belt clip has no tool path", () => {
    const { plan } = planOf({ ...muse(), enclosure: { shape: "rounded-box", params: { closure: "screws", belt_clip: true } } }, (L) => {
      const H = L.outer.h;
      const yTop = L.outer.max[1] - Math.max(4, H * 0.15);
      L.bosses = [{ x: 0, y: yTop - 5, od: 5.2 }, ...L.bosses];
    });
    const c = plan.checks.find((x) => x.id === "assembly-screws")!;
    expect(c.severity).toBe("error");
    expect(c.message).toMatch(/has no way in for the screwdriver: the screw at \(0, .*\) mm is under the belt clip/);
  }, T);

  it("foam tape where a clip would do names the room it needed", () => {
    const { plan } = planOf(pebble(), (L) => {
      const m = L.mounts.find((x) => x.part === "squeak")!;
      m.how = ["opening", "foam-tape"];
      m.missing = "no room for locator ribs beside it (a 1.2 mm rib needs 1.7 mm beside the body)";
    });
    const c = plan.checks.find((x) => x.id === "assembly-held")!;
    expect(c.severity).toBe("warning");
    expect(c.message).toMatch(/squeak \(no room for locator ribs beside it \(a 1.2 mm rib needs 1.7 mm beside the body\)\)/);
  }, T);
});
