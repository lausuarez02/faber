import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 6, case track (decision 0004, R6): the Case view against a real `jumper serve` (the page is
// served by it, so it has the token) on a temp copy of the Muse. Real CAD runs on the server.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const MUSE = readFileSync(fileURLToPath(new URL("../../../packages/enclosure/test/fixtures/pocket-muse.json", import.meta.url)), "utf8");

async function serve(info: TestInfo): Promise<{ url: string; dir: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "jumper-e2e-case-"));
  const dir = join(root, "muse");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jumper.json"), MUSE);
  const port = hubPort(info, 1);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JUMPER_HOME: join(root, "home"), JUMPER_CASE_PDF: "0" } });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`jumper serve did not start in 40 s:\n${log}`)), 40_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes("MCP:")) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`jumper serve exited with ${code}:\n${log}`)));
  });
  return {
    url: `http://localhost:${port}`,
    dir,
    async close() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once("exit", r));
        proc.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A fresh JUMPER_HOME lands on the Projects page (round 6 switch): go back to the canvas. */
async function dismissProjectsHome(page: Page): Promise<void> {
  const home = page.getByTestId("projects-home");
  try {
    await home.waitFor({ state: "visible", timeout: 6000 });
  } catch {
    return;
  }
  await home.getByTestId("projects-close").click();
  await expect(home).toHaveCount(0);
}

async function openCase(page: Page, info: TestInfo): Promise<void> {
  if (info.project.name === "mobile") {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-case").click();
  } else await page.getByTestId("toggle-case").click();
  await expect(page.getByTestId("case-view")).toBeVisible();
}

test("Case view: design a case, see it in 3D, read the checks, download the files and the factory pack", async ({ page }, info) => {
  test.setTimeout(180_000);
  const s = await serve(info);
  try {
    await page.goto(`${s.url}/`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    await dismissProjectsHome(page);
    if (info.project.name !== "mobile") {
      // the top toolbar's icons say what they are at once on hover
      await page.getByTestId("toggle-case").hover();
      await expect(page.getByTestId("toggle-case")).toHaveAttribute("data-tip", /Case/);
      await expect.poll(() => page.getByTestId("toggle-case").evaluate((el) => getComputedStyle(el, "::after").opacity), { timeout: 3000 }).toBe("1");
    }
    await openCase(page, info);
    await expect(page.getByTestId("case-empty")).toContainText("No case yet");
    // readable on the dark stage
    const titleColor = await page.locator(".cv-empty-title").evaluate((el) => getComputedStyle(el).color);
    expect(titleColor).toBe("rgb(241, 243, 245)");
    await page.getByTestId("case-shape-rounded-box").click();
    await page.getByTestId("case-update").click();
    await expect(page.getByTestId("case-update")).toHaveText("Designing…");
    await expect(page.getByTestId("case-size")).toContainText(/\d+(\.\d)? × \d+(\.\d)? × \d+(\.\d)? mm/, { timeout: 120_000 });
    await expect(page.getByTestId("case-pocket")).toHaveText(/fits a pocket|tight for a pocket|bulky for a pocket/);
    await expect(page.getByTestId("case-view").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("case-checks")).toContainText("watertight");
    await expect(page.getByTestId("case-checks")).toContainText("no-intersection");
    await expect(page.getByTestId("case-update")).toHaveText("Case is up to date");
    // Round 6b: the person's own Design case is never an agent step waiting for Accept / Reject.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("live-steps").filter({ hasText: "pending" })).toHaveCount(0);
    await expect(page.getByText("design_case")).toHaveCount(0);
    // jumper.json now holds the case
    expect(JSON.parse(readFileSync(join(s.dir, "jumper.json"), "utf8")).enclosure.shape).toBe("rounded-box");
    await page.getByTestId("case-explode").fill("0.8");
    await shot(page, info, "case-view");
    // downloads
    const stl = page.getByTestId("case-download-front.stl");
    await expect(stl).toHaveAttribute("href", "/api/case/file?path=stl%2Ffront.stl");
    const r = await page.request.get(`${s.url}/api/case/file?path=stl%2Ffront.stl`);
    expect(r.status()).toBe(200);
    expect((await r.body()).length).toBeGreaterThan(10_000);
    // a change makes the button live again
    await page.getByTestId("case-shape-puck").click();
    await expect(page.getByTestId("case-update")).toHaveText("Update case");
    // factory pack (no firmware in the fixture: the result says so and how to fix it)
    const dl = page.waitForEvent("download");
    await page.getByTestId("case-pack").click();
    expect((await dl).suggestedFilename()).toMatch(/^pocket-muse-v\d+\.zip$/);
    await expect(page.getByTestId("case-pack-result")).toContainText(/Missing firmware\/: the project has no firmware\. To fix it: write the sketch in the code panel and press Build/);
    await expect(page.getByTestId("case-pack-result")).not.toContainText("export_manufacturing");
    // Update case says "Updating…" until the new case is there (never "up to date" mid-run)
    await page.getByTestId("case-update").click();
    await expect(page.getByTestId("case-update")).toHaveText("Updating…");
    await expect(page.getByTestId("case-update")).toHaveText("Case is up to date", { timeout: 120_000 });
    await expect(page.getByTestId("case-size")).toContainText(/× \d+(\.\d)? mm/);
    // "Other shapes made" lists the other shapes, not the one the case is now (puck)
    for (const [shape, size] of [["puck", { w: 63.1, h: 55.2, d: 32 }], ["pebble", { w: 70.7, h: 94.3, d: 19.6 }]] as const) {
      mkdirSync(join(s.dir, "case", "variants", shape), { recursive: true });
      writeFileSync(join(s.dir, "case", "variants", shape, "report.json"), JSON.stringify({ shape, size_mm: size, pocket: "tight", ok: true, files: [{ path: "stl/front.stl" }] }));
    }
    await expect(page.getByTestId("case-variant-pebble")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("case-variant-puck")).toHaveCount(0);
    // the close button stays at the top of the panel when it scrolls
    await page.locator(".cv-panel").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByTestId("case-close")).toBeInViewport();
    await page.getByTestId("case-close").click();
    await expect(page.getByTestId("case-view")).toHaveCount(0);
  } finally {
    await s.close();
  }
});
