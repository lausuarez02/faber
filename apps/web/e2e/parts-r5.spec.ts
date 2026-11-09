// Round 5 parts in the browser: every new part is in the library, places on the canvas with its
// own drawing, and the round TFT gets its colour screen layer (clipped round).
import { expect, test } from "@playwright/test";
import { closeLibrary, openCanvas, openLibrary, requireParts, shot } from "./helpers.ts";

const NEW = [
  "gc9a01-round-tft", "lipo-battery", "tp4056-charger", "passive-buzzer", "vibration-motor", "ttp223-touch",
  "capacitive-soil-moisture", "relay-module", "water-pump", "ir-proximity", "bump-switch", "dht22", "pir-motion", "ws2812-strip",
];

test("the new parts are in the library and place with their drawings", async ({ page }, info) => {
  await openCanvas(page);
  await requireParts(page, NEW);
  for (const type of ["gc9a01-round-tft", "ws2812-strip", "relay-module", "water-pump"]) {
    await openLibrary(page);
    await page.getByTestId(`library-${type}`).click();
    await expect(page.getByTestId("parts-library")).toHaveCount(0);
    const node = page.locator(`[data-part-type="${type}"]`).last();
    await expect(node).toBeAttached();
    await expect(node.locator("svg circle[data-pin]").first()).toBeAttached();
  }
  // The round TFT's colour layer sits over its screen rect and is clipped to a circle.
  const tft = page.locator(`[data-part-type="gc9a01-round-tft"]`).last();
  const canvas = tft.locator('[data-display-layer="tft"] canvas');
  await expect(canvas).toBeAttached();
  await expect(canvas).toHaveAttribute("width", "240");
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).style.borderRadius)).toBe("50%");
  // The strip shows 8 LED slots by default and hides the rest.
  const strip = page.locator(`[data-part-type="ws2812-strip"]`).last();
  await expect(strip.locator('[data-bind="visible:show7"]')).not.toHaveAttribute("display", "none");
  await expect(strip.locator('[data-bind="visible:show8"]')).toHaveAttribute("display", "none");
  await closeLibrary(page);
  await page.keyboard.press("Escape");
  await shot(page, info, "parts-r5");
});
