import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 6, switch track (decision 0004, R8): someone new lands on the Projects page; opening another
// project resets everything the old one left (sim, firmware, code card, toasts, captions); the
// person's own edits are never agent steps; History starts at the example as it came and counts
// file lines after a restore. Against a real `jumper serve` on a temp projects folder, no Docker.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));

interface Served {
  url: string;
  root: string;
  proc: ChildProcess;
  close(): Promise<void>;
}

async function serve(info: TestInfo): Promise<Served> {
  const root = mkdtempSync(join(tmpdir(), "jumper-e2e-switch-"));
  mkdirSync(join(root, "projects", "playground"), { recursive: true });
  const port = hubPort(info, 8);
  const proc = spawn(process.execPath, [CLI, "serve", "--project", join(root, "projects", "playground"), "--port", String(port), "--strict-port", "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, JUMPER_HOME: join(root, "home"), JUMPER_AI_GATEWAY_PORT: "0" },
  });
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
    root,
    proc,
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

const runState = (page: Page) => page.getByTestId("sim-time");

async function openExample(page: Page, name: string): Promise<void> {
  const home = page.getByTestId("projects-home");
  if (!(await home.isVisible())) await page.getByTestId("open-projects").click();
  await home.getByTestId("examples-grid").locator(`[data-name="${name}"]`).click();
  await expect(home).toHaveCount(0);
}

/** Replace the open sketch's text in the code editor and save it (the person's own edit, actor "web"). */
async function editSketch(page: Page, file: string, edit: (text: string) => string): Promise<void> {
  const editor = page.getByTestId("code-editor");
  if (!(await editor.isVisible())) {
    if (!(await page.getByTestId("firmware-sketch").isVisible())) await page.getByTestId("rail-firmware").click();
    await page.getByTestId("firmware-sketch").click();
  }
  await expect(editor).toHaveAttribute("data-editable", "true");
  const content = editor.getByTestId("code-content");
  await expect(content).toContainText("setup");
  const text = readFileSync(file, "utf8");
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(edit(text));
  await editor.getByTestId("code-save").click();
  await expect(editor.getByTestId("code-save")).toBeDisabled({ timeout: 15_000 });
  await editor.getByTestId("code-close").click();
}

test.describe("switching projects (served)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("first screen, a switch resets the old project, own edits are not agent steps, History from the example as it came", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the switch flow is exercised once, on desktop");
    const s = await serve(info);
    try {
      // Someone new: the server's root lands on the Projects page with the pitch, not a canvas.
      await page.goto(`${s.url}/`);
      const home = page.getByTestId("projects-home");
      await expect(home).toBeVisible({ timeout: 30_000 });
      await expect(home).toContainText("Build and simulate Arduino circuits");
      // "1 test", not "1 tests".
      await expect(home.getByTestId("examples-grid").locator('[data-name="Pocket OLED (XIAO RP2040)"]')).toContainText(/1 test(?!s)/);
      await shot(page, info, "switch-first-screen");

      // Blink (an Uno): run it here.
      await openExample(page, "Blink");
      await expect(page.getByTestId("part-led1")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 20_000 });
      // The code card shows this project's sketch.
      await expect(page.getByTestId("live-code")).toContainText("blink", { timeout: 15_000 });
      await page.getByTestId("run-button").click();
      await expect(runState(page)).toHaveAttribute("data-run", "running", { timeout: 15_000 });

      // The person edits the sketch: it is a version, never a pending agent step.
      await editSketch(page, join(s.root, "projects", "blink", "firmware", "blink", "blink.ino"), (t) => t.replace("delay(1000);", "delay(250);"));
      const steps = page.getByTestId("live-steps");
      await expect(steps).toBeVisible();
      await expect(steps).not.toContainText("edited in the code editor");
      await expect(steps).not.toContainText("pending");
      await expect(page.getByTestId("agent-pill").or(page.getByTestId("agent-connect")).first()).not.toContainText("to review");
      await shot(page, info, "switch-own-edit-not-a-step");

      // Open the Pocket OLED (XIAO RP2040) while Blink runs: nothing of Blink comes along.
      await openExample(page, "Pocket OLED (XIAO RP2040)");
      await expect(page.getByTestId("part-xiao")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("part-led1")).toHaveCount(0);
      await expect(runState(page)).toHaveAttribute("data-run", "idle");
      await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 20_000 });
      await expect(page.getByTestId("sim-error")).toHaveCount(0);
      await expect(page.getByTestId("toast").filter({ hasText: /another board|AVR/ })).toHaveCount(0);
      await expect(page.getByTestId("toast")).toHaveText([/Opened Pocket OLED/]);
      await expect(page.getByTestId("live-caption")).toHaveCount(0);
      const card = page.getByTestId("live-code");
      await expect(card).toContainText("firmware/main.ino", { timeout: 15_000 });
      await expect(card).not.toContainText("blink");
      await shot(page, info, "switch-opened-pocket");

      // It runs on the RP2040 with its own firmware.
      await page.getByTestId("run-button").click();
      await expect(runState(page)).toHaveAttribute("data-run", "running", { timeout: 15_000 });
      await expect(page.getByTestId("sim-error")).toHaveCount(0);

      // History: version 1 is the example as it came; an edit counts its lines.
      await page.getByTestId("open-history").click();
      const view = page.getByTestId("history-view");
      await expect(view).toHaveAttribute("data-versions", "1", { timeout: 15_000 });
      await expect(page.getByTestId("history-details")).toContainText("opened the example Pocket OLED");
      await page.getByTestId("history-close").click();

      const sketch = join(s.root, "projects", "pocket-oled-xiao-rp2040", "firmware", "main.ino");
      const original = readFileSync(sketch, "utf8");
      await editSketch(page, sketch, (t) => t.replace(/frame/, "tick"));
      expect(readFileSync(sketch, "utf8")).not.toBe(original);
      await page.getByTestId("open-history").click();
      await expect(view).toHaveAttribute("data-versions", "2", { timeout: 15_000 });
      await expect(page.getByTestId("history-change-lines")).toHaveText("+1 −1");
      await expect(page.getByTestId("history-details")).toContainText("not built at this version");

      // Back to the example as it came: the restore says what it changed, the code card follows.
      await page.getByTestId("history-scrubber").fill("1");
      await expect(page.getByTestId("history-version-label")).toHaveText("Version 1 of 2");
      await page.getByTestId("history-restore").click();
      await page.getByTestId("history-restore-confirm").click();
      await expect(view).toHaveAttribute("data-versions", "3", { timeout: 15_000 });
      await expect(view).toHaveAttribute("data-version", "3");
      await expect(page.getByTestId("history-changes")).toContainText("firmware/main.ino");
      await expect(page.getByTestId("history-change-lines")).toHaveText("+1 −1");
      await shot(page, info, "switch-history-restore");
      expect(readFileSync(sketch, "utf8")).toBe(original);
      await page.getByTestId("history-close").click();
      await expect.poll(async () => (await card.textContent()) ?? "", { timeout: 15_000 }).toContain(original.split("\n").find((l) => /frame/.test(l))!.trim());
      // The restore is the person's own step too.
      await expect(page.getByTestId("live-steps")).not.toContainText("restore version");
    } finally {
      await s.close();
    }
  });
});
