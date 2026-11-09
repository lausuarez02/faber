import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { actorCounts, loadPlaywright, startLiveHub, type LiveHub } from "@jumper/session";

const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

type Opts = Record<string, string | boolean | string[] | undefined>;

interface ViteHandle {
  url: string;
  close(): Promise<void>;
}

/** Start the web app's Vite dev server programmatically (port: preferred, next free if taken). */
export async function startWeb(port = 5173): Promise<ViteHandle> {
  const req = createRequire(join(WEB_DIR, "package.json"));
  let vitePath: string;
  try {
    vitePath = req.resolve("vite");
  } catch {
    throw new Error("Cannot find Vite in apps/web. Fix: run `pnpm install` at the repo root.");
  }
  type ViteServer = { listen(): Promise<unknown>; close(): Promise<void>; httpServer: { address(): unknown } | null };
  const vite = (await import(pathToFileURL(vitePath).href)) as { createServer(c: object): Promise<ViteServer> };
  const server = await vite.createServer({
    root: WEB_DIR,
    configFile: join(WEB_DIR, "vite.config.ts"),
    logLevel: "warn",
    server: { port, strictPort: false, host: "127.0.0.1" },
  });
  await server.listen();
  const addr = server.httpServer?.address() as { port?: number } | string | null | undefined;
  const actual = typeof addr === "object" && addr ? addr.port : port;
  return { url: `http://127.0.0.1:${actual}/`, close: () => server.close() };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // no browser: the URL is printed anyway
  }
}

