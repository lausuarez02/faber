// Records the reference examples running in the web app (1440x900, dark) and writes
// docs/media/example-<name>.mp4 (H.264) and .gif (<4 MB) with ffmpeg. Start the app first
// (`pnpm dev`), then:
//   node apps/web/scripts/record-examples.mjs [http://localhost:5173] [tamagotchi rover robot-arm]
// Every interaction goes through the visible UI (select the part, hold the inspector's press
// button, drag the knob's slider), so the video shows what a person can do.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://localhost:5173";
const only = process.argv.slice(3);
const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const outDir = join(repo, "docs/media");
const size = { width: 1440, height: 900 };

/** Select a part on the canvas so the inspector shows its controls. */
async function select(page, id) {
  // Point at the part, then select it through the store (a wire over the part can catch the click).
  const box = await page.getByTestId(`part-${id}`).boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.evaluate((p) => window.faber.store.getState().select([p], []), id);
  await page.waitForTimeout(250);
}

/** Hold the inspector's press button for `ms`. */
async function press(page, id, ms = 180) {
  await select(page, id);
  const b = page.getByTestId("press-button");
  const box = await b.boundingBox();
  if (!box) throw new Error(`no press button for ${id}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Move a part's numeric prop smoothly (the inspector slider follows). */
async function sweep(page, id, prop, from, to, ms) {
  const steps = Math.max(2, Math.round(ms / 50));
  for (let i = 0; i <= steps; i++) {
    const v = from + ((to - from) * i) / steps;
    await page.evaluate(([p, k, val]) => window.faber.store.getState().setPartProp(p, k, val), [id, prop, v]);
    await page.waitForTimeout(ms / steps);
  }
}

async function speed(page, x) {
  await page.getByTestId("speed-select").selectOption(String(x));
}

const scripts = {
  async tamagotchi(page) {
    // Zoom toward the screen and the buttons so the pet is big enough to see.
    const oled = await page.getByTestId("part-oled").boundingBox();
    if (oled) {
      await page.mouse.move(oled.x + oled.width / 2 - 120, oled.y + oled.height + 20, { steps: 6 });
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(120);
      }
    }
    await page.waitForTimeout(3000); // the pet hatches, bounces and blinks
    await press(page, "btnFeed");
    await page.waitForTimeout(2500);
    await press(page, "btnPlay");
    await page.waitForTimeout(2200);
    await press(page, "btnPlay");
    await page.waitForTimeout(2500);
    await press(page, "btnSleep"); // dims, Zzz
    await page.waitForTimeout(3500);
    await press(page, "btnSleep"); // wake
    await page.waitForTimeout(2500);
    // Neglect it: fast-forward until a stat drops under 20 (sad face, alarm beeps).
    await select(page, "oled");
    await speed(page, 8);
    await page.waitForFunction(() => /mood=sad|needs care|I need you/.test(window.faber.engine.serialText), undefined, { timeout: 90_000 });
    await speed(page, 1);
    await page.waitForTimeout(3500);
    await press(page, "btnFeed");
    await page.waitForTimeout(2500);
  },
  async rover(page) {
    await speed(page, 2);
    await page.waitForTimeout(24_000); // about 48 virtual seconds in the arena
  },
  async "robot-arm"(page) {
    await page.waitForTimeout(2000);
    await select(page, "potS");
    await sweep(page, "potS", "position", 0.5, 0.9, 2500);
    await page.waitForTimeout(600);
    await sweep(page, "potS", "position", 0.9, 0.2, 3000);
    await page.waitForTimeout(600);
    await select(page, "potE");
    await sweep(page, "potE", "position", 0.5, 1, 2200);
    await page.waitForTimeout(600);
    await sweep(page, "potE", "position", 1, 0.1, 2500);
    await page.waitForTimeout(600);
    // Inverse kinematics for the cup (the reaches-the-cup scenario): shoulder 0.187, elbow 0.
    await select(page, "potS");
    await sweep(page, "potS", "position", 0.2, 0.187, 600);
    await select(page, "potE");
    await sweep(page, "potE", "position", 0.1, 0, 800);
    await page.waitForTimeout(3500);
  },
};

const names = only.length ? only : Object.keys(scripts);
const browser = await chromium.launch();
for (const name of names) {
  const tmp = mkdtempSync(join(tmpdir(), "faber-example-"));
  const ctx = await browser.newContext({ viewport: size, colorScheme: "dark", deviceScaleFactor: 1, recordVideo: { dir: tmp, size } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${url}/?example=${name}`);
  await page.waitForSelector('[data-testid="app"][data-firmware="ready"]', { timeout: 30_000 });
  await page.waitForTimeout(800);
  const lead = (Date.now() - t0) / 1000; // page load, trimmed from the video
  await page.getByTestId("run-button").click();
  await scripts[name](page);
  await ctx.close();
  const webm = join(tmp, readdirSync(tmp).find((f) => f.endsWith(".webm")));
  mkdirSync(outDir, { recursive: true });
  const mp4 = join(outDir, `example-${name}.mp4`);
  const gif = join(outDir, `example-${name}.gif`);
  const ss = String(Math.max(0, lead - 0.3));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", ss, "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", "-preset", "slow", "-tune", "animation", "-movflags", "+faststart", "-an", mp4], { stdio: "inherit" });
  const vf = "setpts=PTS/2,fps=8,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", ss, "-i", webm, "-vf", vf, "-loop", "0", gif], { stdio: "inherit" });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${mp4} ${(statSync(mp4).size / 1024).toFixed(0)} KB; ${gif} ${(statSync(gif).size / 1024).toFixed(0)} KB`);
}
await browser.close();
