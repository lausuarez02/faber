// Round 10 (network): the Network panel for the device network, served by `fabwright serve`. A
// project in mock mode with one mocked HTTPS API and a secret by name: the panel shows the mode and
// the secret (set on this machine, never its value); "Try" makes a request from inside the sandbox
// (sandbox DNS + TLS with the sandbox CA), which shows as a request row; "Drop Wi-Fi" makes the
// next one fail with why and fix, and the refusal shows as a BLOCKED row; "Clear faults" restores it.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../cli/bin/fabwright.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/net-panel/", import.meta.url));
const SECRET = "wk-e2e-not-a-real-key-0123456789";

test.describe("device network panel from fabwright serve", () => {
  let dir = "";
  let home = "";
  let hub: ChildProcess | undefined;
  let port = 0;

  test.beforeEach(async ({}, info) => {
    dir = mkdtempSync(join(tmpdir(), "fabwright-e2e-net-"));
    home = mkdtempSync(join(tmpdir(), "fabwright-e2e-home-"));
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(join(dir, ".env"), `WEATHER_KEY=${SECRET}\n`);
    const env = { ...process.env, FABWRIGHT_HOME: home, FABWRIGHT_AI_GATEWAY_PORT: "0", FABWRIGHT_SANDBOX_CA_DIR: join(home, "sandbox-ca") };
    port = hubPort(info, 14);
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    hub.stdout?.on("data", (b: Buffer) => void (out += b.toString()));
    hub.stderr?.on("data", (b: Buffer) => void (out += b.toString()));
    hub.once("exit", (code) => {
      if (code) console.log(`fabwright serve exited ${code}:\n${out.slice(-2000)}`);
    });
    await expect.poll(async () => (await fetch(`http://localhost:${port}/?local`).catch(() => undefined))?.status ?? 0, { timeout: 60_000 }).toBe(200);
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
    rmSync(home, { recursive: true, force: true });
  });

  test("shows requests, faults and secrets by name; Try goes through the sandbox", async ({ page, isMobile }, info) => {
    test.setTimeout(90_000);
    await page.goto(`http://localhost:${port}/?local`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    if (isMobile) {
      await page.getByTestId("phone-menu").click();
      await page.getByTestId("phone-network").click();
    } else {
      await page.getByTestId("rail-network").click();
    }
    const panel = page.getByTestId("panel-device-network");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("devnet-mode")).toContainText("mock", { timeout: 20_000 });
    await expect(panel).toContainText("WEATHER_KEY");
    await expect(panel).toContainText("set on this machine");

    await panel.getByTestId("devnet-url").fill("https://api.weather.test/v1/now");
    await panel.getByTestId("devnet-try").click();
    await expect(panel.getByTestId("devnet-tried")).toContainText("200", { timeout: 20_000 });
    await expect(panel.getByTestId("devnet-tried")).toContainText("temp_c");
    const list = panel.getByTestId("devnet-list");
    await expect(list.locator('[data-kind="GET"]').first()).toContainText("api.weather.test/v1/now");
    await expect(list.locator('[data-kind="GET"]').first()).toContainText("200");
    await expect(list.locator('[data-kind="GET"]').first()).toContainText("TLS (sandbox CA)");
    await expect(list.locator('[data-kind="DNS"]').first()).toContainText("api.weather.test");
    await shot(page, info, "network-panel-request");

    await panel.getByTestId("devnet-drop").click();
    await expect(panel.getByTestId("devnet-wifi")).toContainText("Wi-Fi dropped", { timeout: 10_000 });
    await panel.getByTestId("devnet-try").click();
    await expect(panel.getByTestId("devnet-tried")).toContainText("Why:", { timeout: 20_000 });
    await expect(panel.getByTestId("devnet-tried")).toContainText("Fix:");
    const blocked = list.locator('[data-kind="BLOCKED"]').first();
    await expect(blocked).toContainText("Why: Wi-Fi is down");
    await expect(blocked).toContainText("Fix:");
    await shot(page, info, "network-panel-wifi-drop");

    await panel.getByTestId("devnet-clear").click();
    await expect(panel.getByTestId("devnet-wifi")).not.toContainText("dropped", { timeout: 10_000 });
    await panel.getByTestId("devnet-try").click();
    await expect(panel.getByTestId("devnet-tried")).toContainText("200", { timeout: 20_000 });

    // The secret value never reaches the page (names only).
    expect(await page.content()).not.toContain(SECRET);
    const api = await (await fetch(`http://localhost:${port}/api/network`)).text();
    expect(api).not.toContain(SECRET);
  });
});
