// Round 5, track "agent" (decision 0003, C5 `record`): a video of the agent building the device and
// the device running, for the person. It replays the project's action log in the web app (the same
// player as `fabwright replay`: parts appear with the agent's cursor and "why" captions, wires draw,
// the sketch, the simulation frames of run / run_tests, tests turning green) in headless Chromium,
// records it, and converts it to H.264 MP4 with ffmpeg (WebM when ffmpeg is missing).
//
// Fails in well under 5 s, with why and fix, when Playwright's Chromium is not installed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fail } from "./errors.ts";
import { actorCounts, filterActionLog, startLiveHub } from "./live.ts";
import { loadPlaywright } from "./screenshot.ts";

const INSTALL_CHROMIUM = "pnpm --filter @fabwright/web exec playwright install chromium";

interface RecPage {
  goto(u: string): Promise<unknown>;
  waitForFunction(f: string, a?: unknown, o?: object): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  video(): { path(): Promise<string> } | null;
}
interface RecBrowser {
  newContext(o: object): Promise<{ newPage(): Promise<RecPage>; close(): Promise<void> }>;
  close(): Promise<void>;
}
export interface RecorderPlaywright {
  chromium: { launch(o?: object): Promise<RecBrowser>; executablePath?(): string };
}

export interface RecordOptions {
  /** Project folder (its .fabwright/actions.jsonl is replayed). */
  dir: string;
  /** "mcp" (default): only the agent's calls; "all": the person's and the CLI's too. */
  actor?: "mcp" | "all";
  /** Replay speed; default picks one so the video lasts about a minute. */
  speed?: number;
  /** "1280x720" (default). */
  size?: string;
  /** Longest video in wall ms (default: the replay's length with room to spare, at least 90000); a longer replay is cut and says so. */
  maxMs?: number;
  /** Output file; default <dir>/.fabwright/media/build-<time>.mp4. */
  out?: string;
  /** A running web app to use (fabwright serve's own URL); otherwise a Vite dev server is started. */
  webUrl?: string;
  /** Tests: replace Playwright. */
  playwright?: () => RecorderPlaywright | undefined;
  /** Tests: replace ffmpeg availability. */
  ffmpeg?: string;
}

export interface RecordResult {
  path: string;
  format: "mp4" | "webm";
  duration_s: number;
  speed: number;
  actor: "mcp" | "all";
  entries: number;
  truncated?: boolean;
  notes: string[];
}

/** Why recording cannot work here, with the fix, or undefined when Chromium is ready. Fast (no browser start). */
export function chromiumProblem(load: () => RecorderPlaywright | undefined = () => loadPlaywright() as unknown as RecorderPlaywright | undefined): string | undefined {
  const pw = load();
  if (!pw) return `Playwright is not installed. Fix: run pnpm install at the Fabwright repo root, then ${INSTALL_CHROMIUM}`;
  let exe: string | undefined;
  try {
    exe = pw.chromium.executablePath?.();
  } catch (err) {
    return `Playwright's Chromium is not available (${(err as Error).message.split("\n")[0]}). Fix: ${INSTALL_CHROMIUM}`;
  }
  if (exe !== undefined && !existsSync(exe)) return `Playwright's Chromium is not installed (no browser at ${exe}). Fix: ${INSTALL_CHROMIUM}`;
  return undefined;
}

/** Wall ms an entry takes in the replay at speed 1 (mirrors apps/web/src/live/player.ts entryDuration). */
function entryMs(e: { op?: string; ok?: boolean; frames?: { vt: number }[]; project?: unknown; file?: unknown; target?: unknown }): number {
  if (!e.ok) return 1400;
  const span = e.frames?.length ? e.frames[e.frames.length - 1]!.vt - e.frames[0]!.vt : 0;
  const visible = !!(e.project || e.frames?.length || e.file || e.target || ["build", "run_tests", "check_design", "fidelity_report", "screenshot", "export", "read_display"].includes(e.op ?? ""));
  if (!visible) return 30;
  const table: Record<string, number> = { new_project: 900, place_part: 1000, connect: 650, disconnect: 600, remove: 600, move_part: 600, write_file: 3200, set_part_property: 900, set_libraries: 900, write_scenario: 900, build: 1300, interact: 700, set_sensor_value: 700, inject_fault: 700, check_design: 1600, fidelity_report: 1600, read_display: 900, screenshot: 900, export: 900 };
  if (e.op === "run") return Math.min(9000, Math.max(900, span));
  if (e.op === "run_tests") return Math.min(7000, Math.max(1800, span));
  return table[e.op ?? ""] ?? 350;
}

/** The replay's length at speed 1 and the number of entries, for the lines the filter keeps. */
export function replayPlan(logText: string, actor: "mcp" | "all"): { entries: number; ms: number } {
  const text = actor === "all" ? logText : filterActionLog(logText, { actor: "mcp" });
  let ms = 0;
  let entries = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      ms += entryMs(JSON.parse(line) as Parameters<typeof entryMs>[0]);
      entries++;
    } catch {
      // a torn line: the player skips it too
    }
  }
  return { entries, ms };
}

/** Speed that brings a replay of `ms` near a one-minute video. */
export function autoSpeed(ms: number): number {
  for (const s of [1, 1.5, 2, 3, 4, 6, 8]) if (ms / s <= 60_000) return s;
  return 8;
}

function ffmpegConvert(bin: string, raw: string, out: string): Promise<boolean> {
  return new Promise((r) => {
    const ff = spawn(bin, ["-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-preset", "veryfast", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "ignore"] });
    ff.on("error", () => r(false));
    ff.on("close", (code) => r(code === 0));
  });
}

