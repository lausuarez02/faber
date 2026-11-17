import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

// Round 6, canvas track: a `faber serve --no-web` on a temp copy of an example (or an e2e
// fixture), followed by the Vite page, like a person opening `faber serve`. Same pattern as
// live-run.spec.ts.
const CLI = fileURLToPath(new URL("../../cli/bin/faber.mjs", import.meta.url));
export const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

export interface Served {
  dir: string;
  ws: string;
  stop(): Promise<void>;
}

export async function serve(src: string, port: number, edit?: (dir: string) => void): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), "faber-canvas-"));
  const home = mkdtempSync(join(tmpdir(), "faber-home-"));
  cpSync(src, dir, { recursive: true });
  edit?.(dir);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--no-web", "--no-open", "--port", String(port), "--strict-port"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FABER_HOME: home } });
  let err = "";
  proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`faber serve did not start in 25 s: ${err}`)), 25_000);
    proc.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("ws:")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`faber serve exited with ${code}: ${err}`)));
  });
  return {
    dir,
    ws: `ws://127.0.0.1:${port}/live`,
    async stop() {
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Make the committed hex newer than the sketch, so nothing asks for a rebuild (no Docker). */
export function freshHex(dir: string, artifact: string): void {
  const t = new Date(Date.now() + 60_000);
  utimesSync(join(dir, artifact), t, t);
}

type J = {
  faber: {
    engine: { simulation?: { timeMs: number; partState(id: string): Record<string, unknown> | undefined }; serialText: string };
    store: { getState(): { run: string; project: { parts: { id: string; x: number; y: number }[] }; selectedParts: string[] } };
  };
};

export const partState = (page: Page, id: string) => page.evaluate((id) => (window as unknown as J).faber.engine.simulation?.partState(id) ?? {}, id);
export const serialText = (page: Page) => page.evaluate(() => (window as unknown as J).faber.engine.serialText);
export const runState = (page: Page) => page.evaluate(() => (window as unknown as J).faber.store.getState().run);
export const selected = (page: Page) => page.evaluate(() => (window as unknown as J).faber.store.getState().selectedParts);
export const partXY = (page: Page, id: string) =>
  page.evaluate((id) => {
    const p = (window as unknown as J).faber.store.getState().project.parts.find((x) => x.id === id);
    return p ? [p.x, p.y] : undefined;
  }, id);
export const viewTransform = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

export async function center(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} on screen`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Open the followed page and press Run; resolves when the page's own simulation runs. */
export async function openAndRun(page: Page, ws: string, firstPart: string): Promise<void> {
  await page.goto(`/?follow=${encodeURIComponent(ws)}`);
  await expect(page.getByTestId(`part-${firstPart}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("run-button").click();
  await expect.poll(() => runState(page), { timeout: 20_000 }).toBe("running");
}

export function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
