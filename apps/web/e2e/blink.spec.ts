import { expect, test } from "@playwright/test";
import { expectAttrWithinSimTime, expectWithinSimTime, openCanvas, openSerial, requireParts, shot } from "./helpers.ts";

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

  // Blink toggles every 1 s of virtual time, so both states show within 3 s of VIRTUAL time
  // (sim time, not wall time: a slow CI runner may simulate well below 1x).
  await expectAttrWithinSimTime(page, led, "data-lit", "true", 3000);
  await expectAttrWithinSimTime(page, uno, "data-state-led-l", /^(1|true)$/, 3000);
  await shot(page, info, "blink-on");
  await expectAttrWithinSimTime(page, led, "data-lit", "false", 3000);
  await expectAttrWithinSimTime(page, uno, "data-state-led-l", /^(0|false)$/, 3000);
  await shot(page, info, "blink-off");

  // the D13 wire carries HIGH at some point
  await openSerial(page);
  const consoleEl = page.getByTestId("serial-console");
  await expectWithinSimTime(page, 3000, async () => ((await consoleEl.textContent()) ?? "").includes("LED on"), "the serial console should print \"LED on\"");
  await expect(page.getByTestId("sim-time")).toHaveAttribute("data-run", "running");
  await shot(page, info, "blink-serial");

  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("sim-time")).toHaveAttribute("data-run", "paused");
});