function waitForever(cleanup: () => Promise<void>): Promise<number> {
  return new Promise((r) => {
    const stop = async () => {
      await cleanup().catch(() => {});
      r(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** Folder that owns an action log: <project>/.jumper/actions.jsonl → <project>. */
function projectOfLog(log: string): string {
  const d = dirname(log);
  return d.endsWith(".jumper") ? dirname(d) : d;
}

/** --actor mcp / --client claude / --session <sid> as a query string for the hub's /replay. */
function logFilter(log: string, opts: Opts, agentByDefault = false): string {
  const q = new URLSearchParams();
  if (opts.actor && opts.actor !== "all") q.set("actor", String(opts.actor));
  if (!opts.actor && agentByDefault) {
    // jumper record: the agent's build only, unless asked (persona report: CLI checks leaked into videos).
    const counts = actorCounts(readFileSync(log, "utf8"));
    if (counts.mcp && Object.keys(counts).length > 1) {
      q.set("actor", "mcp");
      process.stderr.write(`Recording only the agent's calls (actor mcp: ${counts.mcp} of ${Object.values(counts).reduce((a, b) => a + b, 0)} lines); pass --actor all for everything.\n`);
    }
  }
  if (opts.client) q.set("client", String(opts.client));
  if (opts.session) q.set("sid", String(opts.session));
  if (!q.size && opts.actor !== "all") {
    // A log with an agent's lines and a person's CLI checks mixed: say how to keep only the agent.
    const counts = actorCounts(readFileSync(log, "utf8"));
    if (Object.keys(counts).length > 1) {
      process.stderr.write(`The log mixes actors (${Object.entries(counts).map(([a, n]) => `${a} ${n}`).join(", ")}); pass --actor mcp to show only the agent's calls.\n`);
    }
  }
  return q.size ? `&${q}` : "";
}

async function startReplay(log: string, opts: Opts, agentByDefault = false): Promise<{ hub: LiveHub; web: ViteHandle; url: string }> {
  if (!existsSync(log)) throw new Error(`No action log at ${log}. Fix: pass a project's .jumper/actions.jsonl (every MCP/CLI session writes one).`);
  const filter = logFilter(log, opts, agentByDefault);
  const hub = await startLiveHub({ dir: projectOfLog(log), port: Number(opts["live-port"] ?? 0), replayFiles: [log] });
  const web = await startWeb(Number(opts.port ?? 5173));
  const speed = Number(opts.speed ?? 1) || 1;
  const url = `${web.url}?replay=${encodeURIComponent(`${hub.url}/replay?path=${encodeURIComponent(log)}${filter}`)}&speed=${speed}${opts.chrome ? `&chrome=${String(opts.chrome)}` : ""}`;
  return { hub, web, url };
}

export async function runServerCommand(cmd: string, pos: string[], opts: Opts, projectDir: string, base: string): Promise<number> {
  try {
    switch (cmd) {
      case "mcp": {
        const { startStdioServer } = await import("@jumper/mcp");
        await startStdioServer(["--project", projectDir, ...(opts.attach ? ["--attach", String(opts.attach)] : [])]);
        return await new Promise<number>(() => {}); // runs until stdin closes
      }
      case "runner": {
        const { startRunnerServer, RUNNER_IMAGE } = await import("@jumper/runner");
        const port = Number(opts.port ?? 7781);
        await startRunnerServer(port);
        process.stderr.write(`jumper runner on http://127.0.0.1:${port} (image ${RUNNER_IMAGE}). POST /build { fqbn, sketchDir | files }.\n`);
        return await waitForever(async () => {});
      }
      case "serve": {
        const { startJumperServer, DEFAULT_PORT } = await import("./serve.ts");
        const port = Number(opts.port ?? opts["live-port"] ?? process.env.JUMPER_PORT ?? DEFAULT_PORT);
        const web = opts["no-web"] ? "none" : opts.built ? "built" : "dev";
        const srv = await startJumperServer({ dir: projectDir, port, web, ...(opts["strict-port"] ? { strictPort: true } : {}) });
        const lines = [`Jumper is running for ${srv.dir}`];
        if (srv.port !== port && port !== 0) lines.push(`  (port ${port} was taken, so this is ${srv.port})`);
        if (srv.web !== "none") lines.push(`  open:  ${srv.url}/   (the canvas follows this project live)`);
        lines.push(`  ws:    ${srv.wsUrl}${srv.web === "none" ? `   (web app off; any Jumper app can follow it with ?follow=${encodeURIComponent(srv.wsUrl)})` : ""}`);
        lines.push(`  MCP:   ${srv.mcpUrl}`, "", "Connect an agent (one step):");
        lines.push(`  Claude Code:  claude mcp add --transport http jumper ${srv.mcpUrl}`);
        lines.push(`  Codex:        codex mcp add jumper --url ${srv.mcpUrl}`);
        lines.push(`  stdio only:   jumper mcp --attach ${srv.url}`);
        lines.push("More (Claude Desktop, Cursor): the Connect menu in the app, or docs/agents.md. Ctrl+C to stop.", "");
        process.stdout.write(lines.join("\n"));
        if (!opts["no-open"] && srv.web !== "none") openBrowser(`${srv.url}/`);
        return await waitForever(() => srv.close());
      }
      case "replay": {
        const log = resolve(base, pos[0] ?? join(projectDir, ".jumper/actions.jsonl"));
        const { hub, web, url } = await startReplay(log, opts);
        process.stdout.write(`Replaying ${log}\n  open: ${url}\nCtrl+C to stop.\n`);
        if (!opts["no-open"]) openBrowser(url);
        return await waitForever(async () => {
          await hub.close();
          await web.close();
        });
      }
      case "record": {
        const log = resolve(base, pos[0] ?? join(projectDir, ".jumper/actions.jsonl"));
        const out = resolve(base, pos[1] ?? "jumper-replay.mp4");
        return await record(log, out, opts);
      }
    }
  } catch (err) {
    process.stderr.write(`jumper ${cmd}: ${(err as Error).message}\n`);
    return 1;
  }
  return 2;
}

/** Record a replay to video with Playwright (Chromium), then convert to MP4 with ffmpeg when available. */
async function record(log: string, out: string, opts: Opts): Promise<number> {
  const pw = loadPlaywright() as unknown as {
    chromium: {
      launch(o?: object): Promise<{
        newContext(o: object): Promise<{
          newPage(): Promise<{ goto(u: string): Promise<unknown>; waitForFunction(f: string, a?: unknown, o?: object): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; video(): { path(): Promise<string> } | null }>;
          close(): Promise<void>;
        }>;
        close(): Promise<void>;
      }>;
    };
  };
  if (!pw) throw new Error("Recording needs Playwright with Chromium. Fix: pnpm --filter @jumper/web exec playwright install chromium");
  const [w, h] = String(opts.size ?? "1600x900").split("x").map(Number) as [number, number];
  const { hub, web, url } = await startReplay(log, { chrome: "min", ...opts }, true);
  const videoDir = mkdtempSync(join(tmpdir(), "jumper-video-"));
  const browser = await pw.chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: w, height: h } }, colorScheme: "dark" });
    const page = await ctx.newPage();
    process.stderr.write(`recording ${log} at ${w}x${h}…\n`);
    await page.goto(url);
    await page.waitForFunction("globalThis.__jumperReplay && globalThis.__jumperReplay.done === true", undefined, { timeout: 15 * 60_000, polling: 500 });
    await page.waitForTimeout(1800); // hold the last frame
    const video = page.video();
    await ctx.close();
    const raw = video ? await video.path() : readdirSync(videoDir).map((f) => join(videoDir, f))[0];
    if (!raw) throw new Error("Playwright produced no video file.");
    mkdirSync(dirname(out), { recursive: true });
    if (out.endsWith(".webm")) renameSync(raw, out);
    else {
      const ok = await new Promise<boolean>((r) => {
        const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "inherit"] });
        ff.on("error", () => r(false));
        ff.on("close", (code) => r(code === 0));
      });
      if (!ok) {
        const webm = out.replace(/\.[^.]+$/, ".webm");
        renameSync(raw, webm);
        process.stderr.write(`ffmpeg is not available (or failed), so the video is WebM: ${webm}. Install ffmpeg for MP4.\n`);
        process.stdout.write(webm + "\n");
        return 0;
      }
    }
    process.stdout.write(out + "\n");
    return 0;
  } finally {
    await browser.close();
    await hub.close();
    await web.close();
    rmSync(videoDir, { recursive: true, force: true });
  }
}
