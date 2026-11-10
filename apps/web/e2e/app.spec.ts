import { expect, test } from "@playwright/test";
import { openCanvas, openInspector, openLibrary, shot } from "./helpers.ts";

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
  // system → dark → light (desktop: the round moon button bottom-left; phone: the ⋯ menu)
  const toggle = async () => {
    if (info.project.name === "mobile") {
      await page.getByTestId("phone-menu").click();
      await page.getByRole("menuitem", { name: /Theme/ }).click();
      await page.keyboard.press("Escape");
    } else await page.getByTestId("theme-toggle").click();
  };
  await toggle();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await toggle();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.waitForTimeout(150);
  await shot(page, info, "light");
});

test("undo and redo a part placement", async ({ page }) => {
  await openCanvas(page);
  await openLibrary(page);
  const item = page.locator("[data-testid^=library-]").first();
  test.skip((await item.count()) === 0, "parts registry is empty");
  const type = (await item.getAttribute("data-testid"))!.replace("library-", "");
  const before = await page.locator(".react-flow__node").count();
  await item.click();
  await expect(page.getByTestId("parts-library")).toHaveCount(0); // placing closes the library
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
  await openInspector(page);
  const insp = page.getByTestId("part-inspector");
  await expect(insp).toBeVisible();
  const green = insp.getByRole("radio", { name: /green/i });
  if (await green.count()) {
    await green.click();
    await expect(green).toHaveAttribute("aria-checked", "true");
  }
  await shot(page, info, "inspector");
  await openLibrary(page);
  await shot(page, info, "parts-sheet");
});

test("the shell: floating chrome, agent dropdowns, device view, panels", async ({ page }, info) => {
  await openCanvas(page);
  await expect(page.getByTestId("tool-rail")).toBeVisible();
  await expect(page.getByTestId("project-subtitle")).toContainText(info.project.name === "mobile" ? "" : "Arduino Uno");
  if (info.project.name === "mobile") {
    await page.getByTestId("phone-menu").click();
    await page.getByRole("menuitem", { name: "Install MCP" }).click();
  } else {
    // One agent state (C6): "No agent" here, unless a local jumper serve on 7780 reports a real one.
    await expect(page.getByTestId("agent-pill")).toHaveAttribute("data-agent-status", /^(none|building|idle|done)$/);
    await page.getByTestId("install-mcp").click();
  }
  await expect(page.locator('[data-popover="mcp"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-popover="mcp"]')).toHaveCount(0);
  if (info.project.name !== "mobile") {
    await page.getByTestId("open-in-agent").click();
    await expect(page.locator('[data-popover="agent-menu"]')).toBeVisible();
    await page.keyboard.press("Escape");
    // Tests and serial open as floating panels and close again.
    await page.getByTestId("toggle-tests").click();
    await expect(page.getByTestId("panel-tests")).toBeVisible();
    await page.getByTestId("toggle-serial").click();
    await expect(page.getByTestId("panel-serial")).toBeVisible();
    await page.getByRole("button", { name: "Close Tests" }).click();
    await expect(page.getByTestId("panel-tests")).toHaveCount(0);
    // Tools: V / H / W switch the canvas mode.
    await page.locator(".react-flow__pane").click({ position: { x: 700, y: 820 } });
    await page.keyboard.press("h");
    await expect(page.getByTestId("canvas")).toHaveAttribute("data-tool", "hand");
    await page.keyboard.press("v");
    await expect(page.getByTestId("canvas")).toHaveAttribute("data-tool", "select");
    // Jump to a part selects it.
    await page.getByTestId("rail-jump").click();
    await page.getByTestId("jump-led1").click();
    await expect(page.getByTestId("part-led1")).toHaveAttribute("data-selected", "true");
    await shot(page, info, "shell-panels");
    await page.getByTestId("toggle-device").click();
    await expect(page.getByTestId("app").locator(".device-layer")).toBeVisible();
  }
});
