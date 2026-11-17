import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 7, track shape: a person draws the case outline in the Case view (any shape, any size),
// sees where the parts go inside it as they edit (red where one runs into the wall), types a size
// that is too small, reads what misses and what would fit, takes the size that fits and designs
// it. Against a real `faber serve` on a temp copy of the Muse (real CAD on the server).
const CLI = fileURLToPath(new URL("../../cli/bin/faber.mjs", import.meta.url));
const MUSE = readFileSync(fileURLToPath(new URL("../../../packages/enclosure/test/fixtures/pocket-muse.json", import.meta.url)), "utf8");

async function serve(info: TestInfo): Promise<{ url: string; dir: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "faber-e2e-outline-"));
  const dir = join(root, "muse");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "faber.json"), MUSE);
  const port = hubPort(info, 7);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FABER_HOME: join(root, "home"), FABER_CASE_PDF: "0" } });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`faber serve did not start in 40 s:\n${log}`)), 40_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes("MCP:")) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`faber serve exited with ${code}:\n${log}`)));
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

const label = (page: Page, i: number) => page.getByTestId(`case-pt-${i}`).getAttribute("aria-label");

test("Case view: draw a custom outline, see the fit as you edit, type a size, take what fits and design it", async ({ page }, info) => {
  test.setTimeout(420_000);
  const s = await serve(info);
  try {
    await page.goto(`${s.url}/`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    const home = page.getByTestId("projects-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await home.getByTestId("projects-close").click();
    await openCase(page, info);

    // Custom: the outline editor, started from an ellipse; the parts' fit is checked as you go (auto size)
    await page.getByTestId("case-shape-custom").click();
    await expect(page.getByTestId("case-outline")).toBeVisible();
    await page.getByTestId("case-start-ellipse").click();
    const status = page.getByTestId("case-fit-status");
    await expect(status).toContainText(/Fits: [\d.]+ × [\d.]+ × [\d.]+ mm \(auto/, { timeout: 30_000 });
    await expect(page.getByTestId("case-fit-preview")).toBeVisible();
    await expect(page.locator('[data-testid^="case-fit-part-"]')).not.toHaveCount(0);
    await shot(page, info, "outline-auto");

    // drag the top point up: the drawing changes and the fit is checked again
    const before = await label(page, 0);
    const pt = page.getByTestId("case-pt-0");
    await pt.scrollIntoViewIfNeeded();
    const box = (await pt.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 18, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => label(page, 0)).not.toBe(before);
    await expect(status).toContainText(/Fits/, { timeout: 30_000 });

    // keyboard: a point moves 1 mm per arrow press
    const p1 = page.getByTestId("case-pt-1");
    await p1.focus();
    const x0 = Number(/x (-?[\d.]+) mm/.exec((await label(page, 1))!)![1]);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Number(/x (-?[\d.]+) mm/.exec((await label(page, 1))!)![1])).not.toBe(x0);
    // add and remove a point with the buttons
    const n0 = await page.locator('[data-testid^="case-pt-"][role="button"]').count();
    await page.getByTestId("case-pt-add").click();
    await expect(page.locator('[data-testid^="case-pt-"][role="button"]')).toHaveCount(n0 + 1);
    await page.getByTestId("case-pt-remove").click();
    await expect(page.locator('[data-testid^="case-pt-"][role="button"]')).toHaveCount(n0);

    // a size that is too small: what misses, in red, and what would fit
    await page.getByTestId("case-size-w").fill("40");
    await page.getByTestId("case-size-h").fill("52");
    await expect(status).toContainText(/Does not fit 40 × 52 × auto mm: the parts need [\d.]+ × [\d.]+ × [\d.]+ mm/, { timeout: 30_000 });
    await expect(page.getByTestId("case-fit-misses").locator("li").first()).toContainText(/sticks out [\d.]+ mm/);
    await expect(page.locator('[data-testid^="case-fit-part-"][data-collides="1"]').first()).toBeAttached();
    await expect(page.getByTestId("case-fit-suggestions")).toContainText(/Or make it [\d.]+ mm wider/);
    await shot(page, info, "outline-too-small");

    // take the size that holds every part; it fits, then design it (real CAD on the server)
    await page.getByTestId("case-fit-use-size").click();
    await expect(status).toContainText(/^Fits: /, { timeout: 30_000 });
    const w = Number(await page.getByTestId("case-size-w").inputValue());
    const h = Number(await page.getByTestId("case-size-h").inputValue());
    expect(w).toBeGreaterThan(40);
    expect(h).toBeGreaterThan(52);
    await page.getByTestId("case-update").click();
    await expect(page.getByTestId("case-size")).toContainText(new RegExp(`^${w} × ${h} × [\\d.]+ mm`), { timeout: 360_000 });
    await expect(page.getByTestId("case-checks")).toContainText("watertight");
    await expect(page.getByTestId("case-update")).toHaveText("Case is up to date", { timeout: 60_000 }); // (after the mesh of the new case loads)
    const saved = JSON.parse(readFileSync(join(s.dir, "faber.json"), "utf8"));
    expect(saved.enclosure.shape).toBe("custom");
    expect(saved.enclosure.size_mm).toEqual({ w, h });
    expect(saved.enclosure.outline.smooth).toBe(true);
    expect(saved.enclosure.outline.points.length).toBe(n0);
    await shot(page, info, "outline-designed");
  } finally {
    await s.close();
  }
});
