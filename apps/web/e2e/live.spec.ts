import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { shot } from "./helpers.ts";

// Replay mode (?replay=<action log>): what `jumper replay` / `jumper record` show. The fixture is a
// real CLI session: Uno + resistor + LED, Blink firmware, a run and a test run.
const LOG = fileURLToPath(new URL("./fixtures/blink-session.jsonl", import.meta.url));

test("replays an agent session: parts, wires, steps, code, serial, tests", async ({ page }, info) => {
  await page.goto(`/?replay=${encodeURIComponent(`/@fs${LOG}`)}&speed=8`);
  await expect(page.getByTestId("live-bar")).toContainText("Replay");
  await expect(page.getByTestId("replay-index")).toContainText("done", { timeout: 30_000 });
  await expect(page.locator('[data-testid^="part-"]')).toHaveCount(3);
  await expect(page.locator('[data-testid^="wire-w"]')).toHaveCount(3);
  await expect(page.getByTestId("live-steps")).toContainText("wire the LED");
  await expect(page.getByTestId("live-tests")).toContainText("blinks");
  await expect(page.getByTestId("serial-console")).toContainText("LED on");
  if (info.project.name === "desktop") await expect(page.getByTestId("live-code")).toContainText("firmware/main.ino");
  await shot(page, info, "replay-done");
  // Local Run is disabled while showing a session.
  expect(await page.evaluate(() => (window as unknown as { jumper: { engine: { isExternal: boolean } } }).jumper.engine.isExternal)).toBe(true);
});

test("explains a missing action log", async ({ page }) => {
  await page.goto(`/?replay=${encodeURIComponent("/nope/actions.jsonl")}`);
  await expect(page.getByTestId("live-caption")).toContainText("Could not load the action log");
});
