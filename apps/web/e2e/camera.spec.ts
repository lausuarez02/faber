import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { hubPort, openInspector, shot } from "./helpers.ts";
import { userHomeDir } from "@fabwright/project-format/node";

// Round 13 (camera): a XIAO ESP32-S3 Sense placed by the agent (the camera starter template), built
// with the real toolchain and run in the ESP32 emulator next to `fabwright serve`. The followed page
// shows what the camera captured in the lens on the canvas; the Inspector's camera section shows it
// another scene and the next run's frames change. Needs Fabwright's native ESP32 toolchain and the QEMU
// with the camera port (fabwright setup esp32); skipped otherwise, saying why.
const CLI = fileURLToPath(new URL("../../cli/bin/fabwright.mjs", import.meta.url));
const NATIVE = process.env.FABWRIGHT_NATIVE_HOME || userHomeDir(homedir());
const QEMU = join(NATIVE, "emulators/qemu-esp/9.2.2-20260417-jb7/bin/qemu-system-xtensa");

function missing(): string | undefined {
  if (!existsSync(QEMU)) return `the ESP32 emulator with the camera port is not installed (${QEMU}; Fix: fabwright setup esp32)`;
  const cli = join(NATIVE, "toolchains/arduino");
  if (!existsSync(cli) || !readdirSync(cli).length) return "the native Arduino toolchain is not installed (Fix: fabwright setup esp32)";
  return undefined;
}

async function mcp(base: string) {
  let sid = "";
  let id = 0;
  const post = async (body: object) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
    sid ||= r.headers.get("mcp-session-id") ?? "";
    const text = await r.text();
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("") || text;
    return data ? (JSON.parse(data) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message: string } }) : {};
  };
  await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "9.9.9" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    async call(tool: string, args: Record<string, unknown> = {}) {
      const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } });
      if (r.error || r.result?.isError) throw new Error(`${tool}: ${r.error?.message ?? r.result?.content?.[0]?.text}`);
      return r.result;
    },
  };
}

const preview = (page: Page) => page.locator('[data-testid="part-sense"] image[data-bind*="camera_preview"]');
const why = missing();

test("a XIAO ESP32-S3 Sense runs in the emulator; the lens shows what its camera captured, and the Inspector changes it", async ({ page, isMobile }, info) => {
  test.skip(!!why, `the camera e2e needs the native ESP32 setup: ${why}`);
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), "fabwright-camera-e2e-"));
  const home = mkdtempSync(join(tmpdir(), "fabwright-home-"));
  writeFileSync(join(dir, "fabwright.json"), JSON.stringify({ format: "fabwright/1", name: "camera", parts: [], wires: [], scenarios: [] }, null, 2));
  const port = hubPort(info);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--no-web", "--no-open", "--port", String(port), "--strict-port"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FABWRIGHT_HOME: home, FABWRIGHT_RUNTIME: "native" } });
  let err = "";
  proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`fabwright serve did not start in 25 s: ${err}`)), 25_000);
      proc.stdout!.on("data", (d: Buffer) => d.toString().includes("ws:") && (clearTimeout(t), resolve()));
      proc.on("exit", (code) => reject(new Error(`fabwright serve exited with ${code}: ${err}`)));
    });
    await page.goto(`/?follow=${encodeURIComponent(`ws://127.0.0.1:${port}/live`)}`);
    const agent = await mcp(`http://127.0.0.1:${port}`);
    await agent.call("new_project", { template: "xiao-esp32s3-sense", overwrite: true });
    await agent.call("build");
    await expect(page.getByTestId("part-sense")).toBeVisible({ timeout: 30_000 });
    await expect(preview(page)).toHaveCount(1);
    await expect(preview(page)).toBeHidden(); // nothing captured yet

    await page.getByTestId("run-button").click();
    // The session boots QEMU, runs 3 s of device time; each capture puts a preview in the lens.
    await expect(preview(page)).toHaveAttribute("href", /^data:image\/jpeg;base64,/, { timeout: 120_000 });
    await expect(preview(page)).toBeVisible();
    const first = await preview(page).getAttribute("href");
    await shot(page, info, "camera-sense-preview");

    // The Inspector's camera section: show it the black scene, run again, a different picture.
    await page.getByTestId("part-sense").click({ position: { x: 20, y: 20 } });
    await openInspector(page);
    const panel = page.getByTestId("camera-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("camera-webcam")).toBeEnabled();
    await panel.getByTestId("camera-scene").selectOption("black");
    await expect(panel.getByTestId("camera-shown")).toContainText("black");
    if (isMobile) await page.keyboard.press("Escape");
    await page.getByTestId("run-button").click();
    await expect.poll(async () => (await preview(page).getAttribute("href")) !== first, { timeout: 120_000 }).toBe(true);
    await shot(page, info, "camera-sense-black");
  } finally {
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => proc.once("exit", () => r()));
    proc.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
