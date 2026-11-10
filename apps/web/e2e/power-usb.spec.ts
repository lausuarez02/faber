// Round 6, track power (decision 0004, R2): the pocket Muse served by `jumper serve` runs in the page
// from its LiPo with USB unplugged; the power pill shows the battery's volts, current and time left;
// plugging USB in takes the load off the cell; the slide switch cuts the power and the firmware stops.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectAttrWithinSimTime, hubPort, shot } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse", import.meta.url));

test.describe("pocket Muse on battery power", () => {
  let dir = "";
  let home = "";
  let hub: ChildProcess | undefined;
  let port = 0;

  test.beforeEach(async ({}, info) => {
    dir = mkdtempSync(join(tmpdir(), "jumper-e2e-muse-"));
    home = mkdtempSync(join(tmpdir(), "jumper-e2e-home-"));
    cpSync(MUSE, dir, { recursive: true });
    const env = { ...process.env, JUMPER_HOME: home, JUMPER_AI_GATEWAY_PORT: "0" };
    port = hubPort(info, 9);
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env });
    await expect
      .poll(async () => (await fetch(`http://localhost:${port}/api/project`).catch(() => undefined))?.status ?? 0, { timeout: 60_000 })
      .toBe(200);
  });

  test.afterEach(() => {
    hub?.kill();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("runs from the LiPo, USB takes the load off it, the switch cuts the power", async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.goto(`http://localhost:${port}/?local`);
    await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready", { timeout: 30_000 });
    const pill = page.getByTestId("power-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("data-usb", "unplugged");
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("sim-error")).toHaveCount(0);
    const bat = page.getByTestId("part-bat");
    const xiao = page.getByTestId("part-xiao");
    // The cell carries the board and the screen (tens of mA) and the reading says so.
    await expectAttrWithinSimTime(page, xiao, "data-state-powered", "true", 1000);
    await expectAttrWithinSimTime(page, bat, "data-state-currentm-a", /^(2\d|3\d|4\d|5\d|6\d)(\.\d+)?$/, 2000);
    await expect(page.getByTestId("power-reading")).toHaveText(/4\.\d\d V · \d+ mA · ~\d+ h/, { timeout: 10_000 });
    await shot(page, info, "power-battery");

    // Plug USB in: the diode blocks, the cell gives nothing, the board stays on.
    await page.getByTestId("power-usb").click();
    await expect(pill).toHaveAttribute("data-usb", "plugged");
    await expectAttrWithinSimTime(page, bat, "data-state-currentm-a", /^-?0(\.\d+)?$/, 500);
    await expect(xiao).toHaveAttribute("data-state-powered", "true");

    // Unplug again and switch the power switch off: no power, the firmware is held in reset.
    await page.getByTestId("power-usb").click();
    await expect(pill).toHaveAttribute("data-usb", "unplugged");
    // The switch is off-screen in the fitted view: press it the way a click on the part does.
    await page.evaluate(() => (window as unknown as { jumper: { engine: { interact(id: string, kind: "press"): void } } }).jumper.engine.interact("pwr", "press"));
    await expect(page.getByTestId("part-pwr")).toHaveAttribute("data-state-position", "1");
    await expectAttrWithinSimTime(page, xiao, "data-state-powered", "false", 500);
    await expect(pill).toHaveAttribute("data-powered", "false", { timeout: 5_000 });
    await expect(page.getByTestId("power-reading")).toHaveText(/no power/);
    await shot(page, info, "power-off");
  });
});