export async function recordProject(opts: RecordOptions): Promise<RecordResult> {
  const actor = opts.actor ?? "mcp";
  if (actor !== "mcp" && actor !== "all") fail("bad-arg", `record: unknown actor '${String(actor)}'`, 'actor picks whose calls the video shows: "mcp" (the agent) or "all"', 'pass { "actor": "mcp" } (default) or { "actor": "all" }');
  const log = join(opts.dir, ".fabwright", "actions.jsonl");
  if (!existsSync(log)) fail("nothing-to-record", "record: this project has no action log yet", `${log} does not exist, so nothing has been built here`, "build something first (place_part, connect, write_file, run), then record");
  const text = readFileSync(log, "utf8");
  const plan = replayPlan(text, actor);
  if (!plan.entries) {
    const counts = actorCounts(text);
    fail("nothing-to-record", "record: no agent calls to show", `the log has ${Object.entries(counts).map(([a, n]) => `${n} ${a}`).join(", ") || "no"} lines and none by an agent (actor mcp)`, 'pass { "actor": "all" } to record every line');
  }
  const [w, h] = (opts.size ?? "1280x720").split("x").map(Number) as [number, number];
  if (!(w >= 320 && w <= 3840 && h >= 240 && h <= 2160)) fail("bad-arg", `record: size '${opts.size}' is not usable`, "size is WIDTHxHEIGHT in pixels, 320x240 to 3840x2160", 'pass e.g. { "size": "1280x720" }');
  const speed = opts.speed ?? autoSpeed(plan.ms);
  if (!(speed > 0 && speed <= 16)) fail("bad-arg", `record: speed ${opts.speed} is out of range`, "speed is the replay speed-up, above 0 and at most 16", 'pass e.g. { "speed": 2 } or leave it out for about a one-minute video');
  // Room for page load and the held last frame on top of the replay itself.
  const maxMs = opts.maxMs ?? Math.min(600_000, Math.max(90_000, Math.round((plan.ms / speed) * 1.3 + 20_000)));
  if (!(maxMs >= 1000 && maxMs <= 600_000)) fail("bad-arg", `record: ms ${opts.maxMs} is out of range`, "ms is the longest video in wall-clock ms, 1000 to 600000", 'pass e.g. { "ms": 60000 }');

  const load = opts.playwright ?? (() => loadPlaywright() as unknown as RecorderPlaywright | undefined);
  const problem = chromiumProblem(load);
  if (problem) fail("no-browser", "record: cannot record a video here", problem, `meanwhile use screenshot (a PNG of the circuit), or the viewer_url link; after installing, call record again`);
  const pw = load()!;

  const media = join(opts.dir, ".fabwright", "media");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const out = opts.out ?? join(media, `build-${stamp}.mp4`);
  mkdirSync(dirname(out), { recursive: true });
  const notes: string[] = [];

  const hub = await startLiveHub({ dir: opts.dir, port: 0, replayFiles: [log] });
  let vite: { url: string; close(): Promise<void> } | undefined;
  const videoDir = mkdtempSync(join(tmpdir(), "fabwright-record-"));
  let browser: RecBrowser | undefined;
  try {
    let web = opts.webUrl?.replace(/\/+$/, "");
    if (!web) {
      const { startVite } = await import("./device-render.ts");
      vite = await startVite();
      web = vite.url.replace(/\/+$/, "");
    }
    const replayUrl = `${hub.url}/replay?path=${encodeURIComponent(log)}${actor === "mcp" ? "&actor=mcp" : ""}`;
    const url = `${web}/?replay=${encodeURIComponent(replayUrl)}&speed=${speed}&chrome=min`;
    browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: w, height: h } }, colorScheme: "dark" });
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto(url);
    let truncated = false;
    try {
      await page.waitForFunction("globalThis.__fabwrightReplay && globalThis.__fabwrightReplay.done === true", undefined, { timeout: Math.max(1000, maxMs - 1800), polling: 250 });
      await page.waitForTimeout(1800); // hold the last frame
    } catch {
      truncated = true;
      notes.push(`the replay (about ${Math.round(plan.ms / speed / 1000)} s at speed ${speed}, plus loading) was still running at ms ${maxMs}, so the video stops before the end. Pass a higher speed or a larger ms to see the end`);
    }
    const duration = (Date.now() - t0) / 1000;
    const video = page.video();
    await ctx.close();
    const raw = video ? await video.path() : readdirSync(videoDir).map((f) => join(videoDir, f))[0];
    if (!raw || !existsSync(raw) || statSync(raw).size === 0) fail("record-failed", "record: Chromium produced no video", "the page closed before a frame was captured", "call record again; if it repeats, check that the web app opens with pnpm dev");
    let path = out;
    let format: "mp4" | "webm" = "mp4";
    if (out.endsWith(".webm")) {
      renameSync(raw, out);
      format = "webm";
    } else if (!(await ffmpegConvert(opts.ffmpeg ?? "ffmpeg", raw, out))) {
      path = out.replace(/\.[^.]+$/, ".webm");
      renameSync(raw, path);
      format = "webm";
      notes.push("ffmpeg is not installed (or failed), so the video is WebM, which browsers play but some phones do not. Fix: install ffmpeg (brew install ffmpeg) and record again for MP4");
    }
    return { path, format, duration_s: Math.round(duration * 10) / 10, speed, actor, entries: plan.entries, ...(truncated ? { truncated } : {}), notes };
  } finally {
    await browser?.close().catch(() => {});
    await hub.close();
    await vite?.close();
    rmSync(videoDir, { recursive: true, force: true });
  }
}

/** File name under .fabwright/media that GET /api/media/:file may serve. */
export function mediaName(path: string): string {
  return basename(path);
}
