import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { hubPort, shot, waitForSimTime } from "./helpers.ts";

// Round 5, live track (decision 0003): the page that follows an agent runs the device itself.
// Each test starts its own `fabwright serve --no-web` on a temp copy of an example and opens the Vite
// page with ?follow=ws://…/live, like `fabwright serve` does for a person. The tests run one after
// another on one port per viewport (hubPort slot 0), so a worktree needs only two ports.
const CLI = fileURLToPath(new URL("../../cli/bin/fabwright.mjs", import.meta.url));
const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));

interface Served {
  dir: string;
  port: number;
  base: string;
  ws: string;
  stop(): Promise<void>;
}

async function serve(example: string | undefined, port: number, edit?: (dir: string) => void): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), "fabwright-live-run-"));
  const home = mkdtempSync(join(tmpdir(), "fabwright-home-"));
  if (example) cpSync(join(EXAMPLES, example), dir, { recursive: true });
  edit?.(dir);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--no-web", "--no-open", "--port", String(port), "--strict-port"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FABWRIGHT_HOME: home } });
  let err = "";
  proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`fabwright serve did not start in 25 s: ${err}`)), 25_000);
    proc.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("ws:")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`fabwright serve exited with ${code}: ${err}`)));
  });
  return {
    dir,
    port,
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/live`,
    async stop() {
      // Wait for the port to be free: the next test in this file reuses it.
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Make the committed hex newer than the sketch, so an agent `run` does not rebuild (no Docker). */
function freshHex(dir: string, artifact: string): void {
  const t = new Date(Date.now() + 60_000);
  utimesSync(join(dir, artifact), t, t);
}

/** A minimal MCP client over Streamable HTTP (what Claude Code does), with fetch. */
async function mcpClient(base: string, name = "claude-code") {
  let sid = "";
  let id = 0;
  const post = async (body: object) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
    sid ||= r.headers.get("mcp-session-id") ?? "";
    const text = await r.text();
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("") || text;
    return data ? (JSON.parse(data) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message: string } }) : {};
  };
  await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "9.9.9" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    async call(tool: string, args: Record<string, unknown> = {}) {
      const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } });
      if (r.error || r.result?.isError) throw new Error(`${tool}: ${r.error?.message ?? r.result?.content?.[0]?.text}`);
      return r.result;
    },
    close: () => fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } }),
  };
}

const engineState = (page: Page) =>
  page.evaluate(() => {
    const j = (window as unknown as { fabwright: { engine: { isLocalRun: boolean; simulation?: { timeMs: number } }; store: { getState(): { run: string } } } }).fabwright;
    return { local: j.engine.isLocalRun, run: j.store.getState().run, t: j.engine.simulation?.timeMs ?? 0 };
  });

const partState = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as { fabwright: { engine: { simulation?: { partState(id: string): Record<string, unknown> | undefined } } } }).fabwright.engine.simulation?.partState(id) ?? {}, id);

const partXY = (page: Page, id: string) =>
  page.evaluate((id) => {
    const p = (window as unknown as { fabwright: { store: { getState(): { project: { parts: { id: string; x: number; y: number }[] } } } } }).fabwright.store.getState().project.parts.find((x) => x.id === id);
    return p ? [p.x, p.y] : undefined;
  }, id);

async function center(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} on screen`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test.describe.configure({ mode: "serial" });

test("follow page: Run runs the project here; buttons press, knobs turn, IMU tilts, sensors slide", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "pointer drags on the canvas are covered on desktop; phones share the same handlers");
  const srv = await serve("tamagotchi", hubPort(info), (dir) => {
    // Extra unwired parts for the knob, IMU and sensor controls.
    const p = JSON.parse(readFileSync(join(dir, "fabwright.json"), "utf8")) as { parts: object[] };
    p.parts.push({ id: "pot1", type: "potentiometer", x: -260, y: 260, rotation: 0 }, { id: "imu1", type: "mpu6050", x: -330, y: 420, rotation: 0 }, { id: "ldr1", type: "photoresistor", x: -150, y: 440, rotation: 0 });
    writeFileSync(join(dir, "fabwright.json"), JSON.stringify(p, null, 2));
  });
  try {
    await page.goto(`/?follow=${encodeURIComponent(srv.ws)}`);
    await expect(page.getByTestId("part-btnFeed")).toBeVisible({ timeout: 15_000 });
    // Not running yet: no hit areas, the agent's (empty) state shows.
    await expect(page.getByTestId("control-btnFeed")).toHaveCount(0);
    await page.getByTestId("run-button").click();
    await expect.poll(async () => (await engineState(page)).run, { timeout: 15_000 }).toBe("running");
    expect((await engineState(page)).local).toBe(true);
    await expect(page.getByTestId("live-running-here")).toContainText("running here");
    await waitForSimTime(page, 1500);
    // The OLED animates from the page's own simulation.
    const px = await partState(page, "oled");
    expect(String(px.pixels ?? "").length).toBeGreaterThan(100);

    // Hold a pushbutton: pressed while the pointer is down, released on up; the part never moves.
    const before = await partXY(page, "btnFeed");
    const b = await center(page, "control-btnFeed");
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    await expect.poll(async () => (await partState(page, "btnFeed")).pressed).toBe(true);
    await expect(page.getByTestId("control-btnFeed")).toHaveAttribute("data-held", "true");
    await page.mouse.move(b.x + 40, b.y + 30);
    await page.mouse.up();
    await expect.poll(async () => (await partState(page, "btnFeed")).pressed).toBe(false);
    expect(await partXY(page, "btnFeed")).toEqual(before);

    // Drag the knob: it turns (up to 100 %), the potentiometer stays where it is.
    const potBefore = await partXY(page, "pot1");
    const k = await center(page, "control-pot1");
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x + 50, k.y, { steps: 5 });
    await page.mouse.move(k.x + 120, k.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Number((await partState(page, "pot1")).position)).toBeGreaterThan(0.95);
    expect(await partXY(page, "pot1")).toEqual(potBefore);

    // IMU: drag the tilt pad, then shake.
    await expect(page.getByTestId("live-controls")).toBeVisible();
    const pad = await page.getByTestId("imu-pad-imu1").boundingBox();
    await page.mouse.move(pad!.x + pad!.width / 2, pad!.y + pad!.height / 2);
    await page.mouse.down();
    await page.mouse.move(pad!.x + pad!.width - 4, pad!.y + pad!.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId("imu-read-imu1")).toContainText("roll 5");
    await expect.poll(async () => Number((await partState(page, "imu1")).accelX)).toBeLessThan(-0.5);
    await page.getByTestId("imu-shake-imu1").click();
    await expect.poll(async () => Math.abs(Number((await partState(page, "imu1")).gyroZ))).toBeGreaterThan(10);

    // Sensor slider: what the light sensor measures.
    const lux0 = Number((await partState(page, "ldr1")).lux);
    await page.getByTestId("sensor-ldr1-lux").focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Number((await partState(page, "ldr1")).lux)).toBeGreaterThan(lux0);
    await shot(page, info, "live-run-interact");

    // Pause, stop by Run state: the person's run is theirs; the project file never changed.
    const disk = JSON.parse(readFileSync(join(srv.dir, "fabwright.json"), "utf8")) as { parts: { id: string; props?: Record<string, unknown> }[] };
    expect(disk.parts.find((p) => p.id === "pot1")?.props?.position).toBeUndefined();
  } finally {
    await srv.stop();
  }
});

