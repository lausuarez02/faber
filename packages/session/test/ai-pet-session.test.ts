import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@fabwright/runner";
import { ProjectSession, TOOLS } from "../src/index.ts";

// The AI pet through the session as an agent drives it: the network tools, colour screenshots and
// run_tests with its visual summary and screen images. Mock AI only (deterministic, no network).
const EXAMPLE = fileURLToPath(new URL("../../../examples/ai-pet/", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}: the golden hex should be fresh`);
};

const dir = mkdtempSync(join(tmpdir(), "fabwright-ai-pet-"));
cpSync(EXAMPLE, dir, { recursive: true, preserveTimestamps: true });
const later = new Date(Date.now() + 60_000);
utimesSync(join(dir, "firmware/ai-pet.hex"), later, later);
const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe("AI pet session", () => {
  it("lists the network tools", () => {
    for (const n of ["set_ai_mode", "read_network_log", "run_live"]) expect(TOOLS.map((t) => t.name)).toContain(n);
  });

  it("joins Wi-Fi, TALK gets a mock reply, the network log shows the request", async () => {
    expect((await call("set_ai_mode", { mode: "mock" })).provider).toBe("Mock");
    await call("run", { ms: 4000 });
    await call("interact", { part: "btnTalk", action: "click" });
    const r = await call("run", { ms: 2500 });
    expect(r.serial).toMatch(/bubble: \S/);
    const log = await call("read_network_log");
    const http = (log.entries as Record<string, unknown>[]).find((e) => typeof e.http === "string");
    expect(http).toMatchObject({ status: 200, provider: "Mock" });
    expect(String(http!.http)).toMatch(/ai\.fabwright\/v1\/pet\?a=talk/);
  }, 60_000);

  it("the canvas screenshot embeds the colour screen", async () => {
    const r = await call("screenshot", { path: "shot.svg" });
    const svg = readFileSync(r.path as string, "utf8");
    expect(svg).toMatch(/<image [^>]*href="data:image\/png;base64,/);
  });

  it("set_ai_mode rejects an unknown mode with the fix", async () => {
    await expect(call("set_ai_mode", { mode: "turbo" })).rejects.toThrow(/modes are mock and live/);
  });

  it("run_tests returns a visual line per check and screen PNGs on request", async () => {
    const t = await call("run_tests", { name: "talk-shows-reply-bubble", images: true });
    expect(t.passed).toBe(1);
    expect(t.results[0].visual.some((l: string) => /serial "bubble: "/.test(l))).toBe(true);
    expect(t.frame_images).toHaveLength(1);
    expect(existsSync(t.frame_images[0])).toBe(true);
    expect(s.lastVisualReport?.scenarios[0]?.frames.length).toBeGreaterThan(0);
    // Saved too, so the Tests panel still has it after `fabwright serve` restarts.
    const saved = JSON.parse(readFileSync(join(s.dir, ".fabwright", "visual-report.json"), "utf8"));
    expect(saved).toMatchObject({ format: "fabwright-visual-report/1", passed: 1 });
  }, 60_000);

  // Agent eval (claude-ai-pet, 2026-11-09): expect_display refused the TFT ("has no screen"), so
  // three write_scenario calls failed and the tests fell back to whole-screen brightness.
  it("read_display and expect_display work on the colour TFT (a region and a golden frame)", async () => {
    await call("run", { ms: 4000, reset: true });
    const d = await call("read_display", { part: "tft", scale: 8 });
    expect(d.width).toBe(320);
    expect(d.lit_pixels).toBeGreaterThan(1000);
    expect(String(d.screen)).toContain("#");
    const saved = await call("read_display", { part: "tft", region: [0, 0, 320, 24], save_as: "tft-top" });
    expect(saved.region_lit).toBeGreaterThan(0);
    await call("write_scenario", {
      id: "tft-region",
      why: "test: expect_display on a colour screen",
      steps: [
        { run_ms: 4000 },
        { expect_display: "tft", region: [0, 0, 320, 240], lit: { min: 1000 } },
        { expect_display: "tft", matches: "tft-top", within_ms: 1000 },
      ],
    });
    const t = await call("run_tests", { name: "tft-region" });
    expect(t.results[0].reason).toBeUndefined();
    expect(t.passed).toBe(1);
  }, 60_000);
});
