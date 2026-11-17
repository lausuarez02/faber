// Records a physics demo video frame by frame in VIRTUAL time (deterministic, independent of the
// machine's speed): each frame advances the simulation by 1/fps s, then takes a screenshot.
// Start Vite first:  pnpm --filter @fabwright/web exec vite --port 5199
// Then:              node apps/web/src/renderers/physics/demo/record.mjs rover 30
//                    node apps/web/src/renderers/physics/demo/record.mjs arm 10
// Writes examples/<example>/media/<name>.mp4 (H.264) and a short .gif preview.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const which = process.argv[2] === "arm" ? "arm" : "rover";
const seconds = Number(process.argv[3] ?? (which === "arm" ? 10 : 30));
const base = process.argv[4] ?? "http://localhost:5199";
const fps = 30;
const repo = resolve(fileURLToPath(new URL("../../../../../../", import.meta.url)));
const exampleDir = join(repo, "examples", which === "arm" ? "robot-arm" : "rover", "media");
const name = which === "arm" ? "robot-arm" : "rover";
const tmp = mkdtempSync(join(tmpdir(), "fabwright-physics-"));
const size = { width: 1280, height: 720 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: size, colorScheme: "dark", deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(`${base}/src/renderers/physics/demo/index.html?example=${which}&manual`);
await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
await page.evaluate(() => document.fonts.ready);
const frames = Math.round(seconds * fps);
for (let i = 0; i < frames; i++) {
  if (i > 0) await page.evaluate((ms) => window.__fabwrightDemo.step(ms), 1000 / fps);
  await page.screenshot({ path: join(tmp, `f${String(i).padStart(5, "0")}.png`) });
  if (i % 150 === 0) console.log(`frame ${i}/${frames}`);
}
const stats = await page.evaluate(() => {
  const d = window.__fabwrightDemo;
  return { tMs: d.sim.timeMs, ...d.phys.stats() };
});
await browser.close();

mkdirSync(exampleDir, { recursive: true });
const mp4 = join(exampleDir, `${name}.mp4`);
const gif = join(exampleDir, `${name}.gif`);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(tmp, "f%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", mp4], { stdio: "inherit" });
// GIF preview: first 8 s at 2× speed, 12 fps, 720 px wide.
const vf = "setpts=0.5*PTS,fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-t", String(Math.min(seconds, 16)), "-framerate", String(fps), "-i", join(tmp, "f%05d.png"), "-vf", vf, "-loop", "0", gif], { stdio: "inherit" });
rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify(stats));
console.log(`${mp4} ${(statSync(mp4).size / 1024).toFixed(0)} KB · ${gif} ${(statSync(gif).size / 1024).toFixed(0)} KB`);
