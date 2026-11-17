// Records the M0 demo: the Blink example running on the canvas, then converts it to
// docs/media/m0-blink.gif with ffmpeg. Start the app first (`pnpm dev`), then:
//   node apps/web/scripts/record-demo.mjs [http://localhost:5173]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://localhost:5173";
const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const outDir = join(repo, "docs/media");
const gif = join(outDir, "m0-blink.gif");
const still = join(outDir, "m0-blink.png");
const size = { width: 1200, height: 720 };
const tmp = mkdtempSync(join(tmpdir(), "fabwright-demo-"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: size, colorScheme: "dark", recordVideo: { dir: tmp, size } });
const page = await ctx.newPage();
await page.goto(url);
await page.waitForSelector('[data-testid="app"][data-firmware="ready"]');
await page.waitForTimeout(700);
await page.click('[data-testid="run-button"]');
await page.waitForSelector('[data-testid="part-led1"][data-lit="true"]');
await page.waitForTimeout(500);
await page.screenshot({ path: still });
await page.waitForTimeout(4200); // a few full blink cycles
await ctx.close();
await browser.close();

const webm = join(tmp, readdirSync(tmp).find((f) => f.endsWith(".webm")));
mkdirSync(outDir, { recursive: true });
// Trim the page load, 12 fps, 900 px wide, palette tuned for the dark UI.
const vf = "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1.0", "-i", webm, "-vf", vf, "-loop", "0", gif], { stdio: "inherit" });
rmSync(tmp, { recursive: true, force: true });
console.log(`${gif} ${(statSync(gif).size / 1024).toFixed(0)} KB, still ${still}`);
