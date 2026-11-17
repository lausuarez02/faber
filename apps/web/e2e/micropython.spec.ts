import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectAttrWithinSimTime, expectWithinSimTime, hubPort, openSerial, shot } from "./helpers.ts";

// Round 10 (languages): MicroPython on a Raspberry Pi Pico, end to end in the browser. A real
// `fabwright serve` on a project made from the pico-micropython template; the person edits main.py in
// the code editor (Python mode), Build & Run flashes the official MicroPython firmware with the file
// in its littlefs filesystem (in process, no Docker), the canvas runs it on rp2040js: the on-board
// LED toggles, the Serial panel shows the prints, and a line typed there runs at the REPL.
const CLI = fileURLToPath(new URL("../../cli/bin/fabwright.mjs", import.meta.url));

interface Served {
  url: string;
  dir: string;
  home: string;
  close(): Promise<void>;
}

function fabwright(dir: string, home: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [CLI, ...args, "--project", dir], { encoding: "utf8", timeout: 60_000, env: { ...process.env, FABWRIGHT_HOME: home } });
  if (r.status !== 0) throw new Error(`fabwright ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

async function serve(info: TestInfo): Promise<Served> {
  const root = mkdtempSync(join(tmpdir(), "fabwright-e2e-mpy-"));
  const home = join(root, "home");
  const dir = join(root, "projects", "pico-py");
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, FABWRIGHT_HOME: home };
  const made = spawnSync(process.execPath, [CLI, "new", dir, "--template", "pico-micropython", "--overwrite"], { encoding: "utf8", timeout: 60_000, env });
  if (made.status !== 0) throw new Error(`fabwright new failed (${made.status}): ${made.stderr || made.stdout}`);
  const port = hubPort(info, 1);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`fabwright serve did not start in 40 s:\n${log}`)), 40_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes("MCP:")) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`fabwright serve exited with ${code}:\n${log}`)));
  });
  return {
    url: `http://localhost:${port}`,
    dir,
    home,
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

const MAIN_PY = `from machine import Pin
import time

led = Pin(25, Pin.OUT)
print("hello from e2e")
for i in range(8):
    led.toggle()
    print("blink", i, led.value())
    time.sleep_ms(150)
print("main.py done")
`;

async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("rail-firmware").click();
  await page.getByTestId("firmware-sketch").click();
  await expect(page.getByTestId("code-editor")).toBeVisible();
}

test.describe("MicroPython on the Pico", () => {
  test.setTimeout(120_000);

  test("edit main.py, Build & Run: the LED toggles, the Serial panel shows the prints and the REPL answers", async ({ page }, info) => {
    const s = await serve(info);
    try {
      await page.goto(`${s.url}/`);
      await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("part-pico")).toBeAttached({ timeout: 30_000 });
      // Someone new lands on Projects (round 6): go back to the canvas.
      const home = page.getByTestId("projects-home");
      if (await home.isVisible().catch(() => false)) await home.getByTestId("projects-close").click();
      await expect(home).toHaveCount(0);

      if (info.project.name === "desktop") {
        await openEditor(page);
        const editor = page.getByTestId("code-editor");
        await expect(editor).toHaveAttribute("data-editable", "true", { timeout: 20_000 });
        const content = editor.getByTestId("code-content");
        await expect(content).toHaveAttribute("data-mode", "python");
        await expect(content).toContainText("led.toggle()");
        await shot(page, info, "mpy-editor");

        // Edit main.py and Build & Run (MicroPython: syntax check + firmware + filesystem, in process).
        await content.click();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.insertText(MAIN_PY);
        await editor.getByTestId("code-build").click();
        await expect(editor).toHaveAttribute("data-status", "built", { timeout: 60_000 });
        await expect(editor.getByTestId("code-status")).toContainText("MicroPython 1.29.0");
        expect(readFileSync(join(s.dir, "firmware/main.py"), "utf8")).toBe(MAIN_PY);
        await editor.getByTestId("code-close").click();
      } else {
        // The phone layout has no code drawer: the agent path writes and builds the same file.
        const src = join(s.dir, "..", "main.py");
        writeFileSync(src, MAIN_PY);
        fabwright(s.dir, s.home, "write", "firmware/main.py", "--from", src);
        fabwright(s.dir, s.home, "build");
      }

      // Run it here on the canvas, so this page's Serial panel is the board's console.
      const run = page.getByTestId("run-button");
      if ((await run.getAttribute("aria-label")) !== "Pause simulation") await run.click();
      await expect(run).toHaveAttribute("aria-label", "Pause simulation", { timeout: 20_000 });

      const pico = page.getByTestId("part-pico");
      await expectAttrWithinSimTime(page, pico, "data-state-led", /^(1|true)$/, 3000);
      await expectAttrWithinSimTime(page, pico, "data-state-led", /^(0|false)$/, 1000);

      await openSerial(page);
      const out = page.getByTestId("serial-console");
      await expectWithinSimTime(page, 4000, async () => (await out.textContent())?.includes("main.py done") ?? false, "main.py should finish and print 'main.py done'");
      await expect(out).toContainText("hello from e2e");
      await expect(out).toContainText("blink 1 0");
      await expect(out).toContainText(">>>");

      // The REPL: a line typed in the Serial panel runs on the board.
      const input = page.getByTestId("serial-input");
      await input.fill("print(6 * 7, led.value())");
      await input.press("Enter");
      await expectWithinSimTime(page, 2000, async () => /\b42 0\b/.test((await out.textContent()) ?? ""), "the REPL should answer 42 0");
      await shot(page, info, "mpy-repl");
    } finally {
      await s.close();
    }
  });
});
