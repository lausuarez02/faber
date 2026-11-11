import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 8b: "What's making it bigger" in the Case view's Layout tab, on the talking egg a real
// Claude rebuilt on round-8 code (74 x 96 x 44.4 mm: a 6 mm dome on both faces, the eyes and the
// speaker pinned on the front, a fixed 74 x 96 mm size). Each choice says what it adds in plain
// words (no tool names) and Apply relaxes it. Real `jumper serve`, real layouts and CAD.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const EGG = readFileSync(fileURLToPath(new URL("../../../packages/enclosure/test/fixtures/talking-egg-round8.json", import.meta.url)), "utf8");

async function serve(info: TestInfo): Promise<{ url: string; dir: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "jumper-e2e-costs-"));
  const dir = join(root, "egg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jumper.json"), EGG);
  const port = hubPort(info, 14);
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

const saved = (dir: string) => JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8"));

test("Case view, Layout: what's making it bigger, in plain words, and Apply relaxes the dome", async ({ page }, info) => {
  // (desktop only: the same panel on a phone is the Layout tab's, covered by case-layout)
  test.skip(info.project.name !== "desktop", "desktop only");
  test.setTimeout(720_000);
  const s = await serve(info);
  try {
    await page.goto(`${s.url}/`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    const home = page.getByTestId("projects-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await home.getByTestId("projects-close").click();
    await page.getByTestId("toggle-case").click();
    await expect(page.getByTestId("case-view")).toBeVisible();
    await expect(page.getByTestId("case-size")).toContainText(/74 × 96 × [\d.]+ mm/, { timeout: 240_000 });
    const before = Number(/74 × 96 × ([\d.]+) mm/.exec((await page.getByTestId("case-size").textContent()) ?? "")![1]);

    await page.getByTestId("case-tab-layout").click();
    const costs = page.getByTestId("case-costs");
    await expect(costs).toBeVisible({ timeout: 90_000 });
    const dome = page.getByTestId("case-cost-dome");
    await expect(dome).toContainText(/A 6 mm dome on both faces adds [\d.]+ mm of thickness/, { timeout: 90_000 });
    // people's words: no tool names, no setting names
    await expect(costs).not.toContainText(/update_case|design_case|dome_mm|placements|size_mm/);
    await shot(page, info, "case-costs");

    await dome.getByRole("button", { name: "Use a 1.5 mm dome" }).click();
    await expect.poll(() => saved(s.dir).enclosure.params.dome_mm, { timeout: 240_000 }).toBe(1.5);
    // the case is rebuilt thinner (same 74 x 96 mm outline)
    await expect
      .poll(async () => Number(/74 × 96 × ([\d.]+) mm/.exec((await page.getByTestId("case-size").textContent()) ?? "")?.[1] ?? before), { timeout: 400_000 })
      .toBeLessThan(before - 5); // (real CAD of a domed egg: 1 to 2 minutes alone, more next to other specs)
    await shot(page, info, "case-costs-applied");
  } finally {
    await s.close();
  }
});
