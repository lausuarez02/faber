import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectWithinSimTime, hubPort, openSerial, shot, simTimeMs, waitForSimTime } from "./helpers.ts";
import { EXAMPLES, FIXTURES, center, freshHex, openAndRun, overlaps, partState, partXY, selected, serialText, serve, viewTransform } from "./canvas-serve.ts";

// Round 6, canvas track (decision 0004): while the device runs, a normal click presses a button
// (drawn pressed, at least 120 ms so the firmware sees it), a drag on the body or label still moves
// the part, knobs turn, an IMU tilts when dragged, the Live controls card stays docked, motions run
// on virtual time, serial follows the newest line, and the view is never reset by run / save.
// Real pointer events throughout (page.mouse).

test.describe.configure({ mode: "serial" });

test("a quick click presses a button the firmware sees; body and label drags still move parts; knobs turn", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "pointer drags are covered on desktop; phones share the handlers");
  const srv = await serve(join(EXAMPLES, "tamagotchi"), hubPort(info), (dir) => {
    const p = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")) as { parts: object[] };
    p.parts.push({ id: "pot1", type: "potentiometer", x: -260, y: 260, rotation: 0 });
    writeFileSync(join(dir, "jumper.json"), JSON.stringify(p, null, 2));
    freshHex(dir, "firmware/tamagotchi.hex");
  });
  try {
    await openAndRun(page, srv.ws, "btnSleep");
    await waitForSimTime(page, 1200);

    // The hit area is the cap, not the whole part.
    const part = (await page.getByTestId("part-btnSleep").boundingBox())!;
    const cap = (await page.getByTestId("control-btnSleep").boundingBox())!;
    expect(cap.width).toBeLessThan(part.width * 0.8);

    // A click with ~0 ms between down and up (the round-5 tester's mouse) still presses: the cap is
    // drawn pressed, the firmware prints "sleep", the part is neither moved nor selected.
    const before = await partXY(page, "btnSleep");
    const c = await center(page, "control-btnSleep");
    const serial0 = (await serialText(page)).length;
    await page.mouse.click(c.x, c.y);
    await expect(page.getByTestId("part-btnSleep")).toHaveAttribute("data-state-pressed", "true");
    await shot(page, info, "canvas-button-pressed");
    await expect(page.getByTestId("part-btnSleep")).toHaveAttribute("data-state-pressed", "false", { timeout: 5000 });
    await expectWithinSimTime(page, 1500, async () => /\b(sleep|wake)\b/.test((await serialText(page)).slice(serial0)), "a quick click on btnSleep should reach the firmware");
    expect(await partXY(page, "btnSleep")).toEqual(before);
    expect(await selected(page)).not.toContain("btnSleep");

    // Drag the body away from the cap (top edge, between the legs): the part moves, running or not.
    const play0 = (await partXY(page, "btnPlay"))!;
    const pb = (await page.getByTestId("part-btnPlay").boundingBox())!;
    await page.mouse.move(pb.x + pb.width / 2, pb.y + 4);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width / 2 + 40, pb.y + 4 + 30, { steps: 6 });
    await page.mouse.move(pb.x + pb.width / 2 + 80, pb.y + 4 + 60, { steps: 6 });
    await page.mouse.up();
    expect(await partState(page, "btnPlay")).toMatchObject({ pressed: false });
    await expect.poll(async () => (await partXY(page, "btnPlay"))![0]!).toBeGreaterThan(play0[0]! + 30);

    // The label is a drag handle too.
    const feed0 = (await partXY(page, "btnFeed"))!;
    const lb = (await page.getByTestId("label-btnFeed").boundingBox())!;
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await page.mouse.down();
    await page.mouse.move(lb.x + 30, lb.y - 40, { steps: 6 });
    await page.mouse.move(lb.x + 60, lb.y - 80, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await partXY(page, "btnFeed"))![1]!).toBeLessThan(feed0[1]! - 30);

    // Hold: pressed for as long as the pointer is down, even when it slides off the cap.
    const f = await center(page, "control-btnFeed");
    await page.mouse.move(f.x, f.y);
    await page.mouse.down();
    await page.mouse.move(f.x + 40, f.y + 30);
    await waitForSimTime(page, 400);
    expect((await partState(page, "btnFeed")).pressed).toBe(true);
    await page.mouse.up();
    await expect.poll(async () => (await partState(page, "btnFeed")).pressed).toBe(false);

    // Knob: a drag on the knob turns it, the potentiometer stays put.
    const pot0 = await partXY(page, "pot1");
    const k = await center(page, "control-pot1");
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x + 60, k.y, { steps: 5 });
    await page.mouse.move(k.x + 130, k.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Number((await partState(page, "pot1")).position)).toBeGreaterThan(0.95);
    expect(await partXY(page, "pot1")).toEqual(pot0);

    // Keyboard: Space on a focused cap presses (shortcuts still work).
    await page.getByTestId("control-btnSleep").focus();
    const serial1 = (await serialText(page)).length;
    await page.keyboard.press("Space");
    await expectWithinSimTime(page, 1500, async () => /\b(sleep|wake)\b/.test((await serialText(page)).slice(serial1)), "Space on btnSleep should reach the firmware");

    // Arrange: every part selects and drags as when stopped; the cap is not a control any more.
    await page.getByTestId("live-mode-arrange").click();
    await expect(page.getByTestId("control-btnSleep")).toHaveCount(0);
    const s0 = (await partXY(page, "btnSleep"))!;
    const sb = (await page.getByTestId("part-btnSleep").boundingBox())!;
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2 + 50, sb.y + sb.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await partXY(page, "btnSleep"))![0]!).toBeGreaterThan(s0[0]! + 20);
    await page.getByTestId("live-mode-use").click();
    await expect(page.getByTestId("control-btnSleep")).toHaveCount(1);
  } finally {
    await srv.stop();
  }
});

