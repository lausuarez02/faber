// Headless Device view renders: the project as the physical device in 3D (handheld with its live
// screen, rover in its arena, arm on its table), as PNGs at chosen virtual times, or as a frame
// sequence for a video. Same scene as the web app's Device view: it drives the dev page
// apps/web/src/views/device/dev/index.html in Chromium (Playwright) with the real firmware.
//
//   node --import tsx packages/session/src/device-render.ts <project dir> --ms 2500,6000 [--out dir]
//        [--size 1280x800] [--press btnFeed@1500] [--every 100 --until 8000] [--no-hud] [--camera chase]
//        [--url http://localhost:5173]
//
// Without --url it starts the web app's Vite dev server itself (port picked by the OS) and stops it
// after. Agents get it as screenshot {view: "device", ms}; the CLI as fabwright render-device.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadProjectDir } from "./visual-report.ts";

const WEB_DIR = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
const PAGE = "src/views/device/dev/index.html";

export interface DeviceRenderOptions {
  /** Project folder (fabwright.json + built firmware). */
  dir: string;
  /** Virtual ms to capture at (sorted ascending). */
  shots: number[];
  /** Button presses: part id and virtual ms; held `holdMs` (default 120). */
  presses?: { part: string; at: number; holdMs?: number }[];
  width?: number;
  height?: number;
  /** Show the floating HUD (readouts, time). Default true. */
  hud?: boolean;
  /** Rover camera: track (default), chase, arena. */
  camera?: "track" | "chase" | "arena";
  /** A running web dev server (http://localhost:5173); otherwise one is started. */
  url?: string;
  /** Called per frame (for streaming to disk / ffmpeg) instead of collecting all buffers. */
  onShot?: (png: Buffer, ms: number, i: number) => void;
}

interface Page {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, o?: object): Promise<unknown>;
  evaluate<T>(fn: string | ((a: never) => T), arg?: unknown): Promise<T>;
  screenshot(o?: object): Promise<Buffer>;
  on(ev: string, fn: (x: { message?: string; text?: () => string; type?: () => string }) => void): void;
}
interface Browser {
  newPage(o?: object): Promise<Page>;
  close(): Promise<void>;
}

function playwright(): { chromium: { launch(o?: object): Promise<Browser> } } {
  for (const from of [import.meta.url, pathToFileURL(join(WEB_DIR, "package.json")).href]) {
    const req = createRequire(from);
    for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
      try {
        return req(name) as { chromium: { launch(o?: object): Promise<Browser> } };
      } catch {
        // next
      }
    }
  }
  throw new Error("Device render needs Playwright, which was not found. Install the web app's dev dependencies (pnpm install at the repo root), then run `pnpm --filter @fabwright/web exec playwright install chromium`.");
}

export async function startVite(): Promise<{ url: string; close(): Promise<void> }> {
  const req = createRequire(join(WEB_DIR, "package.json"));
  let vite: { createServer(o: object): Promise<{ listen(): Promise<unknown>; resolvedUrls?: { local: string[] } | null; close(): Promise<void> }> };
  try {
    vite = (await import(pathToFileURL(req.resolve("vite")).href)) as typeof vite;
  } catch (err) {
    throw new Error(`Device render could not start the web app's dev server: vite was not found from ${WEB_DIR} (${(err as Error).message}). Run pnpm install, or pass --url of a running \`pnpm dev\`.`);
  }
  const server = await vite.createServer({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), server: { port: 0, strictPort: false, hmr: false }, logLevel: "error", clearScreen: false });
  await server.listen();
  const url = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!url) {
    await server.close();
    throw new Error("Device render started Vite but it reported no local URL. Pass --url of a running `pnpm dev` instead.");
  }
  return { url, close: () => server.close() };
}

