import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { parseScenarioStep } from "@faber/project-format";
import { ProjectSession } from "../src/index.ts";

// Regression tests for the friction real agents hit (Claude Code: tamagotchi and arm; Codex: rover).
// Each test replays the call that went wrong and checks the improved behaviour or message.

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const GOLDEN = readFileSync(join(EXAMPLES, "blink/firmware/blink.hex"), "utf8");
const fakeBuilder = async (_req: BuildRequest): Promise<BuildResult> => ({ ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, size: { flash: 1992, flashMax: 32256, ram: 202, ramMax: 2048 }, libraries: [], logTail: "" });
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "faber-evals-"));
  dirs.push(dir);
  const s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test" });
  sessions.push(s);
  return s;
}

/** An example copied to a temp folder with its golden hex kept fresh (no Docker). */
function example(name: string): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), `faber-evals-${name}-`));
  dirs.push(dir);
  cpSync(join(EXAMPLES, name), dir, { recursive: true, preserveTimestamps: true });
  const p = JSON.parse(readFileSync(join(dir, "faber.json"), "utf8")) as { firmware?: { artifact: string } };
  if (p.firmware) {
    const hex = join(dir, p.firmware.artifact);
    const later = new Date(Date.now() + 60_000);
    utimesSync(hex, later, later);
    void statSync(hex);
  }
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  sessions.push(s);
  return s;
}

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;
const errorOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the call to fail");
};

