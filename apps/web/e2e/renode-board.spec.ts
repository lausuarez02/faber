import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";
import { userHomeDir } from "@fabwright/project-format/node";

// Round 10 (track renode): a Black Pill F411 runs real STM32duino firmware in Renode next to
// `fabwright serve`, and the followed page shows its SSD1306 drawing. The agent places and wires the
// parts over MCP; the person presses Run on the page. Needs Renode: Docker with fabwright/renode, or a
// native Renode 1.17 (FABWRIGHT_RENODE_RUNTIME=native, FABWRIGHT_RENODE_BIN); skipped otherwise, saying why.
const CLI = fileURLToPath(new URL("../../cli/bin/fabwright.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../packages/sim-backends/fixtures/renode/", import.meta.url));
const RENODE_IMAGE = "fabwright/renode:1.17.0-r1";

/** Round 11: Fabwright's own Renode (fabwright setup renode), which `fabwright serve` uses when Docker is not up. */
const FABWRIGHT_RENODE = join(process.env.FABWRIGHT_NATIVE_HOME || userHomeDir(homedir()), "emulators/renode/1.17.0", process.platform === "darwin" ? "Renode.app/Contents/MacOS/renode" : "renode");

function renodeMissing(): string | undefined {
  if (process.env.FABWRIGHT_RENODE_RUNTIME === "native") {
    const r = spawnSync(process.env.FABWRIGHT_RENODE_BIN || "renode", ["--version"], { timeout: 30_000 });
    return r.status === 0 ? undefined : "native Renode (FABWRIGHT_RENODE_BIN) does not run";
  }
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
  if (info.status !== 0) return existsSync(FABWRIGHT_RENODE) ? undefined : "Docker is not running or not answering, and Renode is not installed natively (fabwright setup renode)";
  const img = spawnSync("docker", ["image", "inspect", RENODE_IMAGE], { stdio: "ignore", timeout: 15_000 });
  return img.status === 0 ? undefined : `the ${RENODE_IMAGE} image is missing`;
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

const why = renodeMissing();

test("a Black Pill F411 runs in Renode and its SSD1306 draws on the followed page", async ({ page }, info) => {
  test.skip(!!why, `Renode is not available here: ${why}`);
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), "fabwright-renode-e2e-"));
  const home = mkdtempSync(join(tmpdir(), "fabwright-home-"));
  // The sketch and its build (the fixture: STM32duino 2.11.0 + Adafruit SSD1306), newer than the
  // sketch so nothing rebuilds (the runner's STM32 image is not needed here).
  mkdirSync(join(dir, "firmware", "oled"), { recursive: true });
  copyFileSync(join(FIXTURES, "oled_blackpill", "oled_blackpill.ino"), join(dir, "firmware", "oled", "oled.ino"));
  copyFileSync(join(FIXTURES, "oled_blackpill-stm32-blackpill-f411.hex"), join(dir, "firmware", "oled.hex"));
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "firmware", "oled.hex"), later, later);
  writeFileSync(join(dir, "fabwright.json"), JSON.stringify({ format: "fabwright/1", name: "black-pill-oled", parts: [], wires: [] }, null, 2));
  const port = hubPort(info);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--no-web", "--no-open", "--port", String(port), "--strict-port"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FABWRIGHT_HOME: home } });
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
    await agent.call("place_part", { type: "stm32-blackpill-f411", id: "board", x: 0, y: 0, why: "the board" });
    await agent.call("place_part", { type: "ssd1306-oled-i2c", id: "oled", x: 520, y: 0, why: "the screen" });
    for (const [from, to] of [["oled.VCC", "board.3V3.1"], ["oled.GND", "board.GND.1"], ["oled.SDA", "board.PB7"], ["oled.SCL", "board.PB6"]]) {
      await agent.call("connect", { from, to, why: "wire the screen" });
    }
    await expect(page.getByTestId("part-board")).toBeVisible();
    await expect(page.getByTestId("part-oled")).toBeVisible();
    await expect(page.getByTestId("part-oled")).not.toHaveAttribute("data-state-blank", "false");

    await page.getByTestId("run-button").click();
    // The session starts Renode (a few seconds), runs 3 s of device time and the page shows it.
    await expect(page.getByTestId("part-oled")).toHaveAttribute("data-state-blank", "false", { timeout: 120_000 });
    const lit = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="part-oled"] [data-display-layer] canvas') as HTMLCanvasElement | null;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return -1;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 200) n++;
      return n;
    });
    expect(lit, "the OLED canvas has lit pixels").toBeGreaterThan(100);
    await shot(page, info, "renode-blackpill-oled");
  } finally {
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => proc.once("exit", () => r()));
    proc.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
