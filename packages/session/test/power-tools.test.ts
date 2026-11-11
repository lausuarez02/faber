// Round 6, track power (decision 0004, R2 / R4): set_power, set_assembly, soldered exports,
// search_parts with no fit, fuzzy get_part, planning calls logged into the project they create.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { ProjectSession, wireCuts, assemblyStyle } from "../src/index.ts";
import { registry } from "@jumper/parts";
import { parseProject } from "@jumper/project-format";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
const oldHome = process.env.JUMPER_HOME;
beforeAll(() => {
  process.env.JUMPER_HOME = mkdtempSync(join(tmpdir(), "jumper-home-"));
});
afterAll(() => {
  rmSync(process.env.JUMPER_HOME!, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.JUMPER_HOME;
  else process.env.JUMPER_HOME = oldHome;
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(name: string): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), `jumper-power-${name.replace(/\//g, "-")}-`));
  dirs.push(dir);
  cpSync(join(EXAMPLES, name), dir, { recursive: true, preserveTimestamps: true });
  const p = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")) as { firmware?: { artifact: string } };
  if (p.firmware) {
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, p.firmware.artifact), later, later);
    void statSync(join(dir, p.firmware.artifact));
  }
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  sessions.push(s);
  return s;
}
function blank(): ProjectSession {
  const root = mkdtempSync(join(tmpdir(), "jumper-power-blank-"));
  dirs.push(root);
  const dir = join(root, "playground");
  mkdirSync(dir);
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test", projectsRoot: root });
  sessions.push(s);
  return s;
}
const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args, { actor: "mcp", client: "test-agent 1.0" }) as Promise<Record<string, any>>;
const MUSE = "agent-built/claude-pocket-muse";

describe("set_power", () => {
  it("unplugged, the Muse runs from its LiPo: board powered, the cell carries the load", async () => {
    const s = open(MUSE);
    const r = await call(s, "set_power", { usb: false, why: "check the battery path" });
    expect(r.usb).toBe(false);
    expect(r.board_powered).toBe(true);
    expect(r.supply.net).toMatch(/xiao\.VBUS/);
    expect(r.supply.net).toMatch(/d1\.C/);
    expect(r.battery.part).toBe("bat");
    expect(r.battery.ma).toBeGreaterThan(20);
    expect(r.battery.hours_left).toBeGreaterThan(5);
    expect(r.battery.hours_left).toBeLessThan(25);
  });

  it("with the switch off and USB unplugged the board has no power, and it says how to fix it", async () => {
    const s = open(MUSE);
    await call(s, "set_part_property", { id: "pwr", prop: "position", value: 1 });
    const r = await call(s, "set_power", { usb: false });
    expect(r.board_powered).toBe(false);
    expect(r.fix).toMatch(/no-power-path/);
    const back = await call(s, "set_power", { usb: true });
    expect(back.board_powered).toBe(true);
    expect(back.supply.from[0]).toMatch(/USB cable on xiao\.VBUS/);
    expect(JSON.parse(readFileSync(join(s.dir, "jumper.json"), "utf8")).power).toEqual({ usb: true });
  });

  it("unplugging while it runs is a power cut: the firmware stops, plugging in boots it again", async () => {
    const s = open(MUSE);
    await call(s, "set_power", { usb: true });
    await call(s, "set_part_property", { id: "pwr", prop: "position", value: 1 });
    await call(s, "run", { ms: 1500 });
    expect((await call(s, "read_serial")).text ?? "").toMatch(/motion sensor ready/);
    await call(s, "set_power", { usb: false });
    const off = await call(s, "run", { ms: 1000 });
    expect(off.parts?.xiao?.powered ?? off.states?.xiao?.powered).toBe(false);
    await call(s, "set_power", { usb: true });
    const on = await call(s, "run", { ms: 1500 });
    expect(on.serial).toMatch(/motion sensor ready/);
  }, 120_000);

  it("rejects a non-boolean with what to pass", async () => {
    const s = open(MUSE);
    await expect(call(s, "set_power", { usb: "no" })).rejects.toThrow(/set_power needs usb: true or false.*Fix: pass \{"usb": false\}/);
  });
});

