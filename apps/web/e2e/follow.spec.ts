import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Follow mode end to end: `faber serve --no-web` runs the live hub on a project folder, the page
// follows it over WebSocket, and parts / wires added with the plain CLI show up on the canvas.
const CLI = fileURLToPath(new URL("../../cli/bin/faber.mjs", import.meta.url));

function faber(dir: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [CLI, ...args, "--project", dir], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`faber ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

test.describe.configure({ mode: "serial" });

test("live follow: place and connect from the CLI appear on the canvas", async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), "faber-follow-"));
  const port = hubPort(info);
  let hub: ChildProcess | undefined;
  try {
    faber(dir, "new", dir, "--template", "uno");
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--no-web", "--no-open", "--live-port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("live hub did not start in 20 s")), 20_000);
      hub!.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("ws:")) {
          clearTimeout(t);
          resolve();
        }
      });
      hub!.on("exit", (code) => reject(new Error(`live hub exited with ${code}`)));
    });
    await page.goto(`/?follow=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`);
    await expect(page.getByTestId("live-bar")).toBeVisible();
    await expect(page.getByTestId("part-uno")).toBeVisible({ timeout: 15_000 });

    faber(dir, "place", "led", "--id", "led1", "--x", "420", "--y", "-160", "--why", "status light");
    await expect(page.getByTestId("part-led1")).toBeVisible({ timeout: 15_000 });
    faber(dir, "connect", "uno.D13", "led1.A", "--why", "drive the LED from D13");
    await expect(page.locator('[data-testid^="wire-w"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("live-steps")).toContainText("drive the LED from D13");
    await shot(page, info, "follow-cli");
  } finally {
    hub?.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
