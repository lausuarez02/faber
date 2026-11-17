import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { shot } from "./helpers.ts";

// Round 6, frames track (decision 0004, R7): a replay (what `fabwright record` films) paints the colour
// screen from the logged PNGs (Frame.color) instead of a dark glass. The fixture is a real CLI session:
// Uno + GC9A01 round TFT running the part's example (Adafruit_GFX drawing), 2.5 s run.
const LOG = fileURLToPath(new URL("./fixtures/gc9a01-session.jsonl", import.meta.url));

test("a replay paints the round TFT's logged pixels", async ({ page }, info) => {
  await page.goto(`/?replay=${encodeURIComponent(`/@fs${LOG}`)}&speed=8`);
  await expect(page.getByTestId("replay-index")).toContainText("done", { timeout: 30_000 });
  const canvas = page.locator('[data-testid="part-eye"] [data-display-layer="tft"] canvas');
  await expect(canvas).toHaveCount(1);
  // Count lit pixels on the screen canvas (it is 240x240, the panel's native size).
  await expect
    .poll(
      () =>
        canvas.evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 60) lit++;
          return lit;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(2000);
  await shot(page, info, "replay-color-tft");
});
