// Round 6, track power: the pocket Muse Claude built in round 5, re-wired so its LiPo really powers it
// (cell → TP4056 → slide switch → 1N5817 → XIAO 5V, USB unplugged). Its scenarios run from the battery.
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { ProjectSession } from "../src/index.ts";

const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}: the example's golden hex should be fresh`);
};
let dir = "";
let s: ProjectSession | undefined;
afterEach(() => {
  s?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function open(): ProjectSession {
  dir = mkdtempSync(join(tmpdir(), "jumper-muse-"));
  cpSync(MUSE, dir, { recursive: true, preserveTimestamps: true });
  const hex = join(dir, "firmware/main.hex");
  const later = new Date(Date.now() + 60_000);
  utimesSync(hex, later, later);
  void statSync(hex);
  return (s = new ProjectSession({ dir, builder: noBuild, actor: "test" }));
}
const call = (op: string, args: Record<string, unknown> = {}) => s!.call(op, args) as Promise<Record<string, any>>;

describe("claude-pocket-muse (round 6 power)", () => {
  it("is wired to run from its battery: power.usb false, soldered, check_design 0 errors", async () => {
    open();
    const p = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8"));
    expect(p.power).toEqual({ usb: false });
    expect(p.assembly).toBe("soldered");
    const c = await call("check_design");
    expect(c.errors, c.issues.join("\n")).toBe(0);
    expect(c.issues.join("\n")).toMatch(/ldo-dropout/);
  });

  it("all its scenarios pass on battery power, then check_design (with the live checks) still has 0 errors", async () => {
    open();
    const t = await call("run_tests");
    expect(t.failed, JSON.stringify(t.results?.filter((r: { passed: boolean }) => !r.passed))).toBe(0);
    expect(t.passed).toBe(11);
    await call("run", { ms: 2000, reset: true });
    const c = await call("check_design");
    expect(c.errors, c.issues.join("\n")).toBe(0);
  }, 300_000);
});
