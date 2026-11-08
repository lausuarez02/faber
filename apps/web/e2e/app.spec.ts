import { expect, test } from "@playwright/test";
import { openCanvas, shot } from "./helpers.ts";

test("app boots with the Blink example", async ({ page }, info) => {
  await openCanvas(page);
  await expect(page.getByTestId("run-button")).toBeVisible();
  await expect(page.getByTestId("part-uno")).toBeAttached();
  await expect(page.getByTestId("part-led1")).toBeAttached();
  await expect(page.getByTestId("part-r1")).toBeAttached();
  await page.waitForTimeout(300); // fonts + fitView settle
  await shot(page, info, "boot");
});

test("theme toggle switches to light", async ({ page }, info) => {
  await openCanvas(page);
  const html = page.locator("html");
  // system → dark → light
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.waitForTimeout(150);
  await shot(page, info, "light");
});

test("undo and redo a part placement", async ({ page }) => {
  await openCanvas(page);
  const isMobile = info().project.name === "mobile";
  if (isMobile) await page.getByTestId("dock-parts").click();
  const item = page.locator("[data-testid^=library-]").first();
  test.skip((await item.count()) === 0, "parts registry is empty");
  const type = (await item.getAttribute("data-testid"))!.replace("library-", "");
  const before = await page.locator(".react-flow__node").count();
  await item.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
  await expect(page.locator(`[data-part-type="${type}"]`).last()).toBeAttached();
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(before);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
});

test("inspector edits the selected part's props", async ({ page }, info) => {
  await openCanvas(page);
  const led = page.getByTestId("part-led1");
  await expect(led).toBeAttached();
  const box = (await led.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 6);
  if (info.project.name === "mobile") await page.getByTestId("dock-inspect").click();
  const insp = page.getByTestId("part-inspector");
  await expect(insp).toBeVisible();
  const green = insp.getByRole("radio", { name: /green/i });
  if (await green.count()) {
    await green.click();
    await expect(green).toHaveAttribute("aria-checked", "true");
  }
  await shot(page, info, "inspector");
  if (info.project.name === "mobile") {
    await page.getByTestId("dock-parts").click();
    await expect(page.getByTestId("parts-library")).toBeVisible();
    await shot(page, info, "parts-sheet");
  }
});

function info() {
  return test.info();
}
