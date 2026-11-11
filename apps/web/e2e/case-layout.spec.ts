import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

// Round 8 (view): the Case view shows how the parts are distributed inside, on the talking egg a
// real Claude built in round 7 (10 parts in the case). Three proposals with front and side drawings,
// a 3D preview, "Use" builds it, dragging a part pins it and the rest re-arranges with the new size,
// and the parts advice applies a swap. Real `jumper serve`, real layouts and CAD on the server.
const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const EGG = readFileSync(fileURLToPath(new URL("../../../packages/session/test/fixtures/talking-egg-2.json", import.meta.url)), "utf8");

async function serve(info: TestInfo): Promise<{ url: string; dir: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "jumper-e2e-layout-"));
  const dir = join(root, "egg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jumper.json"), EGG);
  const port = hubPort(info, 2);
  const proc: ChildProcess = spawn(process.execPath, [CLI, "serve", "--project", dir, "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JUMPER_HOME: join(root, "home"), JUMPER_CASE_PDF: "0" } });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`jumper serve did not start in 40 s:\n${log}`)), 40_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes("MCP:")) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`jumper serve exited with ${code}:\n${log}`)));
  });
  return {
    url: `http://localhost:${port}`,
    dir,
    async close() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once("exit", r));
        proc.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
        // (a server busy in CAD may not get to SIGTERM: do not leave it running into the next specs)
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function openCase(page: Page, info: TestInfo): Promise<void> {
  if (info.project.name === "mobile") {
    await page.getByTestId("phone-menu").click();
    await page.getByTestId("phone-case").click();
  } else await page.getByTestId("toggle-case").click();
  await expect(page.getByTestId("case-view")).toBeVisible();
}

const saved = (dir: string) => JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8"));