describe("assembly and soldered exports", () => {
  it("a pocket board defaults to soldered, an Uno to breadboard; set_assembly overrides", async () => {
    const muse = parseProject(JSON.parse(readFileSync(join(EXAMPLES, MUSE, "jumper.json"), "utf8")));
    expect(assemblyStyle({ ...muse, assembly: undefined }, registry)).toBe("soldered");
    const arm = parseProject(JSON.parse(readFileSync(join(EXAMPLES, "agent-built/claude-robot-arm/jumper.json"), "utf8")));
    expect(assemblyStyle(arm, registry)).toBe("breadboard");
    const s = open("agent-built/claude-robot-arm");
    const r = await call(s, "set_assembly", { style: "soldered", why: "in a box" });
    expect(r.style).toBe("soldered");
    expect(r.note).toMatch(/WIRE-CUTS\.csv/);
    await expect(call(s, "set_assembly", { style: "glued" })).rejects.toThrow(/unknown style.*Fix:/);
  });

  it("export of the Muse: WIRE-CUTS.csv, soldered ASSEMBLY.md, no breadboard or dupont in the BOM", async () => {
    const s = open(MUSE);
    const r = await call(s, "export");
    expect(r.assembly).toBe("soldered");
    expect(r.files).toEqual(expect.arrayContaining(["BOM.md", "WIRING.md", "WIRE-CUTS.csv", "ASSEMBLY.md", "firmware.uf2"]));
    const bom = readFileSync(join(r.dir, "BOM.md"), "utf8");
    expect(bom).not.toMatch(/breadboard|dupont/i);
    expect(bom).toMatch(/hook-up wire, 24 AWG/);
    expect(bom).toMatch(/hook-up wire, 26 AWG/);
    expect(bom).toMatch(/Schottky diode/);
    const csv = readFileSync(join(r.dir, "WIRE-CUTS.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toBe("wire,from,to,color,length_mm,gauge_awg,note");
    expect(csv).toHaveLength(1 + 22);
    const d1 = csv.find((l) => l.startsWith("w22,"))!;
    expect(d1).toMatch(/^w22,d1\.C,xiao\.VBUS,red,\d+,24,/);
    // switch → diode is part of the power path too
    expect(csv.find((l) => l.startsWith("w21,"))).toMatch(/^w21,pwr\.1,d1\.A,red,\d+,24,/);
    for (const l of csv.slice(1)) expect(Number(l.split(",")[4]) % 5).toBe(0);
    const asm = readFileSync(join(r.dir, "ASSEMBLY.md"), "utf8");
    expect(asm).toMatch(/stripe \(C\) goes towards xiao/);
    expect(asm).toMatch(/Test the power path before anything else/);
    expect(asm).not.toMatch(/dupont/i);
  });

  it("a breadboard project keeps its breadboard and dupont lines", async () => {
    const s = open("agent-built/claude-robot-arm");
    const r = await call(s, "export");
    expect(r.assembly).toBe("breadboard");
    expect(r.files).not.toContain("WIRE-CUTS.csv");
    expect(readFileSync(join(r.dir, "BOM.md"), "utf8")).toMatch(/Half-size breadboard[\s\S]*|Jumper wires \(dupont/);
  });

  it("wireCuts: lengths from case positions when given, gauge 24 on power nets", () => {
    const p = parseProject(JSON.parse(readFileSync(join(EXAMPLES, MUSE, "jumper.json"), "utf8")));
    const cuts = wireCuts(p, registry, { "eye.SCK": [0, 0, 0], "xiao.GP2": [30, 40, 0] });
    const sck = cuts.find((c) => c.wire === "w3")!;
    // 50 mm straight × 1.3 + 10 strip + 15 slack = 90
    expect(sck).toMatchObject({ from: "eye.SCK", to: "xiao.GP2", color: "yellow", length_mm: 90, gauge_awg: 26 });
    expect(cuts.find((c) => c.wire === "w17")!.gauge_awg).toBe(24);
  });
});

describe("catalog: no fit, fuzzy ids", () => {
  it("search_parts with nothing that fits says so and hands a create_part template that compiles", async () => {
    const s = blank();
    await call(s, "new_project", { template: "blank", name: "t" });
    const r = await call(s, "search_parts", { query: "gas sensor" });
    expect(r.results).toEqual([]);
    expect(r.hint).toMatch(/Nothing in the catalog is a 'gas sensor'.*create_part/);
    expect(r.create_part_template).toMatchObject({ id: "gas-sensor", category: "sensor", behavior: { kind: "analog-sensor" } });
    const made = await call(s, "create_part", { part: r.create_part_template });
    expect(made.id ?? made.part?.id ?? JSON.stringify(made)).toMatch(/gas-sensor/);
    // "diode" is now a real part, not only a word in the LED's description.
    const d = await call(s, "search_parts", { query: "diode" });
    expect(d.results.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(["schottky-diode", "generic-diode"]));
  });

  it("get_part finds rp2040-zero and xiao by their short names, and says which id it used", async () => {
    const s = blank();
    const z = await call(s, "get_part", { type: "rp2040-zero" });
    expect(z.type).toBe("waveshare-rp2040-zero");
    expect(z.matched).toMatch(/'rp2040-zero' is waveshare-rp2040-zero/);
    expect((await call(s, "get_part", { type: "xiao-rp2040" })).type).toBe("seeed-xiao-rp2040");
    // Round 10 added XIAO ESP32-S3 / C3 and nRF52840: a bare "xiao" is ambiguous and says which ids fit.
    await expect(call(s, "get_part", { type: "xiao" })).rejects.toThrow(/matches 4 part types.*seeed-xiao-esp32c3.*seeed-xiao-esp32s3.*seeed-xiao-nrf52840.*seeed-xiao-rp2040/);
    await expect(call(s, "get_part", { type: "transistor" })).rejects.toThrow(/matches 2 part types.*npn-transistor.*pnp-transistor/);
    await expect(call(s, "get_part", { type: "flux-capacitor" })).rejects.toThrow(/No part type 'flux-capacitor'/);
  });
});

describe("planning calls are logged into the project they create", () => {
  it("plan_device / search_parts / get_part before new_project {folder} land in the new project's log", async () => {
    const s = blank();
    await call(s, "plan_device", { goal: "a tiny pocket buddy with eyes", constraints: { pocket: true } });
    await call(s, "search_parts", { query: "round" });
    await expect(call(s, "get_part", { type: "nope-nope" })).rejects.toThrow();
    const r = await call(s, "new_project", { folder: true, name: "Pocket buddy", template: "blank" });
    const log = (d: string) => (existsSync(join(d, ".jumper", "actions.jsonl")) ? readFileSync(join(d, ".jumper", "actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
    const mine = log(s.dir).map((e) => e.op);
    expect(mine).not.toContain("plan_device");
    expect(mine).not.toContain("search_parts");
    expect(mine).toContain("new_project");
    const theirs = log(r.dir);
    expect(theirs.slice(0, 3).map((e: { op: string }) => e.op)).toEqual(["plan_device", "search_parts", "get_part"]);
    expect(theirs[0].moved_from).toBe(s.dir);
    expect(theirs.map((e: { op: string }) => e.op)).toContain("new_project");
    // seq keeps increasing in the new log
    const seqs = theirs.map((e: { seq: number }) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("without a new project they stay in this project's log, in order", async () => {
    const s = blank();
    await call(s, "new_project", { template: "blank", name: "t" });
    await call(s, "search_parts", { query: "button" });
    await call(s, "place_part", { type: "led" });
    const ops = readFileSync(join(s.dir, ".jumper", "actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).op);
    expect(ops).toEqual(["new_project", "search_parts", "place_part"]);
  });
});