test("agent pill: No agent until a tool is called, building while calls arrive, done after; auto-run after an agent run and a new build", async ({ page }, info) => {
  test.setTimeout(90_000);
  const srv = await serve("blink", hubPort(info), (dir) => freshHex(dir, "firmware/blink.hex"));
  try {
    await page.goto(`/?follow=${encodeURIComponent(srv.ws)}`);
    await expect(page.getByTestId("part-led1")).toBeVisible({ timeout: 15_000 });
    // Phones have no bottom-right pill: the Live bar and the Agent steps sheet carry the state there.
    const phone = info.project.name === "mobile";
    const pill = page.getByTestId(phone ? "live-steps" : "agent-pill");
    if (phone && !(await pill.isVisible())) await page.getByTestId("rail-agent").click();
    await expect(pill).toHaveAttribute("data-agent-status", "none");
    if (phone) await shot(page, info, "live-no-agent");
    await expect(page.getByTestId("live-actions")).toContainText("no agent yet");
    if (!phone) {
      await expect(pill).toContainText("No agent");
      await expect(page.getByTestId("agent-connect")).toBeVisible();
      // Connect opens the Install MCP popover, which reads the same state.
      await page.getByTestId("agent-connect").click();
      await expect(page.getByTestId("mcp-agent-state")).toHaveAttribute("data-agent-status", "none");
      await page.keyboard.press("Escape");
    }
    expect((await engineState(page)).run).toBe("idle");

    // An MCP client connecting is not an agent working.
    const agent = await mcpClient(srv.base);
    await page.waitForTimeout(600);
    await expect(pill).toHaveAttribute("data-agent-status", "none");

    // Its first tool call: building, named, counted. Its run finished ok: the page runs the device.
    await agent.call("run", { ms: 200, why: "see it blink" });
    await expect(pill).toHaveAttribute("data-agent-status", "building");
    await expect(pill).toContainText("Claude Code");
    if (!phone) await expect(page.getByTestId("agent-connect")).toHaveCount(0);
    await expect(page.getByTestId("live-actions")).toContainText("1 agent action");
    await expect.poll(async () => (await engineState(page)).run, { timeout: 15_000 }).toBe("running");
    expect((await engineState(page)).local).toBe(true);
    await expect(page.locator('[data-testid="part-led1"][data-lit="true"]')).toBeVisible({ timeout: 15_000 });
    await shot(page, info, "live-autorun");

    // A new build (written by another MCP process): the page reloads the hex and restarts with it.
    const other = readFileSync(join(EXAMPLES, "tamagotchi/firmware/tamagotchi.hex"), "utf8");
    writeFileSync(join(srv.dir, "firmware/blink.hex"), other);
    const hash = createHash("sha256").update(other).digest("hex");
    const t1 = (await engineState(page)).t;
    expect(t1).toBeGreaterThan(0);
    mkdirSync(join(srv.dir, ".fabwright"), { recursive: true });
    appendFileSync(join(srv.dir, ".fabwright/actions.jsonl"), JSON.stringify({ seq: 999, t: new Date().toISOString(), actor: "mcp", sid: "stdio1", client: "codex-mcp-client 0.1", op: "build", args: {}, ok: true, firmware: { artifact: "firmware/blink.hex", hash }, result: { ok: true } }) + "\n");
    await expect.poll(() => page.evaluate(() => (window as unknown as { fabwright: { store: { getState(): { firmware: { hex?: string } } } } }).fabwright.store.getState().firmware.hex?.length ?? 0), { timeout: 10_000 }).toBe(other.length);
    await expect.poll(async () => (await engineState(page)).run).toBe("running");
    await expect(page.getByTestId("live-actions")).toContainText("2 agent actions");

    // The session ends: after the quiet period the pill says done (never "building" forever).
    await agent.close();
    await expect(pill).toHaveAttribute("data-agent-status", /idle|done/, { timeout: 20_000 });
    if (!phone) await expect(page.getByTestId("agent-presence")).toHaveAttribute("data-agent-status", /idle|done/);
  } finally {
    await srv.stop();
  }
});

