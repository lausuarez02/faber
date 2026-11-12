// Round 12, track kit: the build kit (get_build_kit) for the talking egg, the Muse and the star.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { ProjectSession } from "../src/index.ts";
import type { AssemblyStep } from "@jumper/enclosure";
import { buildKit, planSteps, type BuildKit } from "../src/kit/index.ts";
import { writeKitFiles } from "../src/kit/files.ts";
import { detectSlicer, parseGcodeEstimate, printPlan } from "../src/kit/print-plan.ts";
import { kitHtml, kitMarkdown } from "../src/kit/render.ts";
import { regionalLink, shoppingCsv } from "../src/kit/shopping.ts";
import { boxStl, stlStats } from "../src/kit/stl.ts";

const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};
const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.JUMPER_SLICER;
});
function open(src: string): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-kit-"));
  dirs.push(dir);
  cpSync(src, dir, { recursive: true });
  const hex = join(dir, "firmware/main.hex");
  if (existsSync(hex)) {
    const later = new Date(Date.now() + 60_000);
    utimesSync(hex, later, later);
  }
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  sessions.push(s);
  return s;
}

/** The checks every kit must pass, whatever the project. */
function checkKit(s: ProjectSession, kit: BuildKit) {
  const p = s.project;
  // every part is on exactly one shopping line
  const refs = kit.shopping.lines.flatMap((l) => (l.refs ? l.refs.split(" ") : []));
  expect(refs.sort()).toEqual(p.parts.map((x) => x.id).sort());
  // every line can be bought: a link, or a "no link" flag that says why
  for (const l of kit.shopping.lines) {
    expect(l.links.length > 0 || !!l.no_link, l.name).toBe(true);
    expect(l.qty, l.name).toBeGreaterThan(0);
    if (l.unit_usd !== null) expect(l.ext_usd, l.name).toBeCloseTo(l.unit_usd * l.qty, 2);
  }
  // totals add up
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  expect(kit.shopping.grand_total_usd).toBeCloseTo(sum(kit.shopping.lines.map((l) => l.ext_usd ?? 0)), 2);
  expect(kit.shopping.to_buy_usd).toBeCloseTo(sum(kit.shopping.lines.filter((l) => !l.may_have).map((l) => l.ext_usd ?? 0)), 2);
  expect(sum(kit.shopping.stores.map((x) => x.total_usd))).toBeCloseTo(kit.shopping.to_buy_usd, 2);
  expect(kit.shopping.stores.reduce((a, x) => a + x.lines, 0)).toBe(kit.shopping.lines.filter((l) => !l.may_have).length);
  // every printable body is on the print list
  const report = JSON.parse(readFileSync(join(s.dir, "case/report.json"), "utf8")) as { files: { path: string; kind: string }[] };
  expect(kit.print.items.map((i) => i.file).sort()).toEqual(report.files.filter((f) => f.kind === "stl").map((f) => f.path).sort());
  for (const i of kit.print.items) expect(i.material && i.orientation && i.layer_mm > 0 && i.infill_pct > 0, i.file).toBeTruthy();
  expect(kit.print.total_grams).toBeCloseTo(kit.print.items.reduce((a, i) => a + i.grams, 0), 0);
  // every wire is soldered in exactly one step (the cut list is the one exception)
  const placedWires = kit.steps.filter((st) => !/^Cut(,| and) strip/.test(st.title)).flatMap((st) => st.wires.map((w) => w.wire));
  expect(placedWires.sort()).toEqual(p.wires.map((w) => w.id).sort());
  for (const st of kit.steps) for (const w of st.wires) expect(w.length_mm, w.wire).toBeGreaterThan(0);
  // each step says how to know it worked; numbered 1..n
  kit.steps.forEach((st, i) => expect(st.n).toBe(i + 1));
  expect(kit.steps.every((st) => !!st.check)).toBe(true);
  expect(kit.steps.some((st) => (kit.steps_source === "assembly-plan" ? /^Put .* into the (front|back) shell/ : /Put the parts in the case/).test(st.title))).toBe(true);
  // troubleshooting from the project's own risks
  expect(kit.troubleshooting.some((t) => t.source === "fidelity")).toBe(true);
  expect(kit.tools.items.some((t) => t.need === "required")).toBe(true);
  // the page has no tool names (people read it)
  const html = kitHtml(kit);
  for (const tool of ["design_case", "update_case", "get_case", "get_build_kit", "export_manufacturing", "check_design", "place_part"]) expect(html, tool).not.toContain(tool);
  expect(kitMarkdown(kit)).toContain("## Assemble");
  expect(shoppingCsv(kit.shopping).split("\n")[0]).toBe("section,qty,name,variant,ask_for,refs,unit_usd,ext_usd,store,store_region,link_kind,url,no_link,may_already_have,why");
}