test("Case view, Layout: see how the parts are distributed, preview one in 3D, use it, drag a part to pin it, apply a smaller part", async ({ page }, info) => {
  test.setTimeout(600_000);
  const s = await serve(info);
  try {
    await page.goto(`${s.url}/`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    const home = page.getByTestId("projects-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await home.getByTestId("projects-close").click();
    await openCase(page, info);
    // the egg's case is built on open (real CAD, it has domed faces)
    await expect(page.getByTestId("case-size")).toContainText(/\d+(\.\d)? × \d+(\.\d)? × \d+(\.\d)? mm/, { timeout: 180_000 });
    await expect(page.getByTestId("case-open-layout")).toContainText(/Parts inside: .*mm thick/, { timeout: 60_000 });

    // the Layout tab: three proposals, each drawn from the front and from the side
    await page.getByTestId("case-tab-layout").click();
    await expect(page.getByTestId("case-tab-layout")).toHaveAttribute("aria-selected", "true");
    const lay = page.getByTestId("case-layouts");
    await expect(lay.getByRole("radio")).toHaveCount(3, { timeout: 60_000 });
    for (const id of ["thinnest", "smallest", "balanced"]) {
      await expect(page.getByTestId(`case-layout-${id}`).locator("svg")).toBeVisible();
      await expect(page.getByTestId(`case-layout-thick-${id}`)).toContainText(/\d+(\.\d)? mm thick/);
      await expect(page.getByTestId(`case-layout-size-${id}`)).toContainText(/× \d+(\.\d)? mm · \d layers? · parts fill \d+ % of the inside/);
    }
    // the built case is Jumper's pick (auto = balanced), and the card says so
    await expect(page.getByTestId("case-layout-balanced")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("case-layout-balanced")).toContainText("built");
    await expect(page.getByTestId("case-layout-built-note")).toBeVisible();
    // the 3D view shows the proposal: parts as boxes inside the see-through shell
    await expect(page.getByTestId("case-preview-note")).toContainText(/× .* mm · the parts as boxes inside the shell/);
    // no tool names anywhere a person reads
    await expect(page.getByTestId("case-view")).not.toContainText(/propose_layout|update_case|design_case|place_part|check_design/);
    await shot(page, info, "layout-tab");

    // select the thinnest: keyboard works on the cards like any radio group
    const thin = page.getByTestId("case-layout-thinnest");
    await thin.click();
    await expect(thin).toHaveAttribute("aria-checked", "true");
    const thinD = Number((await page.getByTestId("case-layout-thick-thinnest").innerText()).match(/[\d.]+/)![0]);
    await expect(page.getByTestId("case-preview-note")).toContainText("not built yet");
    await thin.press("ArrowDown");
    await expect(page.getByTestId("case-layout-smallest")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("case-layout-smallest").press("ArrowUp");
    await expect(thin).toHaveAttribute("aria-checked", "true");
    await shot(page, info, "layout-thinnest-preview");
    // use it: the case is rebuilt that way
    await page.getByTestId("case-layout-use").click();
    await expect(page.getByTestId("case-layout-built-note")).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId("case-size")).toContainText(new RegExp(`× ${thinD} mm`));
    expect(saved(s.dir).enclosure.layout).toBe("thinnest");
    await expect(thin).toContainText("built");

    // drag a part in the front view: it stays where it is dropped and the rest re-arranges
    const editor = page.getByTestId("case-front-editor");
    await editor.scrollIntoViewIfNeeded();
    const bat = page.getByTestId("case-part-bat");
    const sizeBefore = await page.getByTestId("case-layout-newsize").innerText();
    // drop it somewhere free: a spot on a part that stays put is refused with a reason, and a spot
    // where the rest cannot fit sends it back with a reason; both say what to do
    let moved = false;
    let before = await bat.locator("rect").boundingBox();
    for (const [dx, dy] of [[14, -10], [-14, -10], [14, 10], [-14, 10], [24, 0], [-24, 0]] as const) {
      before = await bat.locator("rect").boundingBox();
      await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
      await page.mouse.down();
      await page.mouse.move(before!.x + before!.width / 2 + dx, before!.y + before!.height / 2 + dy, { steps: 6 });
      await page.mouse.up();
      await expect(page.getByTestId("case-layout-newsize")).not.toContainText("Re-arranging", { timeout: 60_000 });
      await page.waitForTimeout(800);
      await expect(page.getByTestId("case-layout-newsize")).not.toContainText("Re-arranging", { timeout: 60_000 });
      if (await page.getByTestId("case-layout-notice").isVisible()) {
        await expect(page.getByTestId("case-layout-notice")).toContainText(/bat (would land on|went back)/);
        continue;
      }
      if ((await page.getByTestId("case-pins").textContent())?.includes("bat moved by you")) {
        moved = true;
        break;
      }
    }
    expect(moved).toBe(true);
    const after = await bat.locator("rect").boundingBox();
    expect(Math.abs(after!.x - before!.x) + Math.abs(after!.y - before!.y)).toBeGreaterThan(4);
    const sizeAfter = await page.getByTestId("case-layout-newsize").innerText();
    expect(sizeAfter).toMatch(/\d+(\.\d)? × \d+(\.\d)? × \d+(\.\d)? mm/);
    test.info().annotations.push({ type: "size", description: `${sizeBefore} → ${sizeAfter}` });
    // every part is still inside (none dropped)
    await expect(page.getByTestId("case-front-editor").locator("[data-testid^=case-part-]")).toHaveCount(10);
    // a part moved with the keyboard too
    await page.getByTestId("case-part-voice").focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await expect
      .poll(async () => `${(await page.getByTestId("case-pins").textContent()) ?? ""} ${(await page.getByTestId("case-layout-notice").count()) ? await page.getByTestId("case-layout-notice").textContent() : ""}`, { timeout: 60_000 })
      .toMatch(/voice (moved by you|would land|went back)/);
    await expect(page.getByTestId("case-layout-newsize")).not.toContainText("Re-arranging", { timeout: 60_000 });
    await shot(page, info, "layout-pinned");
    // let Jumper place the voice again, then build with the battery where it was put
    if (await page.getByRole("button", { name: "Let Jumper place voice again" }).isVisible()) await page.getByRole("button", { name: "Let Jumper place voice again" }).click();
    await expect(page.getByTestId("case-pins")).not.toContainText("voice");
    await expect(page.getByTestId("case-layout-newsize")).not.toContainText("Re-arranging", { timeout: 60_000 });
    const use = page.getByTestId("case-layout-use");
    if (await use.isVisible()) {
      await expect(use).toBeEnabled({ timeout: 60_000 });
      await use.click();
      await expect(page.getByTestId("case-layout-built-note")).toBeVisible({ timeout: 300_000 });
    }
    const enc = saved(s.dir).enclosure;
    expect(typeof enc.placements.bat.x_mm).toBe("number");
    expect(enc.placements.voice?.x_mm).toBeUndefined();
    expect(enc.placements.spk.face).toBe("back"); // the agent's own placements are kept

    // the parts advice: a smaller speaker, applied in one click
    const adv = page.getByTestId("case-advice-smaller-speaker");
    await adv.scrollIntoViewIfNeeded();
    await expect(adv).toContainText("Saves 384 mm² of room, 1 mm of thickness");
    await expect(page.getByTestId("case-advice-boost-not-needed")).toContainText("Saves 612 mm² of room");
    await shot(page, info, "layout-advice");
    await page.getByTestId("case-advice-apply-smaller-speaker").click();
    await expect(page.getByTestId("case-advice-done")).toContainText("spk is now a 20 mm speaker");
    await expect(page.getByTestId("case-advice-smaller-speaker")).toHaveCount(0);
    expect(saved(s.dir).parts.find((p: { id: string }) => p.id === "spk").type).toBe("speaker-20mm");
    // the case follows the new part
    await expect(page.getByTestId("case-size")).toContainText(/mm/, { timeout: 180_000 });
  } finally {
    await s.close();
  }
});