test("Pocket Muse: the docked Live controls never hide; dragging the IMU tilts it; Shake holds and plays on virtual time", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "pointer drags are covered on desktop; phones share the handlers");
  test.setTimeout(120_000);
  const srv = await serve(join(FIXTURES, "canvas-muse"), hubPort(info), (dir) => freshHex(dir, "firmware/main.hex"));
  try {
    await openAndRun(page, srv.ws, "imu");
    await waitForSimTime(page, 1500);
    const card = page.getByTestId("live-controls");
    await expect(card).toBeVisible();

    // Serial, the Inspector and Agent steps open: none of them covers the card.
    await openSerial(page);
    await page.getByTestId("label-xiao").click();
    await expect(page.getByTestId("inspector")).toBeVisible();
    const cb = (await card.boundingBox())!;
    // The column scrolls and clips its panels: what can cover the card is the column's own box.
    const col = (await page.getByTestId("panel-column").boundingBox())!;
    expect(overlaps(cb, col), "the panel column reaches into the Live controls card").toBe(false);
    for (const el of await page.locator(".network-card, .live-tests, .live-code").all()) {
      const b = await el.boundingBox();
      if (b) expect(overlaps(cb, b), "a card covers the Live controls card").toBe(false);
    }
    expect(cb.y + cb.height).toBeLessThanOrEqual(900);
    await shot(page, info, "canvas-live-docked");

    // Drag the IMU part itself: it tilts (the pad follows), it does not move.
    const imu0 = await partXY(page, "imu");
    const ib = (await page.getByTestId("part-imu").boundingBox())!;
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.mouse.down();
    await page.mouse.move(ib.x + ib.width / 2 + 30, ib.y + ib.height / 2, { steps: 4 });
    await page.mouse.move(ib.x + ib.width / 2 + 60, ib.y + ib.height / 2 - 20, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId("imu-read-imu")).toContainText("roll 30");
    await expect(page.getByTestId("imu-read-imu")).toContainText("pitch 10");
    await expect.poll(async () => Number((await partState(page, "imu")).accelX)).toBeLessThan(-0.3);
    expect(await partXY(page, "imu")).toEqual(imu0);

    // Shake, held: shakes for as long as it is held, then rests.
    const sh = await center(page, "imu-shake-imu");
    await page.mouse.move(sh.x, sh.y);
    await page.mouse.down();
    await waitForSimTime(page, 1200);
    await expect(page.getByTestId("imu-read-imu")).toContainText("shake");
    await page.mouse.up();
    await expect(page.getByTestId("imu-read-imu")).not.toContainText("shake", { timeout: 5000 });
    await expect.poll(async () => Number((await partState(page, "imu")).gyroZ)).toBe(0);

    // Shake, clicked with 0.5 s set: it lasts 0.5 s of virtual time, whatever the wall clock does.
    await page.getByTestId("imu-shake-ms-imu").selectOption("500");
    const t0 = await simTimeMs(page);
    await page.getByTestId("imu-shake-imu").click();
    await expect(page.getByTestId("imu-read-imu")).not.toContainText("shake", { timeout: 10_000 });
    const took = (await simTimeMs(page)) - t0;
    expect(took).toBeGreaterThanOrEqual(480);
    expect(took).toBeLessThan(1200);

    // Paused, a motion waits: virtual time does not move, so neither does the drop.
    await page.getByTestId("run-button").click(); // pause
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { jumper: { store: { getState(): { run: string } } } }).jumper.store.getState().run))).toBe("paused");
    await page.getByTestId("imu-drop-imu").click();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId("imu-read-imu")).toContainText("drop");
    await page.getByTestId("run-button").click(); // run again
    await expect(page.getByTestId("imu-read-imu")).not.toContainText("drop", { timeout: 10_000 });

    // A click on the IMU without a drag selects it; the Inspector wiring is the XIAO's.
    await page.mouse.click(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await expect.poll(() => selected(page)).toEqual(["imu"]);
    const wiring = page.getByTestId("inspector-wiring");
    await expect(wiring).toContainText("SDA → GP6 (D4/SDA)");
    await expect(wiring).toContainText("SCL → GP7 (D5/SCL)");
    await expect(page.getByTestId("part-inspector")).not.toContainText(/\bA4\b|\bA5\b/);
    await shot(page, info, "canvas-inspector-xiao");

    // Collapsible: the header stays, the body goes; the column takes the room back.
    await page.getByTestId("live-controls-toggle").click();
    await expect(card).toHaveAttribute("data-open", "false");
    await expect(page.getByTestId("imu-pad-imu")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

test("serial follows the newest line unless scrolled up; the view survives run, pause and panels", async ({ page }, info) => {
  const srv = await serve(join(EXAMPLES, "tamagotchi"), hubPort(info), (dir) => freshHex(dir, "firmware/tamagotchi.hex"));
  try {
    await page.goto(`/?follow=${encodeURIComponent(srv.ws)}`);
    await expect(page.getByTestId("part-btnSleep")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(700); // first fit
    // The person zooms in (wheel on desktop, the zoom shortcut on phones).
    const phone = info.project.name === "mobile";
    if (phone) {
      await page.keyboard.press("=");
    } else {
      await page.mouse.move(500, 400);
      await page.mouse.wheel(0, -300);
    }
    await page.waitForTimeout(600);
    const zoomed = await viewTransform(page);

    await page.getByTestId("run-button").click();
    await expect.poll(async () => page.evaluate(() => (window as unknown as { jumper: { store: { getState(): { run: string } } } }).jumper.store.getState().run), { timeout: 20_000 }).toBe("running");
    await openSerial(page);
    await waitForSimTime(page, 8000);
    const con = page.getByTestId("serial-console");
    const gap = () => con.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(gap).toBeLessThan(24);
    await expect(con).toHaveAttribute("data-following", "true");

    // Scrolled up to read: stays put while lines arrive, a Newest button jumps back.
    await con.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(con).toHaveAttribute("data-following", "false");
    await waitForSimTime(page, 4000);
    expect(await con.evaluate((el) => el.scrollTop)).toBe(0);
    await page.getByTestId("serial-newest").click();
    await expect(con).toHaveAttribute("data-following", "true");
    await waitForSimTime(page, 2000);
    await expect.poll(gap).toBeLessThan(24);

    // Run, serial and the Live controls card did not move the view; neither do pause and run.
    await page.getByTestId("run-button").click();
    await page.getByTestId("run-button").click();
    await page.waitForTimeout(800);
    expect(await viewTransform(page)).toBe(zoomed);
    await shot(page, info, "canvas-view-kept");
  } finally {
    await srv.stop();
  }
});

test("canvas labels show the short id only and never overlap; the full name is in the hover title", async ({ page }, info) => {
  const srv = await serve(join(EXAMPLES, "ai-pet"), hubPort(info));
  try {
    await page.goto(`/?follow=${encodeURIComponent(srv.ws)}`);
    await expect(page.getByTestId("part-btnTalk")).toBeVisible({ timeout: 15_000 });
    const ids = ["btnTalk", "btnFeed", "btnPlay", "buzzer"];
    const label = page.getByTestId("label-btnTalk");
    await expect(label).toHaveText("btnTalk");
    await expect(label).toHaveAttribute("title", "btnTalk · Pushbutton (6 mm tactile)");
    await page.getByTestId("part-btnTalk").hover();
    await expect(label).toHaveText("btnTalk"); // hover does not widen it over the neighbour
    const boxes = await Promise.all(ids.map(async (id) => (await page.getByTestId(`label-${id}`).boundingBox())!));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), `${ids[i]} / ${ids[j]} labels overlap`).toBe(false);
  } finally {
    await srv.stop();
  }
});

test("AI pet: a quick click on TALK asks the pet, and its reply bubble stays readable for at least 4 s", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "covered on desktop; the bubble is the firmware's");
  test.setTimeout(120_000);
  const srv = await serve(join(EXAMPLES, "ai-pet"), hubPort(info), (dir) => freshHex(dir, "firmware/ai-pet.hex"));
  try {
    await openAndRun(page, srv.ws, "btnTalk");
    // Joined the sandbox Wi-Fi first.
    await expectWithinSimTime(page, 15_000, async () => /wifi: online|joined|wifi=1/.test(await serialText(page)), "the pet should join JumperNet");
    const n0 = (await serialText(page)).length;
    const c = await center(page, "control-btnTalk");
    await page.mouse.click(c.x, c.y);
    await expectWithinSimTime(page, 1000, async () => /ask a=talk/.test((await serialText(page)).slice(n0)), "a quick click on TALK should ask the pet AI");
    // The reply (not the "..." placeholder) lands in a white bubble.
    // "bubble: <text>" is printed once the reply's bubble is drawn (after "reply 200 ...").
    await expectWithinSimTime(page, 8000, async () => /reply 200 [^\n]*\r?\n(?:[^\n]*\r?\n)*?bubble: /.test((await serialText(page)).slice(n0)), "the pet AI should answer in a bubble");
    const shown = await simTimeMs(page);
    await expect.poll(async () => Number((await partState(page, "tft")).bright)).toBeGreaterThan(10_000);
    await shot(page, info, "canvas-pet-bubble");
    // Readable for >= 4 s of virtual time (the sketch keeps it 7 s, or until the next reply).
    for (;;) {
      const t = await simTimeMs(page);
      expect(Number((await partState(page, "tft")).bright), `bubble gone after ${t - shown} virtual ms`).toBeGreaterThan(10_000);
      if (t - shown >= 4000) break;
      await page.waitForTimeout(150);
    }
  } finally {
    await srv.stop();
  }
});

