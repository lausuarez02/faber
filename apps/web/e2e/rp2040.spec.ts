// Pocket boards in the browser: the three RP2040 boards are in the library, and a XIAO RP2040
// project served by `jumper serve` runs its real arduino-pico firmware in the page (rp2040js with
// Jumper's ROM): the active-low user LED blinks and USB serial prints "ready".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectAttrWithinSimTime, expectWithinSimTime, hubPort, openCanvas, openSerial, requireParts, shot } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const TEMPLATE_HEX = fileURLToPath(new URL("../../../packages/sim-backends/fixtures/template_xiao.hex", import.meta.url));

test("the RP2040 boards are in the parts library", async ({ page }) => {
  await openCanvas(page);
  await requireParts(page, ["raspberry-pi-pico", "seeed-xiao-rp2040", "waveshare-rp2040-zero"]);
});

test.describe("XIAO RP2040 project from jumper serve", () => {
  let dir = "";
  let hub: ChildProcess | undefined;
  let port = 0;

  test.beforeEach(async ({}, info) => {
    dir = mkdtempSync(join(tmpdir(), "jumper-e2e-xiao-"));
    const home = mkdtempSync(join(tmpdir(), "jumper-e2e-home-"));
    const env = { ...process.env, JUMPER_HOME: home, JUMPER_AI_GATEWAY_PORT: "0" };
    const r = spawnSync(process.execPath, [CLI, "new", dir, "--template", "xiao-rp2040"], { encoding: "utf8", timeout: 60_000, env });
    expect(r.status, r.stderr).toBe(0);
    // The golden arduino-pico build of this template's sketch (no Docker in e2e).
    copyFileSync(TEMPLATE_HEX, join(dir, "firmware", "main.hex"));
    port = hubPort(info, 6);
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env });
    await expect
      .poll(async () => (await fetch(`http://localhost:${port}/api/project`).catch(() => undefined))?.status ?? 0, { timeout: 60_000 })
      .toBe(200);
  });

  test.afterEach(() => {
    hub?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs the firmware in the page: user LED blinks, serial says ready", async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.goto(`http://localhost:${port}/?local`);
    await expect(page.getByTestId("app")).toBeVisible();
    await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 30_000 });
    const xiao = page.getByTestId("part-xiao");
    await expect(xiao).toBeVisible();
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("sim-error")).toHaveCount(0);
    await expectAttrWithinSimTime(page, xiao, "data-state-led-r", /^(1|true)$/, 2000);
    await expectAttrWithinSimTime(page, xiao, "data-state-led-r", /^(0|false)$/, 2000);
    await shot(page, info, "rp2040-xiao");
    await openSerial(page);
    const consoleEl = page.getByTestId("serial-console");
    await expectWithinSimTime(page, 2000, async () => ((await consoleEl.textContent()) ?? "").includes("ready"), 'the serial console should print "ready"');
  });

  test("the followed page runs it in place: an agent's run starts the RP2040 here (live track)", async ({ page }, info) => {
    test.setTimeout(120_000);
    const base = `http://localhost:${port}`;
    await page.goto(`${base}/?follow=${encodeURIComponent(`ws://localhost:${port}/live`)}`);
    const xiao = page.getByTestId("part-xiao");
    await expect(xiao).toBeVisible({ timeout: 30_000 });
    // The agent runs the project over MCP (Streamable HTTP, like Claude Code): the page auto-runs it.
    let sid = "";
    const post = async (body: object) => {
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
      sid ||= r.headers.get("mcp-session-id") ?? "";
      return r.text();
    };
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "9.9.9" } } });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const out = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run", arguments: { ms: 200 } } });
    expect(out).not.toMatch(/"isError":true/);
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { jumper: { store: { getState(): { run: string } }; engine: { isLocalRun: boolean } } }).jumper.store.getState().run), { timeout: 30_000 })
      .toBe("running");
    expect(await page.evaluate(() => (window as unknown as { jumper: { engine: { isLocalRun: boolean } } }).jumper.engine.isLocalRun)).toBe(true);
    await expect(page.getByTestId("sim-error")).toHaveCount(0);
    await expectAttrWithinSimTime(page, xiao, "data-state-led-r", /^(1|true)$/, 2000);
    await expectAttrWithinSimTime(page, xiao, "data-state-led-r", /^(0|false)$/, 2000);
    await shot(page, info, "rp2040-xiao-follow");
    await fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } });
  });
});