describe("scenario regex (claude-tamagotchi: 6 failed write_scenario calls)", () => {
  it("accepts regex next to expect_serial, or alone, and stores the canonical nested form", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "uno" });
    const r = await call(s, "write_scenario", {
      id: "moods",
      steps: [
        { expect_serial: "MOOD", regex: "MOOD \\w+ -> sad", within_ms: 50000 },
        { regex: "ready|hello", within_ms: 1000 },
      ],
    });
    expect(r.normalized).toHaveLength(2);
    expect(r.normalized[0]).toMatch(/moved "regex" inside expect_serial/);
    const saved = JSON.parse(readFileSync(join(s.dir, "faber.json"), "utf8")).scenarios.find((x: { id: string }) => x.id === "moods");
    expect(saved.steps[0]).toEqual({ expect_serial: { regex: "MOOD \\w+ -> sad" }, within_ms: 50000 });
    expect(saved.steps[1]).toEqual({ expect_serial: { regex: "ready|hello" }, within_ms: 1000 });
  });

  it("an unknown key on expect_serial lists the allowed ones and shows the regex form", () => {
    const r = parseScenarioStep({ expect_serial: "MOOD", pattern: "MOOD \\w+" });
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.issues.map((i) => i.message).join(" ") : "";
    expect(msg).toMatch(/allowed: expect_serial, within_ms, absent, name/);
    expect(msg).toMatch(/Fix: put the pattern inside expect_serial: \{"expect_serial": \{"regex"/);
    expect(msg).toMatch(/"expect_serial": \{ "regex": /);
  });
});

describe("expect_serial_value (claude-tamagotchi: exact values broke on the stat tick)", () => {
  it("compares the latest printed number", async () => {
    const s = example("tamagotchi");
    await call(s, "write_scenario", {
      id: "energy-range",
      steps: [
        { expect_serial_value: "energy", op: ">=", value: 60, within_ms: 1500 },
        { expect_serial_value: "food", op: "<", value: 79, within_ms: 3000 },
      ],
    });
    const t = await call(s, "run_tests", { name: "energy-range" });
    expect(t.failed, JSON.stringify(t.results)).toBe(0);
    await call(s, "write_scenario", { id: "too-hungry", steps: [{ expect_serial_value: "food", op: ">", value: 200, within_ms: 1200 }] });
    const bad = await call(s, "run_tests", { name: "too-hungry" });
    expect(bad.results[0].reason).toMatch(/expected food > 200 but the latest printed value is \d+ after waiting 1200 ms/);
  }, 60_000);
});

describe("expect_display (claude-tamagotchi: the face could not be tested)", () => {
  it("checks lit pixels in a region and matches a golden frame saved with read_display save_as", async () => {
    const s = example("tamagotchi");
    await call(s, "run", { ms: 1500 });
    const d = await call(s, "read_display", { part: "oled", region: [0, 0, 128, 64], save_as: "awake" });
    expect(d.saved_as).toBe("awake");
    expect(d.region_lit).toBeGreaterThan(50);
    expect(existsSync(join(s.dir, "snapshots/awake.json"))).toBe(true);
    await call(s, "write_scenario", {
      id: "face",
      steps: [
        { expect_display: "oled", lit: { min: 50 }, within_ms: 1500 },
        { expect_display: "oled", matches: "awake", tolerance: 0.05, within_ms: 3000 },
      ],
    });
    const t = await call(s, "run_tests", { name: "face" });
    expect(t.failed, JSON.stringify(t.results)).toBe(0);
    const err = await errorOf(call(s, "write_scenario", { id: "nope", steps: [{ expect_display: "oled", matches: "sad-face" }] }));
    expect(err).toMatch(/no snapshot 'sad-face'.*Fix: run until the screen shows it, then read_display \{"part": "oled", "save_as": "sad-face"\}/);
    const tooBig = await call(s, "write_scenario", { id: "big", steps: [{ expect_display: "oled", region: [100, 0, 64, 64], lit: { min: 1 } }] });
    expect(tooBig.scenario).toBe("big");
    const r = await call(s, "run_tests", { name: "big" });
    expect(r.results[0].reason).toMatch(/does not fit the screen.*128x64/);
  }, 60_000);
});

describe("pin suggestions (both Claude runs: every button was told D2)", () => {
  it("place_part suggests the next free pin of the same kind", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "uno" });
    await call(s, "place_part", { type: "ssd1306-oled-i2c" });
    const a = await call(s, "place_part", { type: "pushbutton", id: "btnFeed" });
    const b = await call(s, "place_part", { type: "pushbutton", id: "btnPlay" });
    const c = await call(s, "place_part", { type: "pushbutton", id: "btnSleep" });
    expect(a.typical_connections).toContain("btnFeed.1a -> uno.D2");
    expect(b.typical_connections).toContain("btnPlay.1a -> uno.D4");
    expect(c.typical_connections).toContain("btnSleep.1a -> uno.D7");
    const s1 = await call(s, "place_part", { type: "servo-sg90", id: "shoulder" });
    const s2 = await call(s, "place_part", { type: "servo-sg90", id: "elbow" });
    expect(s1.typical_connections).toContain("shoulder.SIG -> uno.D9");
    expect(s2.typical_connections).toContain("elbow.SIG -> uno.D10");
    const p1 = await call(s, "place_part", { type: "potentiometer" });
    const p2 = await call(s, "place_part", { type: "potentiometer" });
    expect(p1.typical_connections).toContain("pot1.W -> uno.A0");
    expect(p2.typical_connections).toContain("pot2.W -> uno.A1");
  });

  it("skips pins that are already wired", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "uno" });
    await call(s, "place_part", { type: "pushbutton" });
    await call(s, "connect", { from: "btn1.1a", to: "uno.D2" });
    const b = await call(s, "place_part", { type: "pushbutton" });
    expect(b.typical_connections).toContain("btn2.1a -> uno.D4");
  });
});

describe("floating-input while the sketch is the template (both Claude runs)", () => {
  it("connect gives a reminder, not a warning, until the sketch is written", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "uno" });
    await call(s, "place_part", { type: "pushbutton" });
    const w = await call(s, "connect", { from: "btn1.1a", to: "uno.D2" });
    await call(s, "connect", { from: "btn1.2a", to: "uno.GND" });
    expect(w.warnings).toBeUndefined();
    expect(w.reminders?.[0]).toMatch(/pinMode\(2, INPUT_PULLUP\)/);
    expect((await call(s, "check_design")).warnings).toBe(0);
    await call(s, "write_file", { path: "firmware/main.ino", content: "void setup(){pinMode(2, INPUT);}\nvoid loop(){}\n" });
    const c = await call(s, "check_design");
    expect(c.issues.join("\n")).toMatch(/warning \[floating-input\]/);
  });
});

