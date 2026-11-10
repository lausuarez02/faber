import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { registry } from "@jumper/parts";
import { createRegistry, type PartDefinition } from "@jumper/sim-core";
import { chromiumProblem, listRegisteredProjects, planDevice, ProjectSession, projectId, recordProject, setServerBase } from "../src/index.ts";

// Round 5, track agent (decision 0003, C5): plan_device, new_project {folder}, run_tests accepting
// steps, delete_file, mark_stand_in + exports, viewer_url, record.

const GOLDEN = readFileSync(fileURLToPath(new URL("../../../examples/blink/firmware/blink.hex", import.meta.url)), "utf8");
async function fakeBuilder(_req: BuildRequest): Promise<BuildResult> {
  return { ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, size: { flash: 1992, flashMax: 32256, ram: 202, ramMax: 2048 }, libraries: [], logTail: "" };
}
const BLINK = 'void setup(){Serial.begin(115200);pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);Serial.println("LED on");delay(1000);digitalWrite(13,LOW);Serial.println("LED off");delay(1000);}\n';

let root: string;
let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args, { actor: "mcp", client: "test-agent 1.0" }) as Promise<Record<string, any>>;
const oldHome = process.env.JUMPER_HOME;

beforeAll(() => {
  process.env.JUMPER_HOME = mkdtempSync(join(tmpdir(), "jumper-home-"));
});
afterAll(() => {
  rmSync(process.env.JUMPER_HOME!, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.JUMPER_HOME;
  else process.env.JUMPER_HOME = oldHome;
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jumper-agent-"));
  dir = join(root, "playground");
  mkdirSync(dir);
  s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test" });
});
afterEach(() => {
  s.dispose();
  setServerBase(undefined);
  rmSync(root, { recursive: true, force: true });
});

// Physical data the parts track adds to every part (C2), so the plan's sums can be checked exactly.
const PHYS: Record<string, { dimensions_mm: { w: number; h: number; d: number }; current_ma: { typ: number; max: number }; price_usd: number }> = {
  "arduino-nano": { dimensions_mm: { w: 45, h: 18, d: 8 }, current_ma: { typ: 20, max: 40 }, price_usd: 6 },
  "arduino-uno": { dimensions_mm: { w: 69, h: 53, d: 15 }, current_ma: { typ: 45, max: 60 }, price_usd: 25 },
  "ssd1306-oled-i2c": { dimensions_mm: { w: 27, h: 27, d: 4 }, current_ma: { typ: 10, max: 25 }, price_usd: 5 },
  pushbutton: { dimensions_mm: { w: 6, h: 6, d: 5 }, current_ma: { typ: 0, max: 0 }, price_usd: 0.2 },
  buzzer: { dimensions_mm: { w: 12, h: 12, d: 9 }, current_ma: { typ: 15, max: 30 }, price_usd: 1 },
};
const withPhys = createRegistry(registry.list().map((d): PartDefinition => (PHYS[d.spec.id] ? { ...d, spec: { ...d.spec, ...PHYS[d.spec.id] } } : d)));

describe("plan_device", () => {
  it("plans a pocket pet: small board, BOM with why and sources, size, battery life, price, links", () => {
    // With the parts track's physical data and the rp2040 track's boards merged, the smallest board
    // is the Seeed XIAO RP2040 and the pocket battery is the catalog's 1S LiPo + TP4056 charger.
    const p = planDevice("a virtual pet that fits in my pocket and beeps when hungry", { pocket: true }, registry);
    expect(p.board.type).toBe("seeed-xiao-rp2040");
    expect(p.board.why).toMatch(/smallest board.*21 × 17\.5 mm.*pocket/);
    const types = p.bom.map((l) => l.type);
    expect(types).toEqual(expect.arrayContaining(["seeed-xiao-rp2040", "ssd1306-oled-i2c", "pushbutton", "buzzer", "lipo-battery", "tp4056-charger"]));
    expect(p.bom.find((l) => l.type === "pushbutton")!.qty).toBe(3);
    for (const l of p.bom) {
      expect(l.why.length).toBeGreaterThan(10);
      expect(["simulated-exactly", "stand-in", "agent-made", "not-simulated"]).toContain(l.source);
      expect(l.buy_links!.every((b) => b.url.startsWith("https://"))).toBe(true);
    }
    // The XIAO only takes 5 V on VBUS, so a 1S LiPo needs a boost converter, which Jumper does not simulate.
    expect(p.bom.find((l) => /boost/.test(l.name))).toMatchObject({ source: "not-simulated" });
    expect(p.bom.find((l) => /boost/.test(l.name))!.why).toMatch(/5 V the Seeed XIAO RP2040 needs on (VBUS|5V)/);
    // Battery: 80 % of 500 mAh over the parts' own current_ma.typ (battery and charger not counted).
    const typ = (id: string) => registry.get(id)!.spec.current_ma!.typ;
    const avg = typ("seeed-xiao-rp2040") + typ("ssd1306-oled-i2c") + 3 * typ("pushbutton") + typ("buzzer");
    expect(p.battery).toMatchObject({ capacity_mah: 500, avg_ma: avg, hours: Math.round((400 / avg) * 10) / 10 });
    // Price: every line's own price_usd × qty, boost $2 as a labelled assumption.
    const price = (id: string) => registry.get(id)!.spec.price_usd!;
    const total = price("seeed-xiao-rp2040") + price("ssd1306-oled-i2c") + 3 * price("pushbutton") + price("buzzer") + price("lipo-battery") + price("tp4056-charger") + 2;
    expect(p.total_usd).toBeCloseTo(total, 2);
    expect(p.missing_data).toEqual([]);
    expect(p.size_mm.enclosure.w).toBeGreaterThan(p.size_mm.parts.w);
    expect(p.size_mm.enclosure.d).toBeGreaterThanOrEqual(p.size_mm.parts.d);
    expect(p.cannot_check.join("\n")).toMatch(/battery life.*not simulated/);
    expect(p.cannot_check.join("\n")).toMatch(/how loud/);
    expect(p.summary).toMatch(/Seeed XIAO RP2040.*About \d+ × \d+ × \d+ mm in a case, about [\d.]+ h per charge, parts about \$[\d.]+\./);
    expect(p.next[0]).toMatch(/plain words/);
    expect(p.next.join()).toMatch(/new_project \{"folder": true/);
  });

  it("a board whose VSYS takes a 1S cell needs no boost; 5 V parts steer the board choice", () => {
    const pico = planDevice("a pocket pet", { pocket: true, board: "raspberry-pi-pico" }, registry);
    expect(pico.bom.some((l) => /boost/.test(l.name))).toBe(false);
    expect(pico.warnings.join("\n")).toMatch(/Raspberry Pi Pico VSYS: it takes 1\.8 to 5\.5 V, so a 1S LiPo needs no boost converter/);
    // A PIR needs 4.5 V or more, so the smallest 5 V board wins over the smaller 3.3 V XIAO.
    const pir = planDevice("a pocket alarm that beeps when someone walks by", { pocket: true }, registry);
    expect(pir.bom.map((l) => l.type)).toContain("pir-motion");
    expect(pir.board.type).toBe("arduino-nano");
    expect(pir.board.why).toMatch(/runs at 5 V like the PIR/);
  });

  it("knows the round-five parts: round screen, melody, NeoPixels, soil + relay + pump, touch, bumpers", () => {
    const types = (goal: string) => planDevice(goal, {}, registry).bom.map((l) => l.type);
    expect(types("a smart watch with a round screen")).toEqual(expect.arrayContaining(["gc9a01-round-tft"]));
    expect(types("a smart watch with a round screen")).not.toContain("ssd1306-oled-i2c");
    expect(types("a music box that plays a melody")).toContain("passive-buzzer");
    expect(types("a neopixel mood light")).toContain("ws2812-strip");
    expect(types("water my plant with a pump when the soil is dry")).toEqual(expect.arrayContaining(["capacitive-soil-moisture", "water-pump", "relay-module"]));
    expect(types("a lamp you touch to turn on")).toContain("ttp223-touch");
    expect(types("a rover with bumpers")).toEqual(expect.arrayContaining(["bump-switch", "robot-chassis-2wd"]));
    expect(planDevice("a smart watch with a round screen", {}, registry).board.type).toBe("seeed-xiao-rp2040");
  });

  it("never guesses a figure a part does not have: it is left out and named", () => {
    const bare = createRegistry(registry.list().map((d): PartDefinition => ({ ...d, spec: { ...d.spec, price_usd: undefined, current_ma: undefined, dimensions_mm: undefined } })));
    const p = planDevice("a pocket pet", { pocket: true, board: "arduino-nano" }, bare);
    expect(p.missing_data.join("\n")).toMatch(/price: .*Arduino Nano/);
    expect(p.bom.find((l) => l.type === "arduino-nano")!.price_usd).toBeUndefined();
    expect(p.battery?.note).toMatch(/Not counted \(no current figure\): .*Arduino Nano/);
  });

  it("missing parts: agent-made when create_part exists, else a stand-in to mark, else not simulated", () => {
    // The catalog now has a soil sensor; take it out to check what happens to a part Jumper lacks.
    const noSoil = createRegistry(registry.list().filter((d) => !/soil/.test(d.spec.id)));
    const stand = planDevice("water my plant when the soil is dry", {}, noSoil);
    const soil = stand.bom.find((l) => /soil/.test(l.name))!;
    expect(soil).toMatchObject({ type: "potentiometer", source: "stand-in", stand_in_for: "capacitive soil moisture sensor" });
    expect(stand.next.join()).toMatch(/mark_stand_in/);
    expect(stand.cannot_check.join()).toMatch(/Potentiometer.*stands in for it/);
    const made = planDevice("water my plant when the soil is dry", {}, noSoil, { createPartAvailable: true });
    expect(made.bom.find((l) => /soil/.test(l.name))).toMatchObject({ type: null, source: "agent-made", fidelity: "behavioral, unverified" });
    expect(made.bom.find((l) => /soil/.test(l.name))!.make_with).toMatch(/create_part.*analog-sensor/);
    expect(planDevice("water my plant when the soil is dry", {}, registry).bom.find((l) => /soil/i.test(l.name))).toMatchObject({ type: "capacitive-soil-moisture", source: "simulated-exactly" });
    const drone = planDevice("a drone with a camera", {}, registry);
    expect(drone.bom.filter((l) => l.source === "not-simulated").map((l) => l.name).join()).toMatch(/camera.*flight|flight.*camera/);
    expect(drone.cannot_check.join()).toMatch(/does not simulate cameras/);
  });

  it("asks one question when the wish is ambiguous", () => {
    expect(planDevice("something cool", {}, registry).question).toMatch(/What should it do/);
    expect(planDevice("a pet that talks back to me", {}, registry).question).toMatch(/words on a little screen.*cannot understand spoken words/);
    expect(planDevice("a plant monitor", {}, registry).question).toMatch(/only tell you when the plant is thirsty, or also water it/);
    expect(planDevice("a blinking LED", {}, registry).question).toBeUndefined();
  });

  it("checks budget, battery hours and size limits, and validates arguments through the tool", async () => {
    const p = planDevice("a pocket pet", { pocket: true, budget_usd: 10, battery_hours: 24 }, withPhys);
    expect(p.warnings.join("\n")).toMatch(/over your \$10 budget/);
    expect(p.warnings.join("\n")).toMatch(/short of the 24 h you want: use about \d+ mAh/);
    const big = planDevice("a weather station with a colour screen", { max_size_mm: { w: 40, h: 30, d: 10 } }, withPhys);
    expect(big.warnings.join("\n")).toMatch(/bigger than your limit \(40 × 30 × 10 mm\)/);
    await expect(call("plan_device", { goal: "" })).rejects.toThrow(/needs 'goal'.*Fix:/);
    await expect(call("plan_device", { goal: "x", constraints: { board: "arduino-unoo" } })).rejects.toThrow(/no board 'arduino-unoo'.*Did you mean 'arduino-uno'/);
    const r = await call("plan_device", { goal: "a night light that turns on when it gets dark" });
    expect(r.board.type).toBe("arduino-uno");
    expect(r.bom.map((l: { type: string }) => l.type)).toEqual(expect.arrayContaining(["photoresistor", "resistor"]));
  });
});

describe("new_project {folder}", () => {
  it("creates, registers and opens a new folder instead of overwriting the playground", async () => {
    await call("new_project", { template: "blink" });
    const opened: string[] = [];
    s.dispose();
    s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test", projectsRoot: root, openProject: async (d) => void opened.push(d) });
    setServerBase("http://localhost:7845");
    const r = await call("new_project", { folder: true, name: "Plant Waterer", template: "uno", why: "a new idea" });
    expect(r.dir).toBe(join(root, "plant-waterer"));
    expect(r.id).toBe(projectId(r.dir));
    expect(r.opened).toBe(true);
    expect(r.viewer_url).toBe(`http://localhost:7845/v/${r.id}`);
    expect(opened).toEqual([r.dir]);
    expect(JSON.parse(readFileSync(join(r.dir, "jumper.json"), "utf8")).name).toBe("Plant Waterer");
    const log = readFileSync(join(r.dir, ".jumper", "actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ op: "new_project", actor: "mcp", client: "test-agent 1.0", ok: true });
    expect(listRegisteredProjects()[0]).toMatchObject({ dir: r.dir, name: "Plant Waterer", source: "agent" });
    // the playground is untouched
    expect(JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")).parts.length).toBe(3);
    // a second one with the same name gets -2
    expect((await call("new_project", { folder: "plant waterer" })).dir).toBe(join(root, "plant-waterer-2"));
  });

  it("without a host to switch, it says how to reopen; replacing a project points at folder", async () => {
    await call("new_project", { template: "blink" });
    await expect(call("new_project", { template: "uno" })).rejects.toThrow(/pass folder: true to start it in its own project folder/);
    const r = await call("new_project", { folder: "robot" });
    expect(r.opened).toBe(false);
    expect(r.note).toMatch(/reconnect the MCP server with --project .*robot/);
    expect(r).not.toHaveProperty("viewer_url");
  });
});

async function blinkWithTest() {
  await call("new_project", { template: "blank", name: "t" });
  await call("place_part", { type: "arduino-uno", why: "board" });
  await call("place_part", { type: "resistor", why: "parts" });
  await call("place_part", { type: "led" });
  await call("connect", { from: "uno.13", to: "r1.1", why: "wires" });
  await call("connect", { from: "r1.2", to: "led1.A" });
  await call("connect", { from: "led1.C", to: "uno.GND" });
  await call("write_file", { path: "firmware/main.ino", content: BLINK, why: "sketch" });
  await call("write_scenario", { id: "blinks", steps: [{ expect_serial: "LED on", within_ms: 500 }], why: "test" });
}

describe("run_tests accepts pending steps when everything passes", () => {
  it("accepts them (accepted_by tests) after a full green run", async () => {
    await blinkWithTest();
    expect((await call("get_project")).pending_steps).toBeGreaterThan(0);
    const r = await call("run_tests");
    expect(r.passed).toBe(1);
    expect(r.accepted_steps.by).toBe("tests");
    expect((await call("get_project")).pending_steps).toBe(0);
    const hist = JSON.parse(readFileSync(join(dir, ".jumper", "history.json"), "utf8"));
    expect(hist.steps.every((st: { status: string; accepted_by?: string }) => st.status === "accepted" && st.accepted_by === "tests")).toBe(true);
    await call("undo"); // still undoable
  });

  it("explains why they stay pending: a failure, a single test, a design error", async () => {
    await blinkWithTest();
    await call("write_scenario", { id: "never", steps: [{ expect_serial: "nope", within_ms: 100 }] });
    expect((await call("run_tests")).pending_steps).toMatchObject({ accepted: false, why: expect.stringMatching(/1 test failed/) });
    expect((await call("run_tests", { name: "blinks" })).pending_steps.why).toMatch(/only 'blinks' ran/);
    await call("remove", { id: "never" });
    await call("disconnect", { from: "r1.2", to: "led1.A" });
    await call("connect", { from: "uno.13", to: "led1.A" });
    expect((await call("run_tests")).pending_steps.why).toMatch(/check_design reports 1 error \(led-no-resistor\)/);
  });
});

describe("delete_file", () => {
  it("text files are an undoable step; binary files go to .jumper/trash; protected files are refused", async () => {
    await blinkWithTest();
    await call("write_file", { path: "firmware/probe.ino", content: "// probe\n" });
    const r = await call("delete_file", { path: "firmware/probe.ino", why: "clean up" });
    expect(r).toEqual({ deleted: "firmware/probe.ino", undoable: true });
    expect(existsSync(join(dir, "firmware/probe.ino"))).toBe(false);
    await call("undo");
    expect(readFileSync(join(dir, "firmware/probe.ino"), "utf8")).toBe("// probe\n");
    mkdirSync(join(dir, "shots"));
    writeFileSync(join(dir, "shots/old.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]));
    const b = await call("delete_file", { path: "shots/old.png" });
    expect(b.undoable).toBe(false);
    expect(existsSync(b.kept_in)).toBe(true);
    await expect(call("delete_file", { path: "jumper.json" })).rejects.toThrow(/refusing.*Fix:/);
    await expect(call("delete_file", { path: ".jumper/actions.jsonl" })).rejects.toThrow(/action log.*Fix:/);
    await expect(call("delete_file", { path: "firmware/main.ino" })).rejects.toThrow(/main sketch.*Fix: overwrite it with write_file/);
    await expect(call("delete_file", { path: "../escape.txt" })).rejects.toThrow(/outside the project/);
    await expect(call("delete_file", { path: "nope.txt" })).rejects.toThrow(/no file nope\.txt/);
  });
});

describe("stand-ins and agent-made parts in exports", () => {
  it("BOM and WIRING print the real part with a STAND-IN note", async () => {
    await call("new_project", { template: "uno" });
    await call("place_part", { type: "potentiometer", id: "soil1" });
    await call("connect", { from: "soil1.W", to: "uno.A0" });
    const m = await call("mark_stand_in", { id: "soil1", real: "capacitive soil moisture sensor", why: "no soil sensor in the catalog" });
    expect(m.stand_in_for).toBe("capacitive soil moisture sensor");
    const e = await call("export");
    const bom = readFileSync(join(dir, "export/BOM.md"), "utf8");
    expect(bom).toMatch(/\| 1 \| \*\*capacitive soil moisture sensor\*\* \| see the real part \| soil1 \|.*STAND-IN: Jumper simulated it as a .*Potentiometer/);
    expect(bom).toMatch(/## STAND-IN parts \(not what you buy\)/);
    expect(bom).not.toMatch(/\| Potentiometer/);
    const wiring = readFileSync(join(dir, "export/WIRING.md"), "utf8");
    expect(wiring).toMatch(/soil1\.W.* \[STAND-IN for capacitive soil moisture sensor\]/);
    expect(readFileSync(join(dir, "export/TEST-ON-HARDWARE.md"), "utf8")).toMatch(/soil1: the real capacitive soil moisture sensor/);
    expect(e.check_first).toEqual(["soil1: STAND-IN for capacitive soil moisture sensor"]);
    await call("mark_stand_in", { id: "soil1", real: null });
    expect(JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")).parts.find((p: { id: string }) => p.id === "soil1").standIn).toBeUndefined();
  });

  it("agent-made parts say agent-made: behavioral, unverified", async () => {
    const pot = registry.get("potentiometer")!;
    const made: PartDefinition = { ...pot, spec: { ...pot.spec, id: "soil-made", name: "Soil sensor (agent)" }, fidelity: { ...pot.fidelity, level: "behavioral", origin: "agent-made" } };
    s.dispose();
    s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test", registry: createRegistry([...registry.list(), made]) });
    await call("new_project", { template: "uno" });
    await call("place_part", { type: "soil-made", id: "soil1" });
    await call("export");
    expect(readFileSync(join(dir, "export/BOM.md"), "utf8")).toMatch(/Soil sensor \(agent\).*agent-made: behavioral, unverified[\s\S]*## Agent-made parts/);
    expect(readFileSync(join(dir, "export/WIRING.md"), "utf8")).toMatch(/\| soil1 \| Soil sensor \(agent\) \| agent-made: behavioral, unverified/);
    const plan = planDevice("water my plant", {}, createRegistry([...registry.list().filter((d) => !/soil/.test(d.spec.id)), { ...made, spec: { ...made.spec, id: "soil-moisture" } }]));
    expect(plan.bom.find((l) => l.type === "soil-moisture")).toMatchObject({ source: "agent-made", fidelity: "behavioral, unverified" });
  });
});

describe("show me", () => {
  it("viewer_url: a local link when Jumper's server runs, otherwise how to get one", async () => {
    await expect(call("viewer_url")).rejects.toThrow(/no Jumper server is running.*Fix: ask the person to start Jumper's local server/);
    setServerBase("http://localhost:7846/");
    const r = await call("viewer_url");
    expect(r.url).toBe(`http://localhost:7846/v/${projectId(dir)}`);
    expect(r.note).toMatch(/press its buttons/);
  });

  it("screenshot answers with an absolute path and, with a server, the viewer link", async () => {
    await call("new_project", { template: "blink" });
    setServerBase("http://localhost:7846");
    const r = await call("screenshot", { path: "shots/a.svg" });
    expect(r.path).toBe(join(dir, "shots/a.svg"));
    expect(r.viewer_url).toMatch(/\/v\/[0-9a-f]{12}$/);
  });

  it("record fails within 5 s, with the fix, when Chromium is missing", async () => {
    await call("new_project", { template: "blink" });
    const fake = () => ({ chromium: { launch: async () => { throw new Error("must not launch"); }, executablePath: () => "/nowhere/chromium" } });
    expect(chromiumProblem(fake)).toMatch(/no browser at \/nowhere\/chromium.*playwright install chromium/);
    const t = Date.now();
    await expect(recordProject({ dir, playwright: fake })).rejects.toThrow(/cannot record a video here.*playwright install chromium/);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(chromiumProblem(() => undefined)).toMatch(/Playwright is not installed/);
  });

  it("record: nothing to record, and no agent lines, say so", async () => {
    await expect(recordProject({ dir })).rejects.toThrow(/no action log yet.*Fix:/);
    await s.call("new_project", { template: "blink" }, { actor: "cli" });
    await expect(recordProject({ dir })).rejects.toThrow(/no agent calls to show.*1 cli.*actor": "all"/);
  });

  const chromium = !chromiumProblem();
  it.skipIf(!chromium || process.env.JUMPER_SKIP_RECORD === "1")(
    "record makes a real MP4 of the agent's build (Chromium + ffmpeg)",
    async () => {
      await blinkWithTest();
      await call("run", { ms: 2500 });
      const r = await call("record", { speed: 8, size: "640x360" });
      expect(existsSync(r.path)).toBe(true);
      expect(r.path.startsWith(join(dir, ".jumper", "media"))).toBe(true);
      expect(r.format === "mp4" || r.format === "webm").toBe(true);
      expect(r.duration_s).toBeGreaterThan(1);
      expect(r.url).toMatch(/^file:\/\//);
      expect(r.viewer_url).toBeNull();
      expect(r.steps).toBeGreaterThan(5);
      if (r.format === "mp4") expect(readFileSync(r.path).subarray(4, 8).toString()).toBe("ftyp");
    },
    180_000,
  );
});