test("Run with nothing to run says why and what to do", async ({ page }, info) => {
  const srv = await serve(undefined, hubPort(info));
  try {
    await page.goto(`/?follow=${encodeURIComponent(srv.ws)}`);
    await expect(page.getByTestId("live-bar")).toContainText("Live", { timeout: 15_000 });
    await page.getByTestId("run-button").click();
    const toast = page.locator(".toast, [role=alert], [data-testid=sim-error]").filter({ hasText: /Nothing to run|no board/ }).first();
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/open an example/);
    expect((await engineState(page)).run).toBe("idle");
    await shot(page, info, "live-nothing-to-run");
  } finally {
    await srv.stop();
  }
});

test("follow page with autorun=1: starts by itself and a colour TFT animates from the page's own simulation", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the TFT painter is the same on phones; covered once on desktop");
  const srv = await serve("ai-pet", hubPort(info));
  try {
    // The shareable viewer link (GET /v/:id) adds autorun=1: the device starts by itself.
    await page.goto(`/?follow=${encodeURIComponent(srv.ws)}&autorun=1`);
    await expect(page.getByTestId("part-tft")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await engineState(page)).run, { timeout: 15_000 }).toBe("running");
    const colour = () =>
      page.evaluate(() => {
        const c = document.querySelector('[data-testid="part-tft"] [data-display-layer="tft"] canvas') as HTMLCanvasElement | null;
        if (!c) return -1;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!) > 80) n++;
        return n;
      });
    await expect.poll(colour, { timeout: 30_000, message: "the TFT canvas should show the colourful pet" }).toBeGreaterThan(2000);
    await shot(page, info, "live-run-tft");
  } finally {
    await srv.stop();
  }
});
