import { writeFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openCanvas, requireFastWebGL, SHOTS } from "./helpers.ts";

// 200 parts on the canvas while Blink runs: the Uno, 66 resistor + LED pairs all driven from D13
// (so every Blink edge re-solves a ~200-node circuit and repaints 66 LEDs), plus 67 spare parts.
// Measures real frame intervals with requestAnimationFrame and writes them to test-results/perf.json.
// A frame-rate benchmark of the GPU compositor: @gpu, so it skips on CI runners with software WebGL
// (see requireFastWebGL in helpers.ts; FABWRIGHT_E2E_GPU=1 forces it).
test("perf: 200 parts while Blink runs @gpu", async ({ page }) => {
  test.setTimeout(90_000);
  await requireFastWebGL(page);
  await openCanvas(page);
  await expect(page.getByTestId("app")).toHaveAttribute("data-firmware", "ready");

  const count = await page.evaluate(() => {
    const { store } = (window as unknown as { fabwright: { store: { getState(): any } } }).fabwright;
    const s = store.getState();
    const base = s.project;
    const parts = [base.parts.find((p: any) => p.type === "arduino-uno")];
    const wires: any[] = [];
    const spare = ["pushbutton", "slide-switch", "potentiometer", "photoresistor", "buzzer", "rgb-led"];
    let w = 0;
    for (let i = 0; i < 66; i++) {
      const col = i % 11, row = Math.floor(i / 11);
      const x = 640 + col * 130, y = row * 120;
      parts.push({ id: `r${i}`, type: "resistor", x, y: y + 90, rotation: 0, props: { resistance: 1000 } });
      parts.push({ id: `led${i}`, type: "led", x: x + 40, y, rotation: 0, props: { color: ["red", "green", "yellow", "blue"][i % 4] } });
      wires.push({ id: `w${w++}`, from: { part: "uno", pin: "D13" }, to: { part: `r${i}`, pin: "1" } });
      wires.push({ id: `w${w++}`, from: { part: `r${i}`, pin: "2" }, to: { part: `led${i}`, pin: "A" } });
      wires.push({ id: `w${w++}`, from: { part: `led${i}`, pin: "C" }, to: { part: "uno", pin: "GND.1" } });
    }
    for (let i = 0; parts.length < 200; i++) {
      parts.push({ id: `x${i}`, type: spare[i % spare.length], x: (i % 12) * 110, y: 660 + Math.floor(i / 12) * 120, rotation: 0 });
    }
    s.loadProject({ ...base, parts, wires });
    return parts.length;
  });
  expect(count).toBe(200);
  await expect(page.locator(".react-flow__node")).toHaveCount(200, { timeout: 15_000 });
  await page.getByTestId("rail-more").click();
  await page.getByTestId("menu-fit").click();

  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  const idle = await measureFrames(page, 3000);
  await page.getByTestId("run-button").click();
  await page.waitForTimeout(1000); // warm up
  const stats = await measureFrames(page, 5000);
  const simClock = await page.getByTestId("sim-clock").textContent();
  const simFactor = await page.getByTestId("sim-factor").textContent();
  const lit = await page.locator('[data-lit="true"]').count();
  await page.screenshot({ path: `${SHOTS}/desktop-perf-200.png` });
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/perf.json",
    JSON.stringify({ parts: 200, gpu, running: stats, idle, simClock, simFactor }, null, 2),
  );
  console.log(`[perf] renderer: ${gpu}`);
  console.log(`[perf] 200 parts idle: ${idle.fps.toFixed(1)} fps, p95 ${idle.p95.toFixed(1)} ms, max ${idle.max.toFixed(1)} ms`);
  console.log(
    `[perf] 200 parts running: ${stats.fps.toFixed(1)} fps, p50 ${stats.p50.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, max ${stats.max.toFixed(1)} ms; sim ${simClock} at ${simFactor}; lit now: ${lit}`,
  );
  await expect(page.getByTestId("sim-error")).toHaveCount(0);

  // The bar from docs/brief.md is 60 fps with 200 parts. Locally (a real GPU) we hold it:
  // at least 58 fps on average and 95 % of frames inside one 60 Hz vsync (16.7 ms + jitter).
  // Shared CI runners have no GPU and composite in software, so CI only guards against a
  // collapse; the numbers are still written to perf.json and the job log.
  const bar = process.env.CI ? { fps: 30, p95: 50 } : { fps: 58, p95: 17.5 };
  expect(idle.fps, "idle fps").toBeGreaterThanOrEqual(bar.fps);
  expect(idle.p95, "idle p95 frame (ms)").toBeLessThanOrEqual(bar.p95);
  expect(stats.fps, "running fps").toBeGreaterThanOrEqual(bar.fps);
  expect(stats.p95, "running p95 frame (ms)").toBeLessThanOrEqual(bar.p95);
});

interface FrameStats {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  max: number;
}

/** Real frame intervals over `ms` of wall time, from requestAnimationFrame timestamps. */
function measureFrames(page: Page, ms: number): Promise<FrameStats> {
  return page.evaluate(
    (ms) =>
      new Promise<FrameStats>((resolve) => {
        const ts: number[] = [];
        const end = performance.now() + ms;
        const tick = (t: number) => {
          ts.push(t);
          if (t < end) requestAnimationFrame(tick);
          else {
            const d = ts.slice(1).map((v, i) => v - ts[i]!).sort((a, b) => a - b);
            const q = (p: number) => d[Math.min(d.length - 1, Math.floor(p * d.length))]!;
            resolve({ frames: d.length, fps: (d.length * 1000) / (ts.at(-1)! - ts[0]!), p50: q(0.5), p95: q(0.95), max: d.at(-1)! });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}