describe("build kit", () => {
  it("STL stats: volume and area of a box", () => {
    const st = stlStats(boxStl(10, 20, 30));
    expect(st.triangles).toBe(12);
    expect(st.volume_mm3).toBeCloseTo(6000, 3);
    expect(st.area_mm2).toBeCloseTo(2 * (200 + 300 + 600), 3);
    expect(st.max[2] - st.min[2]).toBeCloseTo(30, 5);
    const ascii = `solid t\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 1 0\n endloop\n endfacet\nendsolid t\n`;
    expect(stlStats(new TextEncoder().encode(ascii)).area_mm2).toBeCloseTo(0.5, 5);
  });

  it("print estimate follows the documented formula (and a slicer's numbers when one is installed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jumper-kit-print-"));
    dirs.push(dir);
    mkdirSync(join(dir, "stl"));
    writeFileSync(join(dir, "stl/front.stl"), boxStl(20, 20, 20));
    const report = { enclosure: { shape: "pebble", params: { process: "fdm", color: "#F2EDE4" } }, files: [{ path: "stl/front.stl", kind: "stl", body: "front", bytes: 0, sha256: "", print: { face_down: "front", supports: false } }, { path: "case.3mf", kind: "3mf", body: "all", bytes: 0, sha256: "" }] } as never;
    process.env.JUMPER_SLICER = "none";
    const p = await printPlan({ caseDir: dir, report, slicer: "auto" });
    // V 8000, area 2400 -> solid 2400 + 20 % of 5600 = 3520 mm³; 3.52 cm³ x 1.24 x 1.05 = 4.58 g; (3520 / 4 + 100 layers x 3 s) / 60 = 19.7 min
    expect(p.items[0]).toMatchObject({ grams: 4.6, minutes: 20, source: "mesh", material: "PLA", color: "ivory", layer_mm: 0.2, infill_pct: 20, supports: false });
    // round 13: each printed file's measured size (its STL's bounding box as it lies on the bed), in the list too
    writeFileSync(join(dir, "stl/front.stl"), boxStl(30, 20, 12.5));
    expect((await printPlan({ caseDir: dir, report, slicer: "auto" })).items[0]!.size_mm).toEqual([30, 20, 12.5]);
    writeFileSync(join(dir, "stl/front.stl"), boxStl(20, 20, 20));
    expect(p.plate).toBe("case.3mf");
    expect(p.method).toMatch(/4 mm³ per second/);
    // a fake PrusaSlicer: its G-code footer is read, the result cached
    const fake = join(dir, "prusa-slicer");
    writeFileSync(fake, `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nprintf '; estimated printing time (normal mode) = 1h 2m 30s\\n; filament used [g] = 12.34\\n' > "$out"\n`);
    chmodSync(fake, 0o755);
    process.env.JUMPER_SLICER = fake;
    const cache = join(dir, "cache.json");
    const q = await printPlan({ caseDir: dir, report, slicer: "auto", cacheFile: cache });
    expect(q.items[0]).toMatchObject({ grams: 12.3, minutes: 63, source: "slicer:PrusaSlicer" });
    expect(q.slicer).toMatchObject({ found: true, used: true });
    expect(existsSync(cache)).toBe(true);
    // "cached" uses earlier slices only; an Orca install is detected, not driven
    rmSync(fake);
    writeFileSync(fake, "#!/bin/sh\nexit 1\n");
    chmodSync(fake, 0o755);
    expect((await printPlan({ caseDir: dir, report, slicer: "cached", cacheFile: cache })).items[0]!.source).toBe("slicer:PrusaSlicer");
    const orca = join(dir, "OrcaSlicer");
    writeFileSync(orca, "");
    process.env.JUMPER_SLICER = orca;
    expect(detectSlicer()).toMatchObject({ name: "OrcaSlicer", cli: false });
    const o = await printPlan({ caseDir: dir, report, slicer: "auto" });
    expect(o.items[0]!.source).toBe("mesh");
    expect(o.slicer.why).toMatch(/OrcaSlicer is installed/);
    expect(parseGcodeEstimate("; estimated printing time = 2d 1h\n; total filament used [g] = 3")).toEqual({ minutes: 2940, grams: 3 });
  });

  it("the talking egg: microSD, the battery's JST socket, power first, every wire and print", async () => {
    const s = open(join(FIX, "talking-egg"));
    const kit = await buildKit(s, { slicer: "off" });
    checkKit(s, kit);
    const names = kit.shopping.lines.map((l) => l.name);
    expect(names).toContain("microSD card");
    expect(names.some((n) => /^JST-PH 2\.0 mm socket/.test(n))).toBe(true);
    expect(names.some((n) => /USB-C cable/.test(n))).toBe(true);
    // the 250 mAh cell is the 502030 pouch, not the part's default 503035
    expect(kit.shopping.lines.find((l) => l.refs === "bat")!.variant).toMatch(/250mAh, 502030/);
    expect(kit.steps[0]!.title).toMatch(/Print the case/);
    expect(kit.steps.find((st) => /power and ground/.test(st.title))!.cautions.join(" ")).toMatch(/red wire/);
    // no STL in the fixture: listed, weighed from the case report, and said
    expect(kit.print.items.every((i) => i.source === "report")).toBe(true);
    expect(kit.flash).toMatchObject({ method: "uf2-drag", kit_file: "firmware/firmware.uf2", built: "missing" });
    expect(kit.missing.map((m) => m.item)).toContain("firmware file");
    expect(kit.flash.steps.join(" ")).toMatch(/microSD card/);
  }, 60_000);

  it("the Muse: real meshes, the button cap, flash by drag and drop, files and zip", async () => {
    const s = open(MUSE);
    const kit = await buildKit(s, { slicer: "off", region: "eu" });
    checkKit(s, kit);
    expect(kit.print.items.map((i) => i.body).sort()).toEqual(["back", "cap-pet", "front"]);
    for (const i of kit.print.items) expect(i.source).toBe("mesh");
    expect(kit.print.items.find((i) => i.body === "front")!.grams).toBeGreaterThan(5);
    expect(kit.flash).toMatchObject({ method: "uf2-drag", built: "fresh" });
    expect(kit.missing).toEqual([]);
    expect(kit.shopping.lines.some((l) => l.links.some((k) => k.url.startsWith("https://www.amazon.de/")))).toBe(true);
    expect(kit.shopping.lines.find((l) => l.refs === "chg")!.why).toMatch(/Charge current/);
    // the case engine's plan: the board goes into its shell with its port in its opening, a picture per step
    const place = kit.steps.find((st) => /^Put xiao into the (front|back) shell/.test(st.title))!;
    expect(place.do.join(" ")).toMatch(/port .* sits in its opening/);
    expect(place.image).toMatch(/^case\/assembly\/step-\d\d\.png$/);
    const f = await writeKitFiles(s, kit, { pdf: false });
    for (const rel of ["kit.html", "KIT.md", "SHOPPING.csv", "SHOPPING.md", "PRINT-LIST.md", "case/stl/front.stl", "case/stl/cap-pet.stl", "case/case.3mf", "case/renders/inside.png", place.image!, "firmware/firmware.uf2", "firmware/firmware.hex"]) expect(existsSync(join(f.dir, rel)), rel).toBe(true);
    expect(f.zip && existsSync(f.zip)).toBe(true);
    expect(readFileSync(f.html, "utf8")).toContain("data:image/png;base64,");
    // every printed file says its measured size (mm) in the print list
    const front = kit.print.items.find((i) => i.body === "front")!;
    expect(front.size_mm).toHaveLength(3);
    expect(readFileSync(join(f.dir, "PRINT-LIST.md"), "utf8")).toContain(`| ${front.size_mm!.join(" × ")} |`);
  }, 90_000);

  it("the star keychain: the agent's custom case, every line and print", async () => {
    const s = open(join(FIX, "star-keychain"));
    const kit = await buildKit(s, { slicer: "off" });
    checkKit(s, kit);
    expect(kit.size_mm).toMatchObject({ w: 88 });
    expect(kit.shopping.lines.find((l) => l.refs.split(" ").includes("r1"))!.variant).toMatch(/100k/);
    expect(kit.shopping.lines.find((l) => l.refs === "ldo")!.variant).toMatch(/MCP1700-3\.3/);
    // the 250 mAh cell: the store searches and the words name the 502030, not the part's default 503035 / 500 mAh
    const bat = kit.shopping.lines.find((l) => l.refs === "bat")!;
    for (const k of bat.links) expect(k.url, k.store).not.toMatch(/503035|500mah/i);
    expect(bat.links.some((k) => /502030/.test(k.url))).toBe(true);
    expect(`${bat.ask_for} ${bat.alternatives.join(" ")}`).not.toMatch(/503035|500 mAh/);
    // a setting changed from how the module is sold says how to change it on the real part
    expect(kit.shopping.lines.find((l) => l.refs === "chg")!.why).toMatch(/Charge current.*250 mA.*How: Set by R_PROG.*5 k.* = 250/);
    // the design check's circuit warning (the LDO and the board's 3V3 both drive one rail) leads the kit, in words
    expect(kit.check_first.map((c) => c.code)).toContain("parallel-regulators");
    expect(kit.check_first.find((c) => c.code === "parallel-regulators")!.why).toMatch(/ldo pin VOUT .* xiao pin 3V3/);
    expect(kitMarkdown(kit)).toMatch(/## Check before you buy[\s\S]*parallel regulators/);
    expect(kitHtml(kit, {})).toContain("Check before you buy");
  }, 60_000);

  it("the Muse: its committed case-6 plan is the kit's steps, tools and consumables (what get_assembly_plan returns)", async () => {
    const s = open(MUSE);
    const plan = (await s.call("get_assembly_plan", {})) as { steps: { title: string; wires: { id: string }[]; image?: string }[]; consumables: { item: string }[]; tools: string[] };
    const kit = await buildKit(s, { slicer: "off" });
    checkKit(s, kit);
    expect(kit.steps_source).toBe("assembly-plan");
    expect(kit.steps.map((st) => st.title)).toEqual(plan.steps.map((st) => st.title));
    expect(kit.steps[0]!.image).toBe(`case/${plan.steps[0]!.image}`);
    // every wire of the plan, with its colour in words and its book-slack length
    const wired = kit.steps.flatMap((st) => st.wires);
    expect(new Set(wired.map((w) => w.wire))).toEqual(new Set(s.project.wires.map((w) => w.id)));
    for (const w of wired) expect(w.color).not.toMatch(/^#/);
    // the plan's foam pad under the cell is something to buy; its Kapton reason joins the Kapton line
    expect(kit.shopping.lines.some((l) => /foam pad/i.test(l.name))).toBe(true);
    expect(kit.shopping.lines.find((l) => l.id === "extra:kapton")!.why).toMatch(/the assembly plan/);
    // the plan's reasons point at the kit's own steps, not the factory pack's files
    const wireLine = kit.shopping.lines.find((l) => /wire \d+ AWG/.test(l.name))!;
    expect(wireLine.why).toMatch(/lengths in the Assemble steps/);
    expect(JSON.stringify(kit.shopping.lines)).not.toMatch(/WIRE-CUTS|PRINT\.md/);
    // its tools are on the tool list once (consumables stay on the shopping list)
    expect(kit.tools.items.filter((t) => /knife/i.test(t.name))).toHaveLength(1);
    expect(kit.tools.items.some((t) => /^(Solder|Flux|Kapton tape|USB cable|1 mm foam pad)$/i.test(t.name))).toBe(false);
  }, 120_000);

  it("plan steps speak the kit's words: its sections, part words, the tests by name, crowded pads and the cell's socket", () => {
    const wire = (id: string, from: string, to: string) => ({ id, from, to, length_mm: 60, gauge: 24, color: "red", route: "front" as const });
    const step = (n: number, title: string, action: AssemblyStep["action"], say: string, wires: ReturnType<typeof wire>[], parts: string[] = [], shell: AssemblyStep["shell"] = "front"): AssemblyStep => ({ n, title, say, action, shell, parts, wires, fasteners: [], tools: [], cautions: [], view: { camera: "front-shell", explode: 0, highlight: [] } }) as AssemblyStep;
    const steps = [
      step(1, "Check the printed parts", "test", "Print the case (enclosure/PRINT.md): front shell, back shell. They should close evenly.", [], [], "bench"),
      step(2, "Cut, strip and tin the wires", "solder", "Cut the 4 wires to the lengths in electronics/WIRE-CUTS.csv.", [wire("w1", "a.GND", "b.GND"), wire("w2", "c.GND", "b.GND"), wire("w3", "d.GND", "b.GND")], [], "bench"),
      step(3, "Solder the wires to b", "solder", "With b in place, solder w1 (a.GND to b.GND), w2 (c.GND to b.GND).", [wire("w1", "a.GND", "b.GND"), wire("w2", "c.GND", "b.GND")], ["a", "b", "c"]),
      step(4, "Join the shells", "route-wire", "Solder w3 (d.GND to b.GND).", [wire("w3", "d.GND", "b.GND")], ["d", "b"], "both"),
      step(5, "Test it on USB before the battery", "test", "Plug a USB cable into b.usb. Run through test/TEST-PLAN.md: the screen should behave as in the simulation.", [], ["b"], "both"),
      step(6, "Place and connect the battery bat", "tape", "Last, connect its leads: w4 (bat.POS to b.BAT).", [wire("w4", "bat.POS", "b.BAT")], ["bat"], "back"),
    ];
    const ref = (part: string, rest: string) => (["a", "b", "c", "d", "bat"].includes(part) ? (rest === "usb" ? `${part}'s USB-C port` : `${part} pin ${rest}`) : undefined);
    const out = planSteps(steps, { label: (r) => r.replace(".", " pin "), caseRel: "case", ref, cells: new Set(["bat"]), jst: new Map([["bat", "JST-PH"]]), tests: ["Eyes appear", "Blinks"] });
    const all = JSON.stringify(out.map((st) => [st.do, st.cautions, st.check]));
    expect(all).not.toMatch(/PRINT\.md|WIRE-CUTS|TEST-PLAN|b\.usb|a\.GND/);
    expect(out[0]!.do[0]).toMatch(/Print the case \(see the print list\)/);
    expect(out[1]!.do[0]).toMatch(/in the wire list below/);
    expect(out[4]!.do[0]).toMatch(/b's USB-C port.*the tests below/);
    expect(out[4]!.do[1]).toBe("The tests (they passed in Jumper's simulator): Eyes appear; Blinks.");
    // 3 wires on b.GND: said once, where the pad is first soldered (not on the bench), naming the one that comes later
    const crowded = out.flatMap((st, i) => st.cautions.filter((c) => /3 wires end at b pin GND/.test(c)).map(() => i));
    expect(crowded).toEqual([2]);
    expect(out[2]!.cautions.join(" ")).toMatch(/w1, w2 now, w3 in a later step/);
    // the cell's JST plug: solder the socket, check the polarity and the voltage
    expect(out[5]!.do.join(" ")).toMatch(/JST-PH socket's leads/);
    expect(out[5]!.check).toMatch(/3\.0 to 4\.2 V across b pin BAT/);
  });

  it("a stale case never uses its plan (the steps are derived and the kit says the case is old)", async () => {
    const s = open(MUSE);
    const p = s.project;
    p.enclosure!.params = { ...(p.enclosure!.params ?? {}), wall_mm: 2.4 };
    writeFileSync(join(s.dir, "jumper.json"), JSON.stringify(p, null, 2));
    const s2 = new ProjectSession({ dir: s.dir, builder: noBuild, actor: "test" });
    sessions.push(s2);
    const kit = await buildKit(s2, { slicer: "off" });
    expect(kit.steps_source).toBe("derived");
    expect(kit.missing.some((m) => m.item === "up-to-date case files")).toBe(true);
  }, 120_000);

  it("Amazon searches follow the region; product pages stay", () => {
    expect(regionalLink("Amazon", "https://www.amazon.com/s?k=lipo", "uk")).toMatchObject({ url: "https://www.amazon.co.uk/s?k=lipo", region: "UK", kind: "search" });
    expect(regionalLink("Amazon (search)", "https://www.amazon.com/dp/B000", "eu")).toMatchObject({ store: "Amazon", url: "https://www.amazon.com/dp/B000", kind: "product" });
    expect(regionalLink("DigiKey", "https://www.digikey.com/en/products/detail/x", "eu").kind).toBe("product");
  });

  it("get_build_kit over the tool layer, and the factory pack's build-kit/ section", async () => {
    const s = open(MUSE);
    const r = (await s.call("get_build_kit", { pdf: false, slicer: "off" })) as { summary: string; kit: BuildKit; files: { html: string; zip: string } };
    expect(r.summary).toMatch(/Pocket Muse: 9 parts/);
    expect(existsSync(r.files.html) && existsSync(r.files.zip)).toBe(true);
    const pack = (await s.call("export_manufacturing", { zip: false })) as { dir: string; files: string[] };
    for (const f of ["build-kit/kit.html", "build-kit/KIT.md", "build-kit/SHOPPING.csv", "build-kit/PRINT-LIST.md", "README.zh-CN.md", "BOM.csv", "assembly/ASSEMBLY.md"]) expect(pack.files, f).toContain(f);
    expect(readFileSync(join(pack.dir, "README.md"), "utf8")).toContain("build-kit/kit.html");
  }, 90_000);
});
