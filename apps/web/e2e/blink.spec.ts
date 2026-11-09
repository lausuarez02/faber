import { expect, test } from "@playwright/test";
import { openCanvas, openSerial, requireParts, shot } from "./helpers.ts";

test("blink: Run lights the D13 LED and the on-board L LED, serial prints", async ({ page }, info) => {
  await openCanvas(page);
  await requireParts(page, ["arduino-uno", "resistor", "led"]);

  const fw = page.getByTestId("firmware-status");
  await expect(page.getByTestId("app")).not.toHaveAttribute("data-firmware", "loading");
  const status = await page.getByTestId("app").getAttribute("data-firmware");
  expect(status, "firmware not built: run the toolchains/arduino build so examples/blink has its .hex").toBe("ready");
  void fw;

  const led = page.getByTestId("part-led1");
  const uno = page.getByTestId("part-uno");
  await expect(led).toHaveAttribute("data-lit", "false");

  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("sim-error")).toHaveCount(0);

  // Blink toggles every 1 s of virtual time; at 1x we must see both states within 3 s.
  await expect(led).toHaveAttribute("data-lit", "true", { timeout: 3000 });
  await expect(uno).toHaveAttribute("data-state-led-l", /^(1|true)$/, { timeout: 3000 });
  await shot(page, info, "blink-on");
  await expect(led).toHaveAttribute("data-lit", "false", { timeout: 3000 });
  await expect(uno).toHaveAttribute("data-state-led-l", /^(0|false)$/, { timeout: 3000 });
  await shot(page, info, "blink-off");

  // the D13 wire carries HIGH at some point
  await openSerial(page);
  await expect(page.getByTestId("serial-console")).toContainText("LED on", { timeout: 3000 });
  await expect(page.getByTestId("sim-time")).toHaveAttribute("data-run", "running");
  await shot(page, info, "blink-serial");

  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("sim-time")).toHaveAttribute("data-run", "paused");
});
