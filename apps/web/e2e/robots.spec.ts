import { expect, test } from "@playwright/test";
import { expectWithinSimTime, shot, waitForSimTime } from "./helpers.ts";

type W = { fabwright: { engine: { simulation?: { timeMs: number; partState(id: string): Record<string, unknown> | undefined }; world?: { stats(): { pose?: { x: number; y: number }; travelledCm: number; collisions: number } } } } };

async function openExample(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.goto(`/?example=${name}`);
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 15_000 });
}

test("tamagotchi: the firmware draws the pet on the OLED (non-blank pixels)", async ({ page }, info) => {
  await openExample(page, "tamagotchi");
  await expect(page.getByTestId("part-oled")).toBeVisible();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("sim-error")).toHaveCount(0);
  // The OLED part reports lit pixels; the canvas over its glass shows them.
  // Within 20 s of virtual time (sim time, not wall time: CI may simulate below 1x).
  await expectWithinSimTime(page, 20_000, async () => (await page.evaluate(() => Number((window as unknown as W).fabwright.engine.simulation?.partState("oled")?.lit ?? 0))) > 50, "the OLED should light more than 50 pixels");
  await expect(page.getByTestId("part-oled")).toHaveAttribute("data-state-blank", "false");
  const canvasLit = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="part-oled"] [data-display-layer] canvas') as HTMLCanvasElement | null;
    if (!c) return -1;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 300) n++;
    return n;
  });
  expect(canvasLit, "the OLED canvas over the part's screen should show bright pixels").toBeGreaterThan(50);
  await shot(page, info, "tamagotchi-oled");
});

test("rover: the robot drives in the World view", async ({ page }, info) => {
  await openExample(page, "rover");
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("world-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("world-panel")).toHaveAttribute("data-world", "robot");
  await expect(page.getByTestId("world-panel").getByTestId("physics-canvas")).toBeVisible();
  const read = () => page.evaluate(() => (window as unknown as W).fabwright.engine.world?.stats());
  await expectWithinSimTime(page, 20_000, async () => ((await read())?.travelledCm ?? 0) > 20, "the rover should travel more than 20 cm");
  const a = await read();
  await waitForSimTime(page, 1500);
  const b = await read();
  expect(a?.pose && b?.pose, "the rover should report a pose").toBeTruthy();
  expect(Math.hypot(b!.pose!.x - a!.pose!.x, b!.pose!.y - a!.pose!.y) + (b!.travelledCm - a!.travelledCm)).toBeGreaterThan(5);
  expect(b!.collisions).toBe(0);
  // The chassis part mirrors the pose, so scenarios and agents can read it like any other part.
  const chassis = await page.evaluate(() => (window as unknown as W).fabwright.engine.simulation?.partState("chassis"));
  expect(typeof chassis?.x).toBe("number");
  await shot(page, info, "rover-world");
});
