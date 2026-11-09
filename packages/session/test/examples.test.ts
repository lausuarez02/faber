import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { composeSvg, ProjectSession } from "../src/index.ts";

// The robot and display examples, run through the session exactly as an agent would (run_tests,
// run, screenshot), with their committed golden firmware (no Docker needed).
const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));

const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}: the example's golden hex should be fresh`);
};

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Copy an example to a temp folder, keeping the hex newer than its sources (so it is "fresh"). */
function open(name: string): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), `jumper-example-${name}-`));
  dirs.push(dir);
  cpSync(join(EXAMPLES, name), dir, { recursive: true, preserveTimestamps: true });
  const p = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")) as { firmware?: { artifact: string } };
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

describe("examples through the agent surface", () => {
  it("tamagotchi: every scenario passes and read_display shows the pet", async () => {
    const s = open("tamagotchi");
    const t = await call(s, "run_tests");
    expect(t.failed, JSON.stringify(t.results?.filter((r: { passed: boolean }) => !r.passed))).toBe(0);
    expect(t.passed).toBeGreaterThanOrEqual(5);
    await call(s, "run", { ms: 1500 });
    const d = await call(s, "read_display", { part: "oled" });
    expect(d.lit_pixels).toBeGreaterThan(200);
    expect(d.screen).toMatch(/#/);
  }, 120_000);

  it("rover: drives 20 s with no collision; run reports the pose; scenarios read world.*", async () => {
    const s = open("rover");
    const r = await call(s, "run", { ms: 3000 });
    expect(r.world.robot.x).toBeTypeOf("number");
    expect(r.world.collisions).toBe(0);
    expect(r.world.travelled_cm).toBeGreaterThan(30);
    expect(r.world.assert).toContain("world.<field>");
    const t = await call(s, "run_tests");
    expect(t.failed, JSON.stringify(t.results)).toBe(0);
  }, 120_000);

  it("robot arm: pots set by inverse kinematics put the gripper in the cup", async () => {
    const s = open("robot-arm");
    const t = await call(s, "run_tests");
    expect(t.failed, JSON.stringify(t.results)).toBe(0);
    const r = await call(s, "run", { ms: 500 });
    expect(r.world.arm.gripper.x).toBeTypeOf("number");
  }, 120_000);

  it("world.<field> on a project without a world says how to fix it", async () => {
    const s = open("tamagotchi");
    await expect(call(s, "write_scenario", { id: "bad", steps: [{ expect_part: "world.collisions", op: "==", value: 0 }] })).rejects.toThrow(/no world block.*set_world/s);
  }, 60_000);

  it("the screenshot draws the robot's world next to the circuit", async () => {
    const s = open("rover");
    await call(s, "run", { ms: 2000 });
    const host = (s as unknown as { host: { physics: { snapshot(): any } } }).host;
    const svg = composeSvg((s as unknown as { project: any }).project, (s as unknown as { registry: any }).registry, { world: host.physics.snapshot() });
    expect(svg).toContain('data-world="world"');
    expect(svg).toContain("collisions 0");
    expect(readdirSync(EXAMPLES)).toContain("rover");
  }, 60_000);
});
