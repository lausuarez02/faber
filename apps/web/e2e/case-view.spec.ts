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
    await openCase(page, info);
    await expect(page.getByTestId("case-empty")).toContainText("No case yet");
    await page.getByTestId("case-shape-rounded-box").click();
    await page.getByTestId("case-update").click();
    await expect(page.getByTestId("case-size")).toContainText(/\d+(\.\d)? × \d+(\.\d)? × \d+(\.\d)? mm/, { timeout: 120_000 });
    await expect(page.getByTestId("case-pocket")).toHaveText(/fits a pocket|tight for a pocket/);
    await expect(page.getByTestId("case-view").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("case-checks")).toContainText("watertight");
    await expect(page.getByTestId("case-checks")).toContainText("no-intersection");
    await expect(page.getByTestId("case-update")).toHaveText("Case is up to date");
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
    await expect(page.getByTestId("case-pack-result")).toContainText(/Missing firmware\/: the project has no firmware\. Fix: .*build/);
    await page.getByTestId("case-close").click();
    await expect(page.getByTestId("case-view")).toHaveCount(0);
  } finally {
    await s.close();
  }
});
