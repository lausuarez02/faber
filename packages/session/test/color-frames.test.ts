import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { ProjectSession, composeSvg, deviceStill, lastLoggedStill, registryForProjectDir, stillKey, versionDetail } from "../src/index.ts";
import { limitColorFrames } from "../src/color-frames.ts";
import { downsampleFrames } from "../src/session.ts";
import type { Frame } from "../src/sim.ts";

// Round 6, frames track (decision 0004, R7): run and run_tests put the colour screen's real pixels
// in their frames (Frame.color), the history keeps the last one, and long runs stay small.
const PART = fileURLToPath(new URL("../../parts/src/parts/gc9a01-round-tft/", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}: the example hex should be fresh`);
};

const dir = mkdtempSync(join(tmpdir(), "faber-color-frames-"));
mkdirSync(join(dir, "firmware"), { recursive: true });
copyFileSync(join(PART, "example.ino"), join(dir, "firmware", "main.ino"));
copyFileSync(join(PART, "example.hex"), join(dir, "firmware", "main.hex"));
const later = new Date(Date.now() + 60_000);
utimesSync(join(dir, "firmware", "main.hex"), later, later);
const wire = (id: string, from: string, to: string) => ({ id, from: { part: "eye", pin: from }, to: { part: "uno", pin: to }, color: "#FFB23F" });
writeFileSync(
  join(dir, "faber.json"),
  JSON.stringify({
    format: "faber/1",
    name: "Round eye",
    parts: [
      { id: "uno", type: "arduino-uno", x: 0, y: 0, rotation: 0 },
      { id: "eye", type: "gc9a01-round-tft", x: 400, y: 0, rotation: 0 },
    ],
    wires: [wire("w1", "VCC", "5V"), wire("w2", "GND", "GND.1"), wire("w3", "SCK", "D13"), wire("w4", "MOSI", "D11"), wire("w5", "RST", "D8"), wire("w6", "DC", "D9"), wire("w7", "CS", "D10")],
    firmware: { board: "uno", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" } },
    scenarios: [{ id: "draws", steps: [{ run_ms: 2500 }, { expect_display: "eye", lit: { min: 500 } }] }],
  }),
);
const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
afterAll(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** Decode our own RGB PNGs (filter 0 or 1 rows) and count pixels that are not black. */
function litPixels(b64: string): { w: number; h: number; lit: number } {
  const png = Buffer.from(b64, "base64");
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  let p = 8;
  const idat: Buffer[] = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    if (png.toString("ascii", p + 4, p + 8) === "IDAT") idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  let lit = 0;
  const stride = w * 3 + 1;
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride]!;
    const row = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    if (f === 1) for (let i = 3; i < row.length; i++) row[i] = (row[i]! + row[i - 3]!) & 0xff;
    for (let x = 0; x < w; x++) if (row[x * 3]! | row[x * 3 + 1]! | row[x * 3 + 2]!) lit++;
  }
  return { w, h, lit };
}

function lastLogEntry(op: string): { frames?: Frame[] } {
  const lines = readFileSync(join(dir, ".faber", "actions.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(lines.reverse().find((l) => l.includes(`"op":"${op}"`))!) as { frames?: Frame[] };
}

describe("colour frames (round 6)", () => {
  it("run logs the round screen's pixels as PNGs, only when the screen changed", async () => {
    await s.call("move_part", { id: "eye", x: 420, y: 0 }); // an edit, so the history has a version
    await s.call("run", { ms: 3000 });
    const frames = lastLogEntry("run").frames!;
    const withColor = frames.filter((f) => f.color?.eye);
    expect(withColor.length).toBeGreaterThan(1);
    expect(withColor.length).toBeLessThan(frames.length); // not every frame: only changes
    const last = withColor.at(-1)!.color!.eye!;
    expect(last.w).toBe(240);
    expect(last.h).toBe(240);
    const px = litPixels(last.png);
    expect(px.lit).toBeGreaterThan(1000);
    // The part's state rides along so a viewer repaints that screen.
    expect(withColor.at(-1)!.states?.eye).toBeDefined();
  }, 60_000);

  it("the history version keeps the last colour image", () => {
    const found = [1, 2, 3, 4, 5].map((n) => versionDetail(dir, n)).find((v) => v?.frame?.color?.eye);
    expect(found?.frame?.color?.eye?.png.length).toBeGreaterThan(100);
  });

  it("run_tests frames carry colour images too", async () => {
    const r = (await s.call("run_tests", {})) as { passed: number };
    expect(r.passed).toBe(1);
    const frames = lastLogEntry("run_tests").frames!;
    expect(frames.some((f) => f.color?.eye && litPixels(f.color.eye.png).lit > 1000)).toBe(true);
  }, 60_000);

  it("downsampleFrames keeps the latest colour image of a merged group", () => {
    const img = (n: number) => ({ w: 1, h: 1, png: `p${n}` });
    const frames: Frame[] = Array.from({ length: 10 }, (_, i) => ({ vt: i * 10, ...(i % 3 === 0 ? { color: { eye: img(i) } } : {}) }));
    const out = downsampleFrames(frames, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.color?.eye?.png).toBe("p3");
    expect(out[1]!.color?.eye?.png).toBe("p9");
  });

  it("limitColorFrames thins a long run evenly and always keeps each screen's last image", () => {
    const frames: Frame[] = Array.from({ length: 1000 }, (_, i) => ({ vt: i * 50, color: { a: { w: 1, h: 1, png: "x".repeat(1000) }, ...(i < 10 ? { b: { w: 1, h: 1, png: "y" } } : {}) } }));
    limitColorFrames(frames, 100, 10_000_000);
    const a = frames.filter((f) => f.color?.a);
    expect(a.length).toBeLessThanOrEqual(100);
    expect(a.length).toBeGreaterThan(30);
    expect(frames.at(-1)!.color?.a).toBeDefined();
    expect(frames[9]!.color?.b).toBeDefined();
    // Byte cap: 20 KB of 1 KB images keeps about 20.
    const big: Frame[] = Array.from({ length: 200 }, (_, i) => ({ vt: i * 50, color: { a: { w: 1, h: 1, png: "x".repeat(1000) } } }));
    limitColorFrames(big, 1000, 20_000);
    const kept = big.filter((f) => f.color?.a).length;
    expect(kept).toBeLessThanOrEqual(21);
    expect(kept).toBeGreaterThan(5);
  });
});

describe("device stills for thumbnails (round 6)", () => {
  it("an example with built firmware and no log: the firmware runs 2 s and the colour screen is in the still", async () => {
    const ex = fileURLToPath(new URL("../../../examples/ai-pet/", import.meta.url));
    const project = JSON.parse(readFileSync(join(ex, "faber.json"), "utf8"));
    const t0 = Date.now();
    const still = await deviceStill(ex, project, registryForProjectDir(ex));
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(still?.from).toBe("sim");
    const tft = Object.entries(still!.color ?? {})[0];
    expect(tft).toBeDefined();
    expect(litPixels(tft![1].png).lit).toBeGreaterThan(1000);
    const svg = composeSvg(project, registryForProjectDir(ex), { states: still!.states, liveWires: still!.live, color: still!.color! });
    expect(svg).toContain(tft![1].png.slice(0, 200));
  }, 30_000);

  it("a project with a log: the last run's frames, colour included, without running anything", () => {
    const still = lastLoggedStill(dir);
    expect(still?.from).toBe("log");
    expect(litPixels(still!.color!.eye!.png).lit).toBeGreaterThan(1000);
    expect(stillKey(dir)).toMatch(/^\d+$/);
  });
});
