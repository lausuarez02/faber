import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 12, kit track: the Build it panel against a real `jumper serve` on a temp copy of the pocket
// Muse (its case, renders and firmware are in the example): buy, print, assemble, flash, ticks that
// survive a reload, and the zip / PDF / page downloads.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse", import.meta.url));

async function serve(info: TestInfo): Promise<{ url: string; dir: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "jumper-e2e-kit-"));
  const dir = join(root, "muse");
  cpSync(MUSE, dir, { recursive: true });
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "firmware", "main.hex"), later, later);
  const port = hubPort(info, 1);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JUMPER_HOME: join(root, "home"), JUMPER_SLICER: "none" } });
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
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function openApp(page: Page, url: string) {
  await page.goto(`${url}/`);
  await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
  await closeHome(page);
}

/** A new browser (and a reload) lands on the Projects page: wait for it and go back to the project. */
async function closeHome(page: Page) {
  const home = page.getByTestId("projects-home");
  const shown = await home.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
  if (shown) {
    await home.getByTestId("projects-close").click();
    await expect(home).toHaveCount(0);
  }
}

async function openKit(page: Page, info: TestInfo) {
  if (info.project.name === "mobile") {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-build-it").click();
  } else {
    await page.getByTestId("project-menu").click();
    await page.getByTestId("menu-build-it").click();
  }
  await expect(page.getByTestId("kit-view")).toBeVisible();
  await expect(page.getByTestId("kit-summary")).toContainText("Pocket Muse", { timeout: 60_000 });
}

test("Build it: buy, print, assemble, flash; ticks are remembered; zip, PDF and page download", async ({ page }, info) => {
  test.setTimeout(180_000);
  const s = await serve(info);
  try {
    await openApp(page, s.url);
    await openKit(page, info);
    const view = page.getByTestId("kit-view");
    // no horizontal scroll at phone width
    expect(await view.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Buy: every part, totals, links, the things people forget, the tools
    const lines = page.getByTestId("kit-buy-line");
    expect(await lines.count()).toBeGreaterThanOrEqual(15);
    await expect(view).toContainText("JST-PH 2.0 mm socket");
    await expect(view).toContainText("USB-C cable that carries data");
    await expect(page.getByTestId("kit-tools")).toContainText("Soldering iron");
    const total = page.getByTestId("kit-total-to-buy");
    const before = await total.textContent();
    expect(before).toMatch(/^\$\d+\.\d\d$/);
    await shot(page, info, "kit-buy");
    await lines.first().getByTestId("kit-tick").check();
    await expect(total).not.toHaveText(before!);
    const after = await total.textContent();
    // Print: the three bodies with grams and time, the print-service notes
    await page.getByTestId("kit-tab-print").click();
    await expect(page.getByTestId("kit-print-item")).toHaveCount(3);
    await expect(page.getByTestId("kit-print-item").first()).toContainText(/\d+(\.\d)? g/);
    await expect(page.getByTestId("kit-print-service")).toContainText("JLC3DP");
    await shot(page, info, "kit-print");
    // Assemble: steps with pictures, wires with cut lengths, checks, troubleshooting
    await page.getByTestId("kit-tab-assemble").click();
    const steps = page.getByTestId("kit-step");
    expect(await steps.count()).toBeGreaterThanOrEqual(8);
    await expect(view).toContainText("Put the parts in the case");
    await expect(view).toContainText(/w1 .* mm, 24 AWG/);
    const img = view.locator(".kv-step-img").first();
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("kit-trouble")).toContainText("If something does not work");
    await shot(page, info, "kit-assemble");
    // Flash: drag and drop for the XIAO RP2040
    await page.getByTestId("kit-tab-flash").click();
    await expect(page.getByTestId("kit-flash")).toContainText("RPI-RP2");
    await expect(page.getByTestId("kit-flash")).toContainText("firmware/firmware.uf2");
    await shot(page, info, "kit-flash");
    // people read this: no tool names anywhere in the panel
    const text = (await view.innerText()).toLowerCase();
    for (const t of ["get_build_kit", "design_case", "update_case", "export_manufacturing", "check_design", "place_part"]) expect(text, t).not.toContain(t);
    // ticks survive a reload (this browser only)
    await page.reload();
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    await closeHome(page);
    await openKit(page, info);
    await expect(page.getByTestId("kit-total-to-buy")).toHaveText(after!);
    await expect(page.getByTestId("kit-buy-line").first().getByTestId("kit-tick")).toBeChecked();
    // downloads: the zip, the PDF, the page
    const [zip] = await Promise.all([page.waitForEvent("download", { timeout: 90_000 }), page.getByTestId("kit-download-zip").click()]);
    expect(zip.suggestedFilename()).toBe("pocket-muse-kit.zip");
    const [pdf] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.getByTestId("kit-download-pdf").click()]);
    expect(pdf.suggestedFilename()).toBe("kit.pdf");
    const [tab] = await Promise.all([page.context().waitForEvent("page"), page.getByTestId("kit-download-html").click()]);
    await tab.waitForLoadState();
    await expect(tab.locator("h1")).toContainText("Build it yourself: Pocket Muse");
    await tab.close();
    const kitDir = join(s.dir, "build-kit", "pocket-muse-kit");
    for (const f of ["kit.html", "kit.pdf", "KIT.md", "SHOPPING.csv", "case/stl/front.stl", "firmware/firmware.uf2"]) expect(existsSync(join(kitDir, f)), f).toBe(true);
    expect(statSync(join(kitDir, "kit.pdf")).size).toBeGreaterThan(10_000);
    await page.getByTestId("kit-close").click();
    await expect(page.getByTestId("kit-view")).toHaveCount(0);
  } finally {
    await s.close();
  }
});

test("Build it opens from the Case view", async ({ page }, info) => {
  test.setTimeout(120_000);
  const s = await serve(info);
  try {
    await openApp(page, s.url);
    if (info.project.name === "mobile") {
      await page.getByTestId("phone-menu").click();
      await page.getByTestId("phone-case").click();
    } else await page.getByTestId("toggle-case").click();
    await expect(page.getByTestId("case-view")).toBeVisible();
    const btn = page.getByTestId("case-build-it");
    await expect(btn).toBeVisible({ timeout: 60_000 });
    await btn.click();
    await expect(page.getByTestId("kit-view")).toBeVisible();
    await expect(page.getByTestId("kit-summary")).toContainText("Pocket Muse", { timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("kit-view")).toHaveCount(0);
  } finally {
    await s.close();
  }
});
