import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 12: the Case view's Build tab, against a real `jumper serve` on a temp copy of the Muse with
// a rounded-box case (built on open, real CAD): how it goes together step by step with a picture each,
// what to buy and what to print, and the assembly checks in plain words.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const MUSE = JSON.stringify({ ...JSON.parse(readFileSync(fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse/jumper.json", import.meta.url)), "utf8")), enclosure: { shape: "rounded-box" } });

async function serve(info: TestInfo): Promise<{ url: string; dir: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "jumper-e2e-assembly-"));
  const dir = join(root, "muse");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jumper.json"), MUSE);
  const port = hubPort(info, 16);
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
        // (a server busy in CAD may not get to SIGTERM: do not leave it running into the next specs)
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function openCase(page: Page, info: TestInfo): Promise<void> {
  if (info.project.name === "mobile") {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-case").click();
  } else await page.getByTestId("toggle-case").click();
  await expect(page.getByTestId("case-view")).toBeVisible();
}

test("Case view, Build: the steps with a picture each, what to buy and print, the assembly checks", async ({ page }, info) => {
  test.setTimeout(300_000);
  const s = await serve(info);
  try {
    await page.goto(`${s.url}/`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    const home = page.getByTestId("projects-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await home.getByTestId("projects-close").click();
    await openCase(page, info);
    // the case is built on open (real CAD)
    await expect(page.getByTestId("case-size")).toContainText(/\d+(\.\d)? × \d+(\.\d)? × \d+(\.\d)? mm/, { timeout: 180_000 });
    await page.getByTestId("case-tab-build").click();
    await expect(page.getByTestId("case-tab-build")).toHaveAttribute("aria-selected", "true");
    const asm = page.getByTestId("case-assembly");
    await expect(asm.getByTestId("case-assembly-step")).toBeVisible({ timeout: 120_000 });
    // step 1 of N, with its picture (loaded from the server, not broken)
    await expect(asm.getByText(/^Step 1 of \d+$/)).toBeVisible();
    await expect(asm.getByTestId("case-assembly-title")).toHaveText("Check the printed parts");
    const img = asm.getByTestId("case-assembly-image");
    await expect(img).toBeVisible();
    await expect.poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 20_000 }).toBeGreaterThan(100);
    // walk forward: the flash step comes before any part goes in
    await asm.getByTestId("case-assembly-next").click();
    await expect(asm.getByTestId("case-assembly-title")).toHaveText("Flash the firmware");
    await asm.getByTestId("case-assembly-next").click();
    await asm.getByTestId("case-assembly-next").click();
    await expect(asm.getByTestId("case-assembly-title")).toHaveText(/^(Put|Press|Slide) .* into the (front|back) shell$/);
    await expect.poll(async () => asm.getByTestId("case-assembly-image").evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 20_000 }).toBeGreaterThan(100);
    await shot(page, info, "case-assembly-step");
    await asm.getByTestId("case-assembly-prev").click();
    await expect(asm.getByText(/^Step 3 of \d+$/)).toBeVisible();
    // what to buy and what to print
    await asm.getByTestId("case-assembly-buy").locator("summary").click();
    await expect(asm.getByTestId("case-assembly-buy")).toContainText(/Seeed XIAO RP2040/);
    await expect(asm.getByTestId("case-assembly-buy")).toContainText(/Kapton/);
    await asm.getByTestId("case-assembly-print").locator("summary").click();
    await expect(asm.getByTestId("case-assembly-print")).toContainText(/front\.stl \(front face on the bed, no supports\)/);
    // the checks: either all fine, or each thing to know in words
    await expect(asm.getByTestId("case-assembly-problems").or(asm.getByTestId("case-assembly-ok"))).toBeVisible();
    await shot(page, info, "case-assembly-buy");
    // no horizontal scroll in the panel on a phone
    if (info.project.name === "mobile") {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over).toBeLessThanOrEqual(1);
    }
  } finally {
    await s.close();
  }
});
