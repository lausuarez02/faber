import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Agent-made parts (decision 0003, C4) on the canvas: parts made with create_part in a project
// served by `jumper serve` draw in the follow view like built-ins: the generated module drawing,
// an agent SVG (sanitized), and a display built on a controller model.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));

function jumper(dir: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [CLI, ...args, "--project", dir], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`jumper ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

const SOIL = {
  id: "soil-moisture-sensor",
  name: "Capacitive soil moisture sensor v1.2",
  category: "sensor",
  description: "Analog soil moisture probe. AOUT falls as the soil gets wetter.",
  pins: [{ id: "GND", type: "ground" }, { id: "VCC", type: "power", voltage: { min: 3.3, max: 5.5 } }, { id: "AOUT", type: "analog" }],
  behavior: { kind: "analog-sensor", output: "AOUT", quantity: { id: "moisture", unit: "%", min: 0, max: 100, default: 40 }, curve: [{ value: 0, volts: 3 }, { value: 100, volts: 1.2 }] },
};
const BADGE = {
  id: "heart-badge",
  name: "Heart LED badge",
  category: "output",
  description: "A heart-shaped LED badge with its own driver; IN HIGH lights it.",
  size: { w: 80, h: 80 },
  pins: [{ id: "VCC", type: "power", x: 20, y: 74 }, { id: "IN", type: "digital", x: 40, y: 74 }, { id: "GND", type: "ground", x: 60, y: 74 }],
  behavior: { kind: "actuator", drive: "logic", input: "IN" },
};
const BADGE_SVG =
  '<svg viewBox="0 0 80 80" onload="window.__pwned=1"><script>window.__pwned=2</script><path d="M40 62 L14 36 A12 12 0 0 1 40 20 A12 12 0 0 1 66 36 Z" fill="#E0457B" stroke="#E9EDF2"/><circle data-bind="opacity:ledOpacity" cx="40" cy="38" r="8" fill="#FFE08A" opacity="0"/><circle data-pin="VCC" cx="20" cy="74" r="3" fill="#C9CED6"/><circle data-pin="IN" cx="40" cy="74" r="3" fill="#C9CED6"/><circle data-pin="GND" cx="60" cy="74" r="3" fill="#C9CED6"/></svg>';
const ROUND = { id: "round-tft-240", name: "Round 1.28 in TFT 240x240", category: "display", description: "Round IPS display on an ST77xx-style controller.", behavior: { kind: "display", controller: "st7735", resolution: { w: 240, h: 240 }, round: true } };

test.describe.configure({ mode: "serial" });

test("agent-made parts draw on the followed canvas, and new ones appear live", async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), "jumper-agentparts-"));
  const port = hubPort(info);
  let hub: ChildProcess | undefined;
  try {
    jumper(dir, "new", dir, "--template", "uno");
    jumper(dir, "call", "create_part", JSON.stringify({ part: SOIL, why: "no soil sensor in the catalog" }));
    jumper(dir, "call", "create_part", JSON.stringify({ part: BADGE, svg: BADGE_SVG, why: "a badge" }));
    jumper(dir, "place", "soil-moisture-sensor", "--id", "soil", "--x", "60", "--y", "-200");
    jumper(dir, "place", "heart-badge", "--id", "badge", "--x", "360", "--y", "-200");
    jumper(dir, "connect", "soil.AOUT", "uno.A0");
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--no-web", "--no-open", "--live-port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("jumper serve did not start in 20 s")), 20_000);
      hub!.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("ws:")) {
          clearTimeout(t);
          resolve();
        }
      });
      hub!.on("exit", (code) => reject(new Error(`jumper serve exited with ${code}`)));
    });
    await page.goto(`/?follow=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`);
    await expect(page.getByTestId("live-bar")).toBeVisible();

    const soil = page.getByTestId("part-soil");
    await expect(soil).toHaveAttribute("data-part-type", "soil-moisture-sensor", { timeout: 15_000 });
    await expect(soil.locator(".part-svg svg")).toContainText("AGENT-MADE");
    await expect(soil.locator('[data-testid="pin-soil-AOUT"]')).toBeAttached();
    await expect(page.locator('[data-testid^="wire-w"]')).toHaveCount(1);

    const badge = page.getByTestId("part-badge");
    await expect(badge).toHaveAttribute("data-part-type", "heart-badge");
    await expect(badge.locator(".part-svg svg path")).toHaveCount(1);
    await expect(badge.locator(".part-svg script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator(".part-unknown")).toHaveCount(0);

    // A part made while the page watches.
    jumper(dir, "call", "create_part", JSON.stringify({ part: ROUND, why: "round face" }));
    jumper(dir, "place", "round-tft-240", "--id", "face", "--x", "560", "--y", "-260");
    const face = page.getByTestId("part-face");
    await expect(face).toHaveAttribute("data-part-type", "round-tft-240", { timeout: 15_000 });
    await expect(face.locator('[data-screen="240x240"]')).toBeAttached();
    await page.getByTestId("part-soil").scrollIntoViewIfNeeded();
    await shot(page, info, "agentparts-follow");
  } finally {
    hub?.kill("SIGTERM");
    if (hub && hub.exitCode === null) await new Promise((r) => hub!.once("exit", r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("?local runs an agent-made ST7789 display with real firmware in the browser", async ({ page }, info) => {
  // Fixture: an Uno + a create_part'ed round ST7789 240x240 (st7735 controller, 240x320 RAM, IPS)
  // and an Adafruit_ST7789 sketch built by the Docker runner (firmware/main.hex).
  const dir = mkdtempSync(join(tmpdir(), "jumper-agentparts-tft-"));
  cpSync(fileURLToPath(new URL("./fixtures/agentparts-tft", import.meta.url)), dir, { recursive: true });
  const port = hubPort(info);
  let hub: ChildProcess | undefined;
  try {
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("jumper serve did not start in 30 s")), 30_000);
      hub!.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("open:")) {
          clearTimeout(t);
          resolve();
        }
      });
      hub!.on("exit", (code) => reject(new Error(`jumper serve exited with ${code}`)));
    });
    await page.goto(`http://localhost:${port}/?local`);
    const face = page.getByTestId("part-face");
    await expect(face).toHaveAttribute("data-part-type", "st7789-240-round", { timeout: 20_000 });
    await page.getByTestId("run-button").or(page.getByRole("button", { name: /^Run/ })).first().click();
    // The sketch draws a yellow face once at start-up; read the frame the canvas paints.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const f = (window as unknown as { jumper: { engine: { simulation?: { framebuffer(id: string): { width: number; height: number; data: Uint16Array; inverted: boolean } | undefined } } } }).jumper.engine.simulation?.framebuffer("face");
            if (!f) return "no frame";
            const px = (x: number, y: number) => (f.data[y * f.width + x]! ^ (f.inverted ? 0xffff : 0)).toString(16);
            return `${f.width}x${f.height} centre ${px(120, 60)} eye ${px(85, 95)} corner ${px(2, 2)}`;
          }),
        { timeout: 20_000 },
      )
      .toBe("240x240 centre ffe0 eye 0 corner 0");
    await expect(face.locator("canvas")).toHaveCount(1);
    await shot(page, info, "agentparts-local-tft");
  } finally {
    hub?.kill("SIGTERM");
    if (hub && hub.exitCode === null) await new Promise((r) => hub!.once("exit", r));
    rmSync(dir, { recursive: true, force: true });
  }
});
