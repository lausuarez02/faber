import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { actorCounts, filterActionLog, ProjectSession } from "../src/index.ts";

// The round-2 agent-run leftovers (STATUS.md "Open from the round-2 agent runs"), each with the
// message an agent now gets.

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const GOLDEN = readFileSync(join(EXAMPLES, "blink/firmware/blink.hex"), "utf8");
const BLINK = 'void setup(){Serial.begin(115200);pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);Serial.println("LED on");delay(1000);digitalWrite(13,LOW);Serial.println("LED off");delay(1000);}\n';
const fakeBuilder = async (req: BuildRequest): Promise<BuildResult> => {
  const src = readFileSync(join(req.sketchDir, req.main ?? "main.ino"), "utf8");
  if (src.includes("PROTO")) {
    return { ok: false, cached: false, durationMs: 1, hash: "x", errors: 1, warnings: 0, libraries: [], logTail: "", diagnostics: [{ severity: "error", file: `${req.displayPrefix}${req.main}`, line: 3, message: "'Pet' was not declared in this scope", hint: "move the Pet declaration into a header (write_file firmware/<sketch folder>/types.h and #include \"types.h\")" }] };
  }
  return { ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" };
};
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(actor = "test"): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-polish-"));
  dirs.push(dir);
  const s = new ProjectSession({ dir, builder: fakeBuilder, actor });
  sessions.push(s);
  return s;
}

function example(path: string): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-polish-ex-"));
  dirs.push(dir);
  cpSync(join(EXAMPLES, path), dir, { recursive: true, preserveTimestamps: true });
  const p = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")) as { firmware?: { artifact: string } };
  if (p.firmware) {
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, p.firmware.artifact), later, later);
  }
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  sessions.push(s);
  return s;
}

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

async function blinkWithButton(): Promise<ProjectSession> {
  const s = fresh();
  await call(s, "new_project", { template: "uno" });
  await call(s, "place_part", { type: "pushbutton", id: "btn1" });
  await call(s, "connect", { from: "btn1.1a", to: "uno.D2" });
  await call(s, "connect", { from: "btn1.2a", to: "uno.GND" });
  await call(s, "write_file", { path: "firmware/main.ino", content: BLINK });
  return s;
}

describe("scenario messages", () => {
  it("no stale-value warning when an earlier step proved the opposite value (claude-tamagotchi feed-lowers-hunger)", async () => {
    const s = example("agent-built/claude-tamagotchi");
    const t = await call(s, "run_tests", { name: "feed-lowers-hunger" });
    expect(t.passed).toBe(1);
    expect(t.results[0].warnings).toBeUndefined();
  }, 60_000);

  it("a press with hold_ms says it can hide reactions shorter than the hold", async () => {
    const s = await blinkWithButton();
    await call(s, "write_scenario", { id: "hold", steps: [{ run_ms: 900 }, { press: "btn1", hold_ms: 200 }, { expect_pin: "uno.D13", level: "high" }] });
    const t = await call(s, "run_tests", { name: "hold" });
    expect(t.failed).toBe(1);
    expect(t.results[0].reason).toMatch(/held btn1 for 200 ms and released it before this check began.*shorter than 200 ms.*Fix: \{"press": "btn1"\} without hold_ms/);
  });

  it("a scenario timeout says how to fix it", async () => {
    const s = await blinkWithButton();
    await call(s, "write_scenario", { id: "slow", timeout_ms: 500, steps: [{ run_ms: 600 }, { expect_pin: "uno.D13", level: "high" }] });
    const t = await call(s, "run_tests", { name: "slow" });
    expect(t.results[0].reason).toMatch(/timed out: .*run_ms \/ wait_ms \/ hold_ms steps so far add up to 600 ms.*Fix: raise the scenario's "timeout_ms" \(write_scenario \{"id": "slow", "timeout_ms": 6000/);
  });

  it("the auto-prototype hint names the real sketch folder", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "uno" });
    await call(s, "write_file", { path: "firmware/main.ino", content: "// PROTO\nvoid setup(){}\nvoid loop(){}\n" });
    const b = await call(s, "build");
    expect(b.ok).toBe(false);
    expect(b.errors.join(" ")).toMatch(/write_file firmware\/types\.h/);
    expect(b.errors.join(" ")).not.toMatch(/<sketch folder>/);
  });
});

describe("robot runs", () => {
  it("run reports when, where and what the rover first hit", async () => {
    const s = example("rover");
    const p = JSON.parse(readFileSync(join(s.dir, "jumper.json"), "utf8")) as { world: { obstacles: unknown[]; robot: { start: unknown } } };
    // A thin post beside the sonar's cone: the rover drives into it.
    p.world.obstacles = [{ id: "post", shape: "circle", x: 58, y: 45, r: 1.5 }];
    p.world.robot.start = { x: 40, y: 40, heading: 0 };
    await call(s, "set_world", { world: p.world });
    const r = await call(s, "run", { ms: 1500 });
    expect(r.world.collisions).toBeGreaterThan(0);
    expect(r.world.first_collision).toMatchObject({ with: ["post"] });
    expect(r.world.first_collision.t_ms).toBeGreaterThan(0);
    expect(r.world.first_collision.t_ms).toBeLessThan(1500);
    expect(r.world.first_collision.note).toMatch(/^first hit post at ~\d+ ms, robot at x [\d.]+, y [\d.]+ cm, heading/);
    // A failing collision check quotes it.
    await call(s, "write_scenario", { id: "no-hit", steps: [{ run_ms: 1500 }, { expect_part: "world.collisions", op: "==", value: 0 }] });
    const t = await call(s, "run_tests", { name: "no-hit" });
    expect(t.results[0].reason).toMatch(/first hit post at ~\d+ ms/);
  }, 60_000);

  it("a sonar trigger pulse is not called servo-style", async () => {
    const s = example("rover");
    const r = await call(s, "run", { ms: 600 });
    const pulses = Object.values(r.pins as Record<string, string>).filter((v) => v.includes("pulse"));
    for (const v of pulses) if (/ \d{1,2}us/.test(v)) expect(v).not.toMatch(/servo-style/);
  }, 60_000);
});

describe("action log: who did what", () => {
  it("tags every line with actor, session id and client, and filters by them", async () => {
    const s = fresh("cli");
    await call(s, "new_project", { template: "uno" });
    await s.call("place_part", { type: "led" }, { actor: "mcp", client: "claude-code 2.1.319" });
    await s.call("place_part", { type: "led" }, { actor: "web" });
    const text = readFileSync(s.actionLogFile, "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { actor: string; sid: string; client?: string });
    expect(lines.map((l) => l.actor)).toEqual(["cli", "mcp", "web"]);
    expect(new Set(lines.map((l) => l.sid))).toEqual(new Set([s.sid]));
    expect(lines[1]!.client).toBe("claude-code 2.1.319");
    expect(actorCounts(text)).toEqual({ cli: 1, mcp: 1, web: 1 });
    const agentOnly = filterActionLog(text, { actor: "mcp" }).trim().split("\n");
    expect(agentOnly).toHaveLength(1);
    expect(filterActionLog(text, { client: "claude" }).trim().split("\n")).toHaveLength(1);
    expect(filterActionLog(text, { actor: "mcp,web" }).trim().split("\n")).toHaveLength(2);
    expect(filterActionLog(text, {})).toBe(text);
  });
});
