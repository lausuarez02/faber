import { expect, test, type Page } from "@playwright/test";
import { openCanvas, requireParts, shot } from "./helpers.ts";

interface View {
  x: number;
  y: number;
  zoom: number;
}

/** The React Flow viewport transform, e.g. `translate(143px, 314px) scale(1.054)`. */
async function view(page: Page): Promise<View> {
  const t = await page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(t);
  expect(m, `unexpected viewport transform "${t}"`).not.toBeNull();
  return { x: Number(m![1]), y: Number(m![2]), zoom: Number(m![3]) };
}

/** A point on the canvas where nothing but the empty pane is under the pointer. */
async function emptyPanePoint(page: Page): Promise<{ x: number; y: number }> {
  const pt = await page.getByTestId("canvas").evaluate((canvas) => {
    const r = canvas.getBoundingClientRect();
    for (let fy = 0.2; fy <= 0.8; fy += 0.05)
      for (let fx = 0.1; fx <= 0.9; fx += 0.05) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
      }
    return null;
  });
  expect(pt, "no empty spot on the canvas to grab").not.toBeNull();
  return pt!;
}

async function settle(page: Page): Promise<View> {
  await page.waitForTimeout(400); // initial fitView
  return view(page);
}

test("pan by dragging the empty canvas, zoom with the wheel", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the phone has its own touch test below");
  await openCanvas(page);
  const v0 = await settle(page);
  const p = await emptyPanePoint(page);

  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 40, p.y + 25, { steps: 5 });
  await page.mouse.move(p.x + 80, p.y + 50, { steps: 5 });
  await page.mouse.up();
  const v1 = await view(page);
  expect(v1.x - v0.x).toBeCloseTo(80, 0);
  expect(v1.y - v0.y).toBeCloseTo(50, 0);
  expect(v1.zoom).toBe(v0.zoom);

  // Wheel up zooms in around the pointer, wheel down zooms back out.
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(v1.zoom * 1.2);
  const v2 = await view(page);
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await view(page)).zoom).toBeLessThan(v2.zoom / 1.2);
  await shot(page, info, "viewport-zoomed");
});

test("touch: one finger pans, two fingers pinch-zoom", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "touch input is tested on the phone viewport");
  await openCanvas(page);
  const v0 = await settle(page);
  const p = await emptyPanePoint(page);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((pt, id) => ({ x: Math.round(pt.x), y: Math.round(pt.y), id, radiusX: 4, radiusY: 4, force: 1 })),
    });

  // one-finger pan
  await touch("touchStart", [p]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x: p.x + 10 * i, y: p.y + 6 * i }]);
  await touch("touchEnd", []);
  const v1 = await view(page);
  expect(v1.x - v0.x).toBeCloseTo(80, -1);
  expect(v1.y - v0.y).toBeCloseTo(48, -1);
  expect(v1.zoom).toBe(v0.zoom);

  // two-finger pinch out around the same spot
  const a = { x: p.x - 20, y: p.y };
  const b = { x: p.x + 20, y: p.y };
  await touch("touchStart", [a, b]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [{ x: a.x - 8 * i, y: a.y }, { x: b.x + 8 * i, y: b.y }]);
  await touch("touchEnd", []);
  const v2 = await view(page);
  // finger distance went from 40 to 200 px
  expect(v2.zoom / v1.zoom).toBeGreaterThan(2);
  await shot(page, info, "viewport-pinched");
});

test("drag a part from the library onto the canvas", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "phones place parts by tapping (see app.spec.ts)");
  await openCanvas(page);
  await requireParts(page, ["led"]);
  await settle(page);
  const nodes = page.locator(".react-flow__node");
  const before = await nodes.count();
  const ids = await nodes.evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  const p = await emptyPanePoint(page);
  const canvas = (await page.getByTestId("canvas").boundingBox())!;

  await page.getByTestId("library-led").dragTo(page.getByTestId("canvas"), {
    targetPosition: { x: p.x - canvas.x, y: p.y - canvas.y },
  });
  await expect(nodes).toHaveCount(before + 1);
  const newId = (await nodes.evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).find((id) => !ids.includes(id));
  expect(newId).toBeTruthy();
  const node = page.locator(`.react-flow__node[data-id="${newId}"]`);
  await expect(node.locator('[data-part-type="led"]')).toBeAttached();
  // It lands where it was dropped (within snapping and the part's own size).
  const box = (await node.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - p.x)).toBeLessThan(box.width / 2 + 24);
  expect(Math.abs(box.y + box.height / 2 - p.y)).toBeLessThan(box.height / 2 + 24);
  await shot(page, info, "drag-placed");
});
