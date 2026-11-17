// Round 7 (voice): a project with a DFPlayer Mini talks on the canvas. The talking-egg example
// (Nano + DFPlayer + speaker + button) served by `faber serve` runs its golden firmware in the page:
// a speech bubble with the clip's words appears next to the speaker, a press makes it say the next
// line, the mute toggle is remembered, and the page never makes a sound under test (the browser's
// speechSynthesis is counted: it must stay at 0 calls).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectWithinSimTime, hubPort, shot } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../cli/bin/faber.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../../../examples/talking-egg-demo/", import.meta.url));

test.describe("talking egg from faber serve", () => {
  let dir = "";
  let hub: ChildProcess | undefined;
  let port = 0;

  test.beforeEach(async ({ page }, info) => {
    dir = mkdtempSync(join(tmpdir(), "faber-e2e-voice-"));
    cpSync(EXAMPLE, dir, { recursive: true, filter: (p) => !p.includes(".faber") });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "firmware", "main.hex"), later, later); // golden hex stays fresh: no Docker build
    const home = mkdtempSync(join(tmpdir(), "faber-e2e-home-"));
    const env = { ...process.env, FABER_HOME: home, FABER_AI_GATEWAY_PORT: "0" };
    expect(spawnSync(process.execPath, [CLI, "status", "-p", dir], { encoding: "utf8", timeout: 60_000, env }).status).toBe(0);
    // One port per test: a hub that was just killed can still answer on its old port for a moment.
    port = hubPort(info, /mute/.test(info.title) ? 13 : 12);
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    hub.stdout?.on("data", (b: Buffer) => void (out += b.toString()));
    hub.stderr?.on("data", (b: Buffer) => void (out += b.toString()));
    hub.once("exit", (code) => {
      if (code) console.log(`faber serve exited ${code}:\n${out.slice(-2000)}`);
    });
    await expect
      .poll(async () => (await fetch(`http://localhost:${port}/?local`).catch(() => undefined))?.status ?? 0, { timeout: 60_000 })
      .toBe(200);
    // Count what the page would say out loud; it must stay silent in tests.
    await page.addInitScript(() => {
      const w = window as unknown as { __spoken: number; speechSynthesis?: SpeechSynthesis };
      w.__spoken = 0;
      if (w.speechSynthesis) {
        const orig = w.speechSynthesis.speak.bind(w.speechSynthesis);
        w.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
          w.__spoken++;
          orig(u);
        };
      }
    });
  });

  test.afterEach(async () => {
    const h = hub;
    hub = undefined;
    if (h && h.exitCode === null) {
      const gone = new Promise((r) => h.once("exit", r));
      h.kill();
      await gone;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("the bubble shows what it says next to the speaker; a press says the next line; silent under test", async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.goto(`http://localhost:${port}/?local`);
    await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 30_000 });
    await expect(page.getByTestId("part-spk")).toBeVisible();
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("sim-error")).toHaveCount(0);
    const bubble = page.getByTestId("speech-bubble-spk");
    await expectWithinSimTime(page, 4000, async () => ((await bubble.textContent().catch(() => "")) ?? "").includes("hi! I'm Eggy"), 'the speech bubble should say "hi! I\'m Eggy"');
    // The bubble belongs to the speaker part on the canvas.
    await expect(page.getByTestId("part-spk").getByTestId("speech-bubble-spk")).toHaveCount(1);
    await shot(page, info, "voice-bubble");
    await page.evaluate(() => (window as unknown as { faber: { engine: { interact(id: string, k: string): void } } }).faber.engine.interact("btn1", "press"));
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as unknown as { faber: { engine: { interact(id: string, k: string): void } } }).faber.engine.interact("btn1", "release"));
    await expectWithinSimTime(page, 3000, async () => ((await bubble.textContent().catch(() => "")) ?? "").includes("whoa, I'm dizzy!"), 'a press should make it say "whoa, I\'m dizzy!"');
    // Done talking: the bubble goes away.
    await expectWithinSimTime(page, 4000, async () => (await bubble.count()) === 0, "the bubble should close when the clip ends");
    expect(await page.evaluate(() => (window as unknown as { __spoken: number }).__spoken)).toBe(0);
  });

  test("the mute toggle in the bubble is remembered", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`http://localhost:${port}/?local`);
    await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 30_000 });
    await page.getByTestId("run-button").click();
    const mute = page.getByTestId("speech-mute");
    await expectWithinSimTime(page, 4000, async () => (await mute.count()) > 0, "the bubble should show its mute button");
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("faber.speech.muted"))).toBe("1");
    await page.reload();
    await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 30_000 });
    await page.getByTestId("run-button").click();
    await expectWithinSimTime(page, 4000, async () => (await mute.count()) > 0, "the bubble should come back after a reload");
    await expect(mute).toHaveAttribute("aria-pressed", "true");
  });
});