test("project switch (R8): opening another project drops live values, Arrange and selection, and gives the view back; reload keeps them", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "store-level reset; same code on phones");
  const srv = await serve(join(EXAMPLES, "tamagotchi"), hubPort(info), (dir) => freshHex(dir, "firmware/tamagotchi.hex"));
  try {
    await openAndRun(page, srv.ws, "btnSleep");
    await page.mouse.move(500, 400);
    await page.mouse.wheel(0, -200); // the person zooms: the view is theirs
    await page.getByTestId("live-mode-arrange").click();
    await page.getByTestId("part-btnSleep").click();
    await expect.poll(() => selected(page)).toEqual(["btnSleep"]);
    const state = () =>
      page.evaluate(async () => {
        const load = (path: string) => import(/* @vite-ignore */ path) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const ix = await load("/src/interact/store.ts");
        const act = await load("/src/shell/actions.ts");
        return { arrange: ix.useInteract.getState().arrange as boolean, kept: act.isViewKept() as boolean };
      });
    expect(await state()).toEqual({ arrange: true, kept: true });
    // The switch track emits "reload" after a restore: nothing of the person's goes away.
    await page.evaluate(async () => (await (import(/* @vite-ignore */ "/src/lib/projectSwitch.ts" as string) as Promise<{ emitProjectSwitch(s: object): void }>)).emitProjectSwitch({ id: undefined, reason: "reload" }));
    expect(await state()).toEqual({ arrange: true, kept: true });
    expect(await selected(page)).toEqual(["btnSleep"]);
    // "open": another project.
    await page.evaluate(async () => (await (import(/* @vite-ignore */ "/src/lib/projectSwitch.ts" as string) as Promise<{ emitProjectSwitch(s: object): void }>)).emitProjectSwitch({ id: "other", reason: "open" }));
    expect(await state()).toEqual({ arrange: false, kept: false });
    expect(await selected(page)).toEqual([]);
  } finally {
    await srv.stop();
  }
});