describe("live prop changes (codex-rover: battery voltage ignored)", () => {
  it("set_part_property reaches the running simulation and survives run {reset: true}", async () => {
    const s = example("rover");
    const a = await call(s, "run", { ms: 300 });
    expect(a.parts.bat.volts).toBeGreaterThan(8);
    const set = await call(s, "set_part_property", { id: "bat", prop: "voltage", value: 6 });
    expect(set.simulation).toMatch(/applied live/);
    const b = await call(s, "run", { ms: 300 });
    expect(b.parts.bat.volts).toBeLessThan(6.01);
    const c = await call(s, "run", { ms: 300, reset: true });
    expect(c.t_ms).toBeCloseTo(300, 0);
    expect(c.parts.bat.volts).toBeLessThan(6.01);
  }, 60_000);

  it("a prop of a part the robot world uses restarts the simulation and says so", async () => {
    const s = example("rover");
    await call(s, "run", { ms: 300 });
    const set = await call(s, "set_part_property", { id: "chassis", prop: "wheelRadius", value: 4 });
    expect(set.simulation).toMatch(/restarts the simulation at 0 ms/);
    const r = await call(s, "run", { ms: 200 });
    expect(r.t_ms).toBeCloseTo(200, 0);
  }, 60_000);
});

describe("design checks (codex-rover false positives, claude-arm missed brown-out)", () => {
  it("the rover has no chassis or USB power-budget warnings", async () => {
    const s = example("rover");
    const c = await call(s, "check_design");
    expect(c.issues.join("\n")).not.toMatch(/not-connected|power-budget|not-in-world/);
  });

  it("a pinless chassis with no world gets a fix that is possible", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "uno" });
    await call(s, "place_part", { type: "robot-chassis-2wd" });
    const c = await call(s, "check_design");
    expect(c.issues.join("\n")).toMatch(/\[not-in-world\].*Fix: add a world with set_world/);
    expect(c.issues.join("\n")).not.toMatch(/wire it/);
  });

  it("two servos on the Uno 5V warn about the power budget", async () => {
    const s = example("robot-arm");
    const c = await call(s, "check_design");
    expect(c.issues.join("\n")).toMatch(/\[power-budget\] uno's 5V rail feeds about 500 mA.*shoulder 250 mA moving.*Fix: power shoulder, elbow from a separate supply/);
  });
});

describe("scenario failure hints (codex-rover, claude-arm)", () => {
  it("expect_part without within_ms says it was checked once and how to wait", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "blink" });
    await call(s, "write_scenario", { id: "early", steps: [{ expect_part: "led1.on", op: "==", value: true }] });
    const t = await call(s, "run_tests", { name: "early" });
    expect(t.results[0].reason).toMatch(/checked once at 0 ms; add within_ms to wait/);
  });

  it("warns when a within_ms wait already held right after an input", async () => {
    const s = example("robot-arm");
    await call(s, "write_scenario", {
      id: "lazy",
      steps: [{ run_ms: 1500 }, { set: "potE.position", value: 0.1 }, { expect_part: "elbow.angle", op: ">", value: 42, within_ms: 1500 }],
    });
    const t = await call(s, "run_tests", { name: "lazy" });
    expect(t.results[0].passed).toBe(true);
    expect(t.results[0].warnings?.[0]).toMatch(/already held 0 ms after step 1 \(set\).*wait for the side the value moves toward/);
  }, 60_000);
});

describe("robot arm surface (claude-arm)", () => {
  it("set_world for an arm hints the arm fields, not the rover's", async () => {
    const s = example("robot-arm");
    const world = JSON.parse(readFileSync(join(s.dir, "faber.json"), "utf8")).world;
    const r = await call(s, "set_world", { world });
    expect(r.next).toMatch(/world\.gripper_x/);
    expect(r.next).not.toMatch(/chassis|collisions/);
  });

  it("run shows servo pins as pulses, not as idle LOW", async () => {
    const s = example("robot-arm");
    const r = await call(s, "run", { ms: 1000 });
    const pulsing = Object.values(r.pins as Record<string, string>).filter((v) => /out pulse 50Hz \d+us/.test(v));
    expect(pulsing.length).toBe(2);
  }, 60_000);

  it("screenshot can replay a scenario up to a step", async () => {
    const s = example("robot-arm");
    const sc = JSON.parse(readFileSync(join(s.dir, "faber.json"), "utf8")).scenarios[0];
    const r = await call(s, "screenshot", { path: "shots/at.svg", scenario: sc.id, at_step: 2 });
    expect(r.scenario).toBe(sc.id);
    expect(r.at_step).toBe(2);
    expect(r.t_ms).toBeCloseTo(1500, 0);
    const err = await errorOf(call(s, "screenshot", { scenario: sc.id, at_step: 999 }));
    expect(err).toMatch(/at_step 999 is out of range.*Fix: pass a step index between 0 and/);
  }, 60_000);
});
