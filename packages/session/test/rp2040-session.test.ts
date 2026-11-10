// The pocket boards (RP2040) through the session, the same path agents and the CLI use: templates,
// typical_connections on a 3.3 V board, pin names, run / run_tests on rp2040js, export with a UF2.
// The builder is faked with golden arduino-pico builds of the template sketches
// (packages/sim-backends/fixtures/template_*.hex; the test checks the sketches still match).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { ProjectSession, TEMPLATES } from "../src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../sim-backends/fixtures/", import.meta.url));
const TEMPLATE_FIXTURE: Record<string, string> = {
  "rp2040:rp2040:rpipico": "template_pico",
  "rp2040:rp2040:seeed_xiao_rp2040": "template_xiao",
  "rp2040:rp2040:waveshare_rp2040_zero": "template_zero",
};

const builds: BuildRequest[] = [];
const builder = async (req: BuildRequest): Promise<BuildResult> => {
  builds.push(req);
  const name = TEMPLATE_FIXTURE[req.fqbn];
  if (!name) throw new Error(`no golden build for ${req.fqbn}`);
  const hex = readFileSync(join(FIXTURES, `${name}.hex`), "utf8");
  return { ok: true, hex, cached: false, durationMs: 1, hash: name, diagnostics: [], errors: 0, warnings: 0, size: { flash: 54456, flashMax: 2093056, ram: 8900, ramMax: 262144 }, libraries: [], logTail: "" };
};

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  builds.length = 0;
});

function fresh(): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-rp2040-"));
  dirs.push(dir);
  const s = new ProjectSession({ dir, builder, actor: "test" });
  sessions.push(s);
  return s;
}

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe("RP2040 templates", { timeout: 60_000 }, () => {
  it("the golden template builds are of the current template sketches", () => {
    for (const [t, name] of [["pico", "template_pico"], ["xiao-rp2040", "template_xiao"], ["rp2040-zero", "template_zero"]] as const) {
      expect(readFileSync(join(FIXTURES, name, `${name}.ino`), "utf8"), t).toBe(TEMPLATES[t]!.files["firmware/main.ino"]);
    }
  });

  for (const [template, board, fqbn] of [
    ["pico", "pico", "rp2040:rp2040:rpipico"],
    ["xiao-rp2040", "xiao", "rp2040:rp2040:seeed_xiao_rp2040"],
    ["rp2040-zero", "zero", "rp2040:rp2040:waveshare_rp2040_zero"],
  ] as const) {
    it(`${template}: builds with ${fqbn}, says ready over USB serial and passes its scenario`, async () => {
      const s = fresh();
      await call(s, "new_project", { template });
      const r = await call(s, "run", { ms: 1500 });
      expect(builds.at(-1)?.fqbn).toBe(fqbn);
      expect(r.serial).toMatch(/^ready\r?\n/);
      const t = await call(s, "run_tests", {});
      expect(t.failed).toBe(0);
      expect(t.passed).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(join(s.dir, "jumper.json"), "utf8")).parts[0]).toMatchObject({ id: board });
    });
  }

  it("xiao-rp2040 blinks the active-low red user LED", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "xiao-rp2040" });
    const a = await call(s, "run", { ms: 250 });
    const b = await call(s, "run", { ms: 500 });
    expect([a.parts?.xiao?.led_r, b.parts?.xiao?.led_r].sort()).toEqual([0, 1]);
  });
});