/** Render the Device view at each requested virtual time. Returns PNG buffers (unless onShot is given). */
export async function renderDevice(opts: DeviceRenderOptions): Promise<Buffer[]> {
  const { project, hex } = loadProjectDir(opts.dir);
  const json = JSON.stringify(project);
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const pw = playwright();
  const server = opts.url ? undefined : await startVite();
  const base = (opts.url ?? server!.url).replace(/\/$/, "");
  const browser = await pw.chromium.launch({ args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=" + (process.platform === "darwin" ? "metal" : "default"), "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  const out: Buffer[] = [];
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => errors.push(e.message ?? String(e)));
    const q = new URLSearchParams({ capture: "1", hud: opts.hud === false ? "0" : "1", camera: opts.camera ?? "track" });
    await page.goto(`${base}/${PAGE}?${q}`);
    await page.waitForFunction("window.__device !== undefined", undefined, { timeout: 60_000 });
    await page.evaluate(`window.__device.load(${JSON.stringify(json)}, ${JSON.stringify(hex ?? null) || "null"} || undefined)`);
    await page.waitForFunction("window.__device.ready === true", undefined, { timeout: 60_000 });
    // Inputs and shots on one virtual timeline.
    type Ev = { t: number; run: string } | { t: number; shot: number };
    const evs: Ev[] = [];
    for (const p of opts.presses ?? []) {
      evs.push({ t: p.at, run: `window.__device.press(${JSON.stringify(p.part)})` });
      evs.push({ t: p.at + (p.holdMs ?? 120), run: `window.__device.release(${JSON.stringify(p.part)})` });
    }
    const shots = [...opts.shots].sort((a, b) => a - b);
    shots.forEach((ms, i) => evs.push({ t: ms, shot: i }));
    evs.sort((a, b) => a.t - b.t || ("run" in a ? -1 : 1));
    for (const e of evs) {
      const now = await page.evaluate<number>("window.__device.timeMs()");
      if (e.t > now) await page.evaluate(`window.__device.step(${e.t - now})`);
      if ("run" in e) await page.evaluate(e.run);
      else {
        await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))");
        const png = await page.screenshot({ type: "png" });
        if (opts.onShot) opts.onShot(png, shots[e.shot]!, e.shot);
        else out.push(png);
      }
    }
    const err = await page.evaluate<string | undefined>("window.__device.error");
    if (err) throw new Error(`The device page failed: ${err}`);
  } finally {
    await browser.close();
    await server?.close();
  }
  if (errors.length) throw new Error(`The device page threw: ${errors.slice(0, 3).join(" | ")}. Open ${PAGE} in a browser to see it.`);
  return out;
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const flag = (n: string) => {
    const i = a.indexOf(n);
    return i >= 0 ? a.splice(i, 2)[1] : undefined;
  };
  const bool = (n: string) => {
    const i = a.indexOf(n);
    if (i >= 0) a.splice(i, 1);
    return i >= 0;
  };
  const outDir = flag("--out") ?? "device-shots";
  const size = flag("--size") ?? "1280x800";
  const every = Number(flag("--every") ?? 0);
  const until = Number(flag("--until") ?? 0);
  const msList = (flag("--ms") ?? "").split(",").filter(Boolean).map(Number);
  const presses = (flag("--press") ?? "")
    .split(",")
    .filter(Boolean)
    .map((s) => {
      const [part, at] = s.split("@");
      return { part: part!, at: Number(at ?? 0) };
    });
  const url = flag("--url");
  const camera = flag("--camera") as DeviceRenderOptions["camera"];
  const hud = !bool("--no-hud");
  const dir = a[0];
  if (!dir || (!msList.length && !(every && until))) {
    console.error("usage: device-render.ts <project dir> --ms 2500,6000 | --every 100 --until 8000  [--out dir] [--size 1280x800] [--press part@ms,…] [--no-hud] [--camera track|chase|arena] [--url http://localhost:5173]");
    process.exit(2);
  }
  const shots = msList.length ? msList : Array.from({ length: Math.floor(until / every) + 1 }, (_, i) => i * every);
  const [w, h] = size.split("x").map(Number) as [number, number];
  mkdirSync(outDir, { recursive: true });
  const t0 = performance.now();
  let n = 0;
  await renderDevice({
    dir: resolve(dir),
    shots,
    presses,
    width: w,
    height: h,
    hud,
    ...(camera ? { camera } : {}),
    ...(url ? { url } : {}),
    onShot: (png, ms, i) => {
      const name = msList.length ? `device-${ms}ms.png` : `frame-${String(i).padStart(5, "0")}.png`;
      writeFileSync(join(outDir, name), png);
      n++;
    },
  });
  console.error(`${n} frame(s) in ${outDir} (${((performance.now() - t0) / 1000).toFixed(1)} s)${every ? `; video: ffmpeg -framerate ${Math.round(1000 / every)} -i ${outDir}/frame-%05d.png -pix_fmt yuv420p device.mp4` : ""}`);
}
