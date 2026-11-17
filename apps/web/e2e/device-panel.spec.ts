import { expect, test, type Page } from "@playwright/test";
import { shot } from "./helpers.ts";

// Round 17: an e-paper (or memory LCD) shows its picture in the Device view's 3D screen, like a TFT.
// Round 15's mood case rendered that window dark while the canvas had the face. The standalone
// Device view page runs the project; setFrame stands in for the firmware that would draw the face
// (an ESP32 build is not needed to check the view's frame path).
const PROJECT = JSON.stringify({
  format: "fabwright/1",
  name: "paper",
  parts: [
    { id: "uno", type: "arduino-uno", x: 0, y: 0 },
    { id: "epd", type: "epaper-154-ssd1681", x: 600, y: 0 },
    { id: "b1", type: "pushbutton", x: 600, y: 400 },
  ],
  wires: [],
});

/** Share of the stage's pixels close to an RGB colour. */
async function share(page: Page, rgb: [number, number, number], tol = 40): Promise<number> {
  const png = await page.screenshot();
  return page.evaluate(
    async ({ b64, rgb, tol }) => {
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
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - rgb[0]) < tol && Math.abs(d[i + 1]! - rgb[1]) < tol && Math.abs(d[i + 2]! - rgb[2]) < tol) n++;
      return n / (d.length / 4);
    },
    { b64: png.toString("base64"), rgb, tol },
  );
}

test("Device view: an e-paper shows its frame in the 3D screen (not a dark window)", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto("/src/views/device/dev/index.html?hud=0&finish=graphite");
  await page.waitForFunction(() => !!(window as unknown as { __device?: unknown }).__device);
  await page.evaluate((json) => (window as unknown as { __device: { load(j: string): Promise<void> } }).__device.load(json), PROJECT);
  await expect(page.getByTestId("device-stage")).toHaveAttribute("data-kind", "handheld");
  await page.waitForTimeout(1500);
  // before any frame: the paper's own blank colour (#ECEAE2), not a black OLED
  expect(await share(page, [0xec, 0xea, 0xe2], 45)).toBeGreaterThan(0.004);
  await shot(page, info, "device-epaper-blank");
  // a frame: green left half (0x07E0), white right half
  await page.evaluate(() => {
    const w = 200;
    const h = 200;
    const px: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.push(x < w / 2 ? 0x07e0 : 0xffff);
    (window as unknown as { __device: { setFrame(id: string, f: object): void } }).__device.setFrame("epd", { width: w, height: h, rgb565: px });
  });
  await expect.poll(() => share(page, [0, 255, 0], 90), { timeout: 10_000 }).toBeGreaterThan(0.004);
  await shot(page, info, "device-epaper-frame");
});