describe("wiring a 3.3 V pocket board", () => {
  it("typical_connections use the board's own pins: Wire on GP6/GP7, 3V3 for a 3.3 V module, free GPIOs", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "xiao-rp2040" });
    const oled = await call(s, "place_part", { type: "ssd1306-oled-i2c" });
    expect(oled.typical_connections).toEqual(["oled1.GND -> xiao.GND.1", "oled1.VCC -> xiao.3V3", "oled1.SCL -> xiao.GP7", "oled1.SDA -> xiao.GP6"]);
    const btn = await call(s, "place_part", { type: "pushbutton" });
    expect(btn.typical_connections).toContain("btn1.1a -> xiao.GP26");
    const pot = await call(s, "place_part", { type: "potentiometer" });
    expect(pot.typical_connections).toContain("pot1.W -> xiao.GP27");
    expect(pot.typical_connections).toContain("pot1.1 -> xiao.3V3");
  });

  it("on a Pico, a button gets a plain GPIO and an analog sensor an ADC pin", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico" });
    const btn = await call(s, "place_part", { type: "pushbutton" });
    expect(btn.typical_connections).toContain("btn1.1a -> pico.GP2");
    const pot = await call(s, "place_part", { type: "potentiometer" });
    expect(pot.typical_connections).toContain("pot1.W -> pico.GP26");
  });

  it("accepts silkscreen and GPIO names: xiao.D4 → GP6, pico.15 / pico.GPIO15 → GP15, pico.5V → VBUS", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "xiao-rp2040" });
    await call(s, "place_part", { type: "ssd1306-oled-i2c" });
    const w = await call(s, "connect", { from: "oled1.SDA", to: "xiao.D4" });
    expect(JSON.stringify(w)).toContain("GP6");
    const p = fresh();
    await call(p, "new_project", { template: "pico" });
    await call(p, "place_part", { type: "led" });
    await call(p, "place_part", { type: "resistor" });
    expect(JSON.stringify(await call(p, "connect", { from: "r1.1", to: "pico.15" }))).toContain("GP15");
    expect(JSON.stringify(await call(p, "connect", { from: "r1.2", to: "pico.GPIO15" }))).toContain("GP15");
    expect(JSON.stringify(await call(p, "connect", { from: "led1.A", to: "pico.5V" }))).toContain("VBUS");
  });

  it("export writes firmware.uf2 for the BOOTSEL drive and says how to flash it", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico" });
    await call(s, "build", {});
    const r = await call(s, "export", {});
    expect(r.files).toEqual(expect.arrayContaining(["firmware.hex", "firmware.uf2"]));
    expect(r.flash).toMatch(/BOOTSEL.*firmware\.uf2.*RPI-RP2/);
    const uf2 = readFileSync(join(r.dir, "firmware.uf2"));
    expect(uf2.length % 512).toBe(0);
    expect(uf2.readUInt32LE(0)).toBe(0x0a324655);
    expect(uf2.readUInt32LE(28)).toBe(0xe48bff56);
    expect(existsSync(join(r.dir, "firmware.hex"))).toBe(true);
  });
});

// DRC for 3.3 V boards is the agent track's (decision 0003, C5: `logic-level`, `part-needs-5v`).
// Written against that contract; it runs once drc.ts has those codes (after the agent merge).
const AGENT_DRC = readFileSync(fileURLToPath(new URL("../src/drc.ts", import.meta.url)), "utf8").includes("part-needs-5v");

describe("check_design on a 3.3 V board (agent track's C5 codes)", () => {
  it("warns about a 5 V-only part on the 3V3 rail and a 5 V signal into a GPIO", async (ctx) => {
    if (!AGENT_DRC) ctx.skip();
    const s = fresh();
    await call(s, "new_project", { template: "pico" });
    // HC-SR04: needs 5 V (supply min above 3.6 V) and its ECHO output swings to 5 V.
    await call(s, "place_part", { type: "hc-sr04", id: "sonar" });
    await call(s, "connect", { from: "sonar.VCC", to: "pico.3V3" });
    await call(s, "connect", { from: "sonar.GND", to: "pico.GND" });
    await call(s, "connect", { from: "sonar.TRIG", to: "pico.GP2" });
    await call(s, "connect", { from: "sonar.ECHO", to: "pico.GP3" });
    let text = (await call(s, "check_design")).issues.join("\n");
    expect(text).toMatch(/part-needs-5v/);
    // Powered from VBUS it works, but ECHO now drives 5 V into a 3.3 V pin.
    await call(s, "disconnect", { from: "sonar.VCC", to: "pico.3V3" });
    await call(s, "connect", { from: "sonar.VCC", to: "pico.VBUS" });
    text = (await call(s, "check_design")).issues.join("\n");
    expect(text).not.toMatch(/part-needs-5v/);
    expect(text).toMatch(/logic-level/);
  });

  it("a 3.3 V output into a 5 V part's input is fine (no logic-level warning)", async (ctx) => {
    if (!AGENT_DRC) ctx.skip();
    const s = fresh();
    await call(s, "new_project", { template: "pico" });
    await call(s, "place_part", { type: "ssd1306-oled-i2c" });
    for (const [a, b] of [["oled1.GND", "pico.GND"], ["oled1.VCC", "pico.3V3"], ["oled1.SDA", "pico.GP4"], ["oled1.SCL", "pico.GP5"]]) await call(s, "connect", { from: a, to: b });
    const text = (await call(s, "check_design")).issues.join("\n");
    expect(text).not.toMatch(/logic-level|part-needs-5v/);
  });

  it("an unwired I2C part's fix names the board's own Wire pins, not the Uno's A4/A5", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "xiao-rp2040" });
    await call(s, "place_part", { type: "ssd1306-oled-i2c" });
    const text = (await call(s, "check_design")).issues.join("\n");
    expect(text).toMatch(/\[i2c-unwired\].*Fix: connect oled1\.SDA → xiao\.GP6 \(D4\/SDA\)/);
    expect(text).not.toMatch(/A4|Uno\/Nano/);
  });
});
