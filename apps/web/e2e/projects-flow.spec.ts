import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 5, projects track (decision 0003, C3): the Projects home, opening an example as its own
// project, the History scrubber with restore, and the code editor's save / Build & Run, against a
// real `jumper serve` (web app served by it, so the page has the token) on a temp projects folder.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));

interface Served {
  url: string;
  root: string;
  home: string;
  proc: ChildProcess;
  close(): Promise<void>;
}

/**
 * One `jumper serve` per test on hubPort(info, 0): tests in a worker run one after another and each
 * waits for its server to exit, so the port is free for the next (and a run can stay in a narrow
 * port range, e.g. E2E_HUB_PORT_BASE=7834 --workers 1).
 */
async function serve(info: TestInfo): Promise<Served> {
  const root = mkdtempSync(join(tmpdir(), "jumper-e2e-projects-"));
  const home = join(root, "home");
  mkdirSync(join(root, "projects", "playground"), { recursive: true });
  const port = hubPort(info, 0);
  const proc = spawn(process.execPath, [CLI, "serve", "--project", join(root, "projects", "playground"), "--port", String(port), "--strict-port", "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, JUMPER_HOME: home },
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
    home,
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

function jumper(dir: string, home: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [CLI, ...args, "--project", dir], { encoding: "utf8", timeout: 60_000, env: { ...process.env, JUMPER_HOME: home } });
  if (r.status !== 0) throw new Error(`jumper ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Open the server's page and wait for the followed (empty) project. */
async function openServed(page: Page, s: Served): Promise<void> {
  await page.goto(`${s.url}/`);
  await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("app")).toHaveAttribute("data-live", "follow");
}

/** Open the Blink example from the empty state's cards; it becomes projects/blink-copy. */
async function openBlinkCopy(page: Page, s: Served): Promise<string> {
  const card = page.getByTestId("empty-state-examples").locator('[data-name="Blink"]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page.getByTestId("part-led1")).toBeVisible({ timeout: 20_000 });
  const dir = join(s.root, "projects", "blink");
  expect(existsSync(join(dir, "jumper.json"))).toBe(true);
  return dir;
}

test.describe("projects (served)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("Projects home: empty state with examples, an example opens as its own copy, the gallery lists both", async ({ page }, info) => {
    const s = await serve(info);
    try {
      await openServed(page, s);
      const empty = page.getByTestId("empty-state");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("Build and simulate Arduino circuits");
      await expect(empty).toContainText("to add a part");
      // Thumbnails are real renders of each example's canvas.
      const img = page.getByTestId("empty-state-examples").locator('[data-name="Blink"] img');
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(50);
      await shot(page, info, "projects-empty-state");

      const dir = await openBlinkCopy(page, s);
      await expect(page.getByTestId("project-subtitle")).toContainText("projects/blink");
      // The repo's example is untouched (the copy is in the temp projects folder).
      expect(JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")).name).toBe("Blink");

      await page.getByTestId("open-projects").click();
      const home = page.getByTestId("projects-home");
      await expect(home).toBeVisible();
      const yours = home.getByTestId("projects-grid");
      await expect(yours.locator('[data-name="Blink"]')).toHaveAttribute("data-active", "true");
      await expect(home.getByTestId("examples-grid").locator('[data-kind="example"]')).toHaveCount(6);
      // The RP2040 pocket example sits in the gallery with its board.
      await expect(home.getByTestId("examples-grid").locator('[data-name="Pocket OLED (XIAO RP2040)"]')).toContainText("Seeed XIAO RP2040");
      await expect(home.locator('[data-kind="agent-built"]').first()).toBeVisible();
      await expect(home.getByTestId("examples-grid").locator('[data-name="Blink"]')).toContainText("Arduino Uno");
      await shot(page, info, "projects-home");

      // A new blank project: its own folder, the canvas follows it (empty again).
      await home.getByTestId("projects-new").click();
      await expect(home).toHaveCount(0);
      await expect(page.getByTestId("empty-state")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("project-subtitle")).toContainText("projects/untitled-device");
      expect(existsSync(join(s.root, "projects", "untitled-device", "jumper.json"))).toBe(true);

      // Back to the Blink copy through its card.
      await page.getByTestId("empty-state-all").click();
      await expect(home.getByTestId("projects-grid").locator('[data-name="Untitled device"]')).toHaveAttribute("data-active", "true");
      await home.getByTestId("projects-grid").locator('[data-name="Blink"]').click();
      await expect(page.getByTestId("part-led1")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("project-subtitle")).toContainText("projects/blink");
    } finally {
      await s.close();
    }
  });

  test("History: every change is a version; scrub shows the canvas, what changed and who; restore brings it back", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the timeline is exercised once, on desktop");
    const s = await serve(info);
    try {
      await openServed(page, s);
      const dir = await openBlinkCopy(page, s);
      jumper(dir, s.home, "place", "buzzer", "--id", "buzzer1", "--x", "520", "--y", "-160", "--why", "beep on each blink");
      await expect(page.getByTestId("part-buzzer1")).toBeVisible({ timeout: 15_000 });
      jumper(dir, s.home, "connect", "uno.D8", "buzzer1.POS", "--why", "beep on each blink");
      jumper(dir, s.home, "set", "led1", "color", "green", "--why", "green is calmer");

      await page.getByTestId("open-history").click();
      const view = page.getByTestId("history-view");
      await expect(view).toHaveAttribute("data-versions", "3", { timeout: 15_000 });
      await expect(view).toHaveAttribute("data-version", "3");
      const details = page.getByTestId("history-details");
      await expect(details).toContainText("green is calmer");
      await expect(page.getByTestId("history-changes")).toContainText("led1");
      await expect(page.getByTestId("history-preview").locator("img")).toBeVisible();
      await shot(page, info, "history-latest");

      // Scrub back to version 1: the buzzer was just placed, not wired yet.
      await page.getByTestId("history-scrubber").fill("1");
      await expect(page.getByTestId("history-version-label")).toHaveText("Version 1 of 3");
      await expect(details).toContainText("beep on each blink");
      // Only what that change did (the copied example is the baseline, not "everything added").
      await expect(page.getByTestId("history-changes").locator("li")).toHaveCount(1);
      await expect(page.getByTestId("history-changes")).toContainText("buzzer1");
      await expect(details).toContainText("CLI");
      await shot(page, info, "history-scrubbed");

      // Restore version 1: a new version 4 at the end, the wire and the colour gone.
      await page.getByTestId("history-restore").click();
      await page.getByTestId("history-restore-confirm").click();
      await expect(view).toHaveAttribute("data-versions", "4", { timeout: 15_000 });
      await expect(view).toHaveAttribute("data-version", "4");
      await expect(details).toContainText("You");
      await page.getByTestId("history-close").click();
      await expect(page.locator('[data-testid^="wire-"]')).toHaveCount(3, { timeout: 15_000 });
      const project = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")) as { parts: { id: string; props?: { color?: string } }[] };
      expect(project.parts.find((p) => p.id === "led1")?.props?.color).toBe("red");
      expect(project.parts.map((p) => p.id)).toContain("buzzer1");
    } finally {
      await s.close();
    }
  });

  test("Code: the sketch opens in the editor, saves through write_file, and Build & Run shows errors at their line", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the editor is exercised once, on desktop");
    const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 });
    test.skip(docker.status !== 0, "Build & Run compiles with arduino-cli in Docker, and Docker is not running here");
    const s = await serve(info);
    try {
      await openServed(page, s);
      const dir = await openBlinkCopy(page, s);
      // The Firmware panel lists the sketch; clicking it opens the code.
      await page.getByTestId("rail-firmware").click();
      await page.getByTestId("firmware-sketch").click();
      const editor = page.getByTestId("code-editor");
      await expect(editor).toBeVisible();
      await expect(editor).toHaveAttribute("data-editable", "true");
      const content = editor.getByTestId("code-content");
      await expect(content).toContainText("digitalWrite");
      // Highlighted as C++ (stable tok-* classes from the highlighter).
      await expect(editor.locator('.cm-content [class^="tok-"]').first()).toBeVisible();
      await shot(page, info, "code-open");

      // A typo: Build & Run fails and marks the line.
      const sketch = join(dir, "firmware/blink/blink.ino");
      const good = readFileSync(sketch, "utf8");
      const broken = good.replace(/delay\(1000\);/, "delay(1000)");
      expect(broken).not.toBe(good);
      await content.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(broken);
      await expect(editor.getByTestId("code-save")).toBeEnabled();
      await editor.getByTestId("code-build").click();
      await expect(editor).toHaveAttribute("data-status", "failed", { timeout: 150_000 });
      expect(readFileSync(sketch, "utf8")).toBe(broken);
      await expect(editor.getByTestId("code-problems")).toContainText(/blink\.ino:\d+/);
      await expect(editor.locator(".cm-lintRange-error").first()).toBeVisible();
      await shot(page, info, "code-error");

      // Fixed: builds, runs on the server, and the action log has the person's edit as "web".
      await content.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(good.replace("1000", "250"));
      await editor.getByTestId("code-build").click();
      await expect(editor).toHaveAttribute("data-status", "built", { timeout: 150_000 });
      await expect(editor.getByTestId("code-status")).toContainText("Built");
      await expect(editor.locator(".cm-lintRange-error")).toHaveCount(0);
      await shot(page, info, "code-built");
      const log = readFileSync(join(dir, ".jumper/actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { op: string; actor: string; ok: boolean });
      expect(log.filter((e) => e.op === "write_file" && e.actor === "web").length).toBeGreaterThanOrEqual(2);
      expect(log.some((e) => e.op === "build" && e.actor === "web" && e.ok)).toBe(true);
      expect(log.some((e) => e.op === "run" && e.actor === "web" && e.ok)).toBe(true);
    } finally {
      await s.close();
    }
  });
});

test("without a server: the Projects home shows bundled examples and says how to keep projects", async ({ page }, info) => {
  await page.goto("/?example=blink");
  await expect(page.getByTestId("part-led1")).toBeVisible();
  await page.getByTestId("open-projects").click();
  const home = page.getByTestId("projects-home");
  await expect(home).toHaveAttribute("data-server", "no");
  await expect(home.getByTestId("projects-no-server")).toContainText("pnpm start");
  await expect(home.locator('[data-testid="example-card-tamagotchi"]')).toBeVisible();
  await shot(page, info, "projects-home-local");
  await page.getByTestId("projects-close").click();
  // The example's code is viewable read-only.
  await page.getByTestId("project-menu").click();
  await page.getByTestId("menu-code").click();
  const editor = page.getByTestId("code-editor");
  await expect(editor.getByTestId("code-readonly")).toBeVisible();
  await expect(editor.getByTestId("code-content")).toContainText("digitalWrite");
});
