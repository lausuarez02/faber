// Round 13 (audio): a board that plays sound, on the page that follows `jumper serve`. A XIAO
// ESP32-S3 + MAX98357A + 20 mm speaker playing a steady 1 kHz tone (ESP_I2S): Run builds the sketch
// with the real toolchain and runs it in Espressif's QEMU next to the server (the I2S device of
// patch 0004); the amplifier on the canvas shows it playing with a level bar, the speaker sounds,
// and the run's recording is served for the page's WebAudio player, which stays silent under a
// test driver (it counts the request and says why it did not play).
// Needs the native ESP32 toolchain and QEMU (pnpm jumper setup esp32) or Docker; skipped otherwise.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { hubPort, shot } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../cli/bin/jumper.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/esp32-audio/", import.meta.url));
/** The ESP32 toolchain and QEMU Jumper installs natively (jumper setup esp32). */
const NATIVE = join(process.env.JUMPER_NATIVE_HOME ?? join(homedir(), ".jumper"));
const ready = existsSync(join(NATIVE, "emulators", "qemu-esp", "9.2.2-20260417-jb6", "bin", "qemu-system-xtensa")) && existsSync(join(NATIVE, "toolchains", "arduino"));

test.describe("an ESP32-S3 that plays sound, followed from jumper serve", () => {
  test.skip(!ready, "needs the native ESP32 toolchain and QEMU jb6 (pnpm jumper setup esp32)");
  let dir = "";
  let home = "";
  let hub: ChildProcess | undefined;
  let port = 0;

  test.beforeEach(async ({ page }, info) => {
    dir = mkdtempSync(join(tmpdir(), "jumper-e2e-audio-"));
    home = mkdtempSync(join(tmpdir(), "jumper-e2e-home-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const env = { ...process.env, JUMPER_HOME: home, JUMPER_AI_GATEWAY_PORT: "0" };
    expect(spawnSync(process.execPath, [CLI, "status", "-p", dir], { encoding: "utf8", timeout: 60_000, env }).status).toBe(0);
    port = hubPort(info, 18);
    hub = spawn(process.execPath, [CLI, "serve", "--project", dir, "--no-web", "--port", String(port), "--strict-port", "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    hub.stdout?.on("data", (b: Buffer) => void (out += b.toString()));
    hub.stderr?.on("data", (b: Buffer) => void (out += b.toString()));
    hub.once("exit", (code) => {
      if (code) console.log(`jumper serve exited ${code}:\n${out.slice(-2000)}`);
    });
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/api/agent-state`).catch(() => undefined))?.status ?? 0, { timeout: 60_000 }).toBe(200);
    // Count what the page asks WebAudio to do: under a test driver it must never create a context.
    await page.addInitScript(() => {
      const w = window as unknown as { __audioContexts: number; AudioContext?: typeof AudioContext };
      w.__audioContexts = 0;
      const Orig = w.AudioContext;
      if (Orig) {
        w.AudioContext = class extends Orig {
          constructor(o?: AudioContextOptions) {
            super(o);
            w.__audioContexts++;
          }
        } as typeof AudioContext;
      }
    });
  });

  test.afterEach(async () => {
    const h = hub;
    hub = undefined;
    if (h && h.exitCode === null) {
      const gone = new Promise((r) => h.once("exit", r));
      h.kill();
      await gone;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("Run: the amp plays with a moving level bar, the speaker sounds, the recording is served, the page stays silent", async ({ page }, info) => {
    test.setTimeout(240_000);
    // This app (Vite) follows the server from another origin, as a person's page does.
    await page.goto(`/?follow=${encodeURIComponent(`ws://127.0.0.1:${port}/live`)}`);
    await expect(page.getByTestId("app")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("part-amp")).toBeVisible({ timeout: 30_000 });
    // The followed page's Run goes to the session (the board runs in QEMU next to the server).
    await expect(page.getByTestId("run-button")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("run-button").click();
    const amp = page.getByTestId("part-amp");
    // The first Run builds the sketch (tens of seconds natively), boots QEMU and runs 3 s of device time.
    await expect
      .poll(async () => ((await amp.getAttribute("data-state-playing")) === "true" ? "playing" : ((await page.getByTestId("toast").allTextContents().catch(() => [] as string[])).join(" | ")).slice(0, 600) || "waiting"), { timeout: 200_000, intervals: [500] })
      .toBe("playing");
    const level = Number(await amp.getAttribute("data-state-level"));
    expect(level).toBeGreaterThan(0.1);
    expect(level).toBeLessThan(0.25);
    // The bar's width follows the level (CSS variable on the part).
    expect(Number(await amp.evaluate((el) => getComputedStyle(el).getPropertyValue("--level")))).toBeCloseTo(level, 2);
    await expect(page.getByTestId("part-spk")).toHaveAttribute("data-state-sounding", "true");
    await shot(page, info, "esp32-audio-playing");
    // The run's recording: asked for, not played (a test drives the page), and served as a WAV.
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __jumperAudio?: { requested: number } }).__jumperAudio?.requested ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
    const stats = await page.evaluate(() => (window as unknown as { __jumperAudio: { requested: number; played: number; last?: { file: string; parts: string[]; reason?: string } } }).__jumperAudio);
    expect(stats.played).toBe(0);
    expect(stats.last?.reason).toBe("a test drives this page");
    expect(stats.last?.parts).toEqual(["amp"]);
    expect(await page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts)).toBe(0);
    const wav = await page.request.get(`http://127.0.0.1:${port}/api/audio/${stats.last!.file}`);
    expect(wav.status()).toBe(200);
    expect(wav.headers()["content-type"]).toBe("audio/wav");
    const body = await wav.body();
    expect(body.toString("ascii", 0, 4)).toBe("RIFF");
    expect(body.length).toBeGreaterThan(44 + 16000); // more than half a second of 16 kHz mono
    expect((await page.request.get(`http://127.0.0.1:${port}/api/audio/..%2Fjumper.json`)).status()).toBe(400);
  });
});
