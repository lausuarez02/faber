import { expect, test, type Page } from "@playwright/test";
import { shot } from "./helpers.ts";

// The round-3 surfaces: Install MCP, the 3D Device view (AI pet handheld, rover arena), the AI pet's
// colour screen and speech bubble with the mock AI, and the visual Tests panel.

type W = {
  jumper: {
    engine: {
      simulation?: { timeMs: number; serialText(): string; partState(id: string): Record<string, unknown> | undefined };
      world?: { stats(): { pose?: { x: number; y: number }; travelledCm: number; collisions: number } };
      interact(id: string, kind: "press" | "release"): void;
    };
  };
};

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 820;

async function openExample(page: Page, name: string): Promise<void> {
  await page.goto(`/?example=${name}`);
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 15_000 });
}

async function openDevice(page: Page): Promise<void> {
  if (isPhone(page)) {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-device").click();
  } else await page.getByTestId("toggle-device").click();
  await expect(page.getByTestId("device-view")).toBeVisible();
}

/** The speed selector is on the desktop Run pill; phones keep it in the store only. */
async function setSpeed(page: Page, speed: number): Promise<void> {
  await page.evaluate((v) => (window as unknown as { jumper: { store: { getState(): { setSpeed(n: number): void } } } }).jumper.store.getState().setSpeed(v), speed);
}

const serial = (page: Page) => page.evaluate(() => (window as unknown as W).jumper.engine.simulation?.serialText() ?? "");

/** Count strongly coloured pixels in a screenshot (the 3D scene itself is grey, screens are not). */
async function colourfulPixels(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!, gg = d[i + 1]!, b = d[i + 2]!;
      if (Math.max(r, gg, b) - Math.min(r, gg, b) > 80) n++;
    }
    return n;
  }, png.toString("base64"));
}

test("Install MCP shows the one-line Claude Code command", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  if (isPhone(page)) {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-install-mcp").click();
  } else await page.getByTestId("install-mcp").click();
  const menu = page.getByTestId("install-mcp-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("mcp-snippet-claude-code")).toHaveText(/^claude mcp add --transport http jumper http:\/\/localhost:\d+\/mcp$/);
  // Without `pnpm start` the menu says how to start the server.
  await expect(menu.getByTestId("mcp-server-status")).toContainText(/pnpm start|MCP server running/);
  await shot(page, info, "install-mcp");
});

test("AI pet: the colour screen draws the pet and TALK shows a mock reply bubble", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openExample(page, "ai-pet");
  await setSpeed(page, 2);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("sim-error")).toHaveCount(0);
  await expect.poll(() => serial(page), { timeout: 40_000 }).toContain("wifi: online");
  // The TFT canvas over the part's glass shows colour pixels.
  const tftColour = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="part-tft"] [data-display-layer="tft"] canvas') as HTMLCanvasElement | null;
    if (!c) return -1;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!) > 80) n++;
    return n;
  });
  expect(tftColour, "the TFT canvas should show the colourful pet").toBeGreaterThan(2000);
  // Only the colour layer sits on the TFT (a mono display canvas on top would hide it).
  await expect(page.locator('[data-testid="part-tft"] [data-display-layer]')).toHaveCount(1);
  // TALK: the Uno asks the mock AI through the ESP-01 and draws the reply in a bubble.
  await page.evaluate(() => (window as unknown as W).jumper.engine.interact("btnTalk", "press"));
  await page.waitForTimeout(250);
  await page.evaluate(() => (window as unknown as W).jumper.engine.interact("btnTalk", "release"));
  await expect.poll(() => serial(page), { timeout: 30_000 }).toMatch(/bubble: [^.\r\n][^\r\n]+/);
  expect(await serial(page)).toMatch(/reply 200 \w+\|/);
  // The bubble is white on the screen.
  const white = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="part-tft"] [data-display-layer="tft"] canvas') as HTMLCanvasElement | null;
    const d = c!.getContext("2d")!.getImageData(0, 0, c!.width, Math.floor(c!.height / 2)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 230 && d[i + 1]! > 230 && d[i + 2]! > 230) n++;
    return n;
  });
  expect(white, "a white speech bubble in the top half of the screen").toBeGreaterThan(3000);
  if (!isPhone(page)) {
    // The Network panel lists the request, answered by the mock.
    const net = page.getByTestId("network-panel");
    await expect(net).toBeVisible();
    await expect(net).toContainText("/v1/pet");
    await expect(net).toContainText("Mock");
  }
  await shot(page, info, "ai-pet-bubble");
});

test("Device view: the AI pet handheld shows its live colour screen", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openExample(page, "ai-pet");
  await setSpeed(page, 2);
  await page.getByTestId("run-button").click();
  await expect.poll(() => serial(page), { timeout: 40_000 }).toContain("Pet hatched");
  await openDevice(page);
  const stage = page.getByTestId("device-stage");
  await expect(stage).toHaveAttribute("data-kind", "handheld");
  await page.waitForTimeout(1500);
  const n = await colourfulPixels(page, await page.screenshot());
  expect(n, "the handheld's screen should show the coloured pet").toBeGreaterThan(3000);
  await shot(page, info, "device-ai-pet");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("device-view")).toHaveCount(0);
});

test("Device view: the rover drives in the 3D arena", async ({ page }, info) => {
  test.setTimeout(90_000);
  await openExample(page, "rover");
  await page.getByTestId("run-button").click();
  await openDevice(page);
  await expect(page.getByTestId("device-stage")).toHaveAttribute("data-kind", "rover");
  const read = () => page.evaluate(() => (window as unknown as W).jumper.engine.world?.stats());
  await expect.poll(async () => (await read())?.travelledCm ?? 0, { timeout: 30_000 }).toBeGreaterThan(20);
  const a = await read();
  const shotA = await page.screenshot();
  await page.waitForTimeout(1500);
  const b = await read();
  const shotB = await page.screenshot();
  expect(Math.hypot(b!.pose!.x - a!.pose!.x, b!.pose!.y - a!.pose!.y) + (b!.travelledCm - a!.travelledCm)).toBeGreaterThan(5);
  expect(shotA.equals(shotB), "the 3D view should change while the rover moves").toBe(false);
  await expect(page.getByTestId("device-readouts")).toBeVisible();
  await shot(page, info, "device-rover");
});

test("Tests panel: visual report with filmstrips for the AI pet", async ({ page }, info) => {
  await openExample(page, "ai-pet");
  if (isPhone(page)) {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-tests").click();
  } else await page.getByTestId("toggle-tests").click();
  const report = page.getByTestId("visual-test-report");
  await expect(report).toBeVisible({ timeout: 15_000 });
  await expect(report).toContainText("TALK asks the AI");
  await shot(page, info, "tests-ai-pet");
});
