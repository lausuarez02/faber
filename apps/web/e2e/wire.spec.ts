import { expect, test } from "@playwright/test";
import { openCanvas, requireParts, shot } from "./helpers.ts";

test("wire: dragging from one pin to another creates a wire", async ({ page }, info) => {
  await openCanvas(page);
  if (info.project.name === "mobile") await page.getByTestId("dock-parts").click();
  await requireParts(page, ["arduino-uno", "led"]);
  if (info.project.name === "mobile") await page.getByTestId("dock-parts").click();

  const wires = page.locator(".react-flow__edge");
  const before = await wires.count();

  const from = page.getByTestId("pin-uno-D12");
  const to = page.getByTestId("pin-r1-1");
  await expect(from).toBeAttached();
  await expect(to).toBeAttached();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 + 30, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(wires).toHaveCount(before + 1);
  const newWire = page.locator(".react-flow__edge").last();
  await expect(newWire).toBeAttached();
  await shot(page, info, "wire-added");

  // undo / redo the connection
  await page.keyboard.press("ControlOrMeta+z");
  await expect(wires).toHaveCount(before);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(wires).toHaveCount(before + 1);

  // click a wire to select it, C cycles its color, Delete removes it
  const pt = await page.locator(".wire-hit").last().evaluate((el: SVGPathElement) => {
    const p = el.getPointAtLength(el.getTotalLength() * 0.5);
    const m = el.getScreenCTM()!;
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  });
  await page.mouse.click(pt.x, pt.y);
  const selected = page.locator('.wire[data-selected="true"]');
  await expect(selected).toHaveCount(1);
  const id = (await selected.getAttribute("data-testid"))!;
  const style0 = await selected.getAttribute("style");
  await page.keyboard.press("c");
  await expect(page.getByTestId(id)).not.toHaveAttribute("style", style0 ?? "");
  await shot(page, info, "wire-selected");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(wires).toHaveCount(before);
});
