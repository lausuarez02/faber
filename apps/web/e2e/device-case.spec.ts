import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// The Device view shows the project's own designed case (not the generic handheld) when the Case
// view built one: a real `faber serve` (it serves the page, so GET /api/device/case answers) on a
// temp copy of the agent-built Pocket Muse, whose pebble case is committed in case/. The first
// open tessellates the case once (CAD on the server); then it is cached.
const CLI = fileURLToPath(new URL("../../cli/bin/faber.mjs", import.meta.url));
const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse/", import.meta.url));

async function serve(info: TestInfo): Promise<{ url: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "faber-e2e-device-case-"));
  const dir = join(root, "muse");
  cpSync(MUSE, dir, { recursive: true });
  // the committed hex is newer than the sketch, so Run needs no build (no Docker)
  const t = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "firmware", "main.hex"), t, t);
  const port = hubPort(info, 15);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FABER_HOME: join(root, "home"), FABER_CASE_PDF: "0" } });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`faber serve did not start in 40 s:\n${log}`)), 40_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes("MCP:")) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`faber serve exited with ${code}:\n${log}`)));
  });
  return {
    url: `http://localhost:${port}`,
    async close() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once("exit", r));
        proc.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 820;

async function openDevice(page: Page): Promise<void> {
  if (isPhone(page)) {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-device").click();
  } else await page.getByTestId("toggle-device").click();
  await expect(page.getByTestId("device-view")).toBeVisible();
}

type W = { faber: { engine: { simulation?: { partState(id: string): Record<string, unknown> | undefined } } } };
const pressed = (page: Page, id: string) => page.evaluate((id) => (window as unknown as W).faber.engine.simulation?.partState(id)?.pressed === true, id);

test("Device view: a project with a designed case is shown as that case, buttons pressable at their caps", async ({ page }, info) => {
  test.setTimeout(240_000);
  const s = await serve(info);
  try {
    await page.goto(`${s.url}/`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    const home = page.getByTestId("projects-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await home.getByTestId("projects-close").click();
    await expect(home).toHaveCount(0);
    await openDevice(page);
    const stage = page.getByTestId("device-stage");
    // the first open tessellates the case: a loading note, not the generic handheld
    await expect(page.getByTestId("device-case-loading").or(stage.and(page.locator("[data-kind=case]")))).toBeVisible({ timeout: 10_000 });
    await expect(stage).toHaveAttribute("data-case", "current", { timeout: 150_000 });
    await expect(stage).toHaveAttribute("data-kind", "case");
    await expect(page.getByTestId("device-case-loading")).toHaveCount(0);
    if (!isPhone(page)) await expect(page.getByTestId("device-why")).toHaveText("Pebble case from the Case view · TFT + 1 button");
    await expect(page.getByTestId("device-case-note")).toHaveCount(0); // up to date, a case: nothing to say
    await expect(page.getByTestId("device-finish-design")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(800);
    await shot(page, info, "device-case-before-run");

    await page.getByTestId("device-run").click();
    await expect(page.getByTestId("device-run")).toHaveText(/Pause/, { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => !!(window as unknown as W).faber.engine.simulation), { timeout: 20_000 }).toBe(true);
    // key 1 is the case's one button (pet), pressed while held
    await page.keyboard.down("1");
    await expect.poll(() => pressed(page, "pet"), { timeout: 5_000 }).toBe(true);
    await shot(page, info, "device-case-pressed");
    await page.keyboard.up("1");
    await expect.poll(() => pressed(page, "pet"), { timeout: 5_000 }).toBe(false);
    // a finish chip recolours the case; the designed colour comes back
    await page.getByRole("button", { name: "Graphite case" }).click();
    await expect(page.getByRole("button", { name: "Graphite case" })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("device-finish-design").click();
    await expect(page.getByTestId("device-finish-design")).toHaveAttribute("aria-pressed", "true");

    // reopening shows the cached case at once
    await page.getByTestId("device-close").click();
    await expect(page.getByTestId("device-view")).toHaveCount(0);
    await openDevice(page);
    await expect(page.getByTestId("device-stage")).toHaveAttribute("data-kind", "case", { timeout: 2_000 });
  } finally {
    await s.close();
  }
});

test("Device view: without a case the generic handheld stays, and says how to get one", async ({ page }, info) => {
  await page.goto("/?example=tamagotchi");
  await expect(page.getByTestId("app")).toBeVisible();
  await openDevice(page);
  const stage = page.getByTestId("device-stage");
  await expect(stage).toHaveAttribute("data-kind", "handheld");
  await expect(stage).toHaveAttribute("data-case", "none");
  await expect(page.getByTestId("device-case-note")).toContainText("No case yet - design one in the Case view");
  await shot(page, info, "device-no-case");
  await page.getByTestId("device-open-case").click();
  await expect(page.getByTestId("device-view")).toHaveCount(0);
  await expect(page.getByTestId("case-view")).toBeVisible();
});
