import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monoPixel, type MonoFrame } from "@faber/sim-core";
import { fail } from "./errors.ts";

/**
 * Golden display frames for scenario tests: read_display {save_as} writes snapshots/<name>.json in
 * the project, and {"expect_display": "oled1", "matches": "<name>"} compares the screen against it.
 */
export interface DisplaySnapshot {
  part: string;
  t_ms: number;
  /** [x, y, w, h] in screen pixels. */
  region: [number, number, number, number];
  /** One string per pixel row of the region: "#" lit, "." dark. */
  rows: string[];
}

export const SNAPSHOT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function snapshotPath(dir: string, name: string): string {
  return join(dir, "snapshots", `${name}.json`);
}

/** Clamp a region to the screen, or fail saying what fits. Default: the whole screen. */
export function clampRegion(f: MonoFrame, region: readonly number[] | undefined, what: string): [number, number, number, number] {
  if (!region) return [0, 0, f.width, f.height];
  if (region.length !== 4 || region.some((v) => !Number.isInteger(v) || v < 0)) {
    fail("bad-region", `${what}: region ${JSON.stringify(region)} is not valid`, "a region is [x, y, w, h], whole non-negative pixel numbers", `pass e.g. [0, 0, ${f.width}, ${f.height}] for the whole ${f.width}x${f.height} screen`);
  }
  const [x, y, w, h] = region as [number, number, number, number];
  if (w < 1 || h < 1 || x + w > f.width || y + h > f.height) {
    fail("bad-region", `${what}: region [${x}, ${y}, ${w}, ${h}] does not fit the screen`, `the screen is ${f.width}x${f.height} pixels, so x + w must be <= ${f.width} and y + h <= ${f.height}`, `shrink it, e.g. [${Math.min(x, f.width - 1)}, ${Math.min(y, f.height - 1)}, ${Math.max(1, Math.min(w, f.width - Math.min(x, f.width - 1)))}, ${Math.max(1, Math.min(h, f.height - Math.min(y, f.height - 1)))}]`);
  }
  return [x, y, w, h];
}

export function regionRows(f: MonoFrame, [x, y, w, h]: readonly number[]): string[] {
  const rows: string[] = [];
  for (let r = 0; r < h!; r++) {
    let line = "";
    for (let c = 0; c < w!; c++) line += monoPixel(f, x! + c, y! + r) ? "#" : ".";
    rows.push(line);
  }
  return rows;
}

export function litCount(rows: string[]): number {
  let n = 0;
  for (const r of rows) for (const ch of r) if (ch === "#") n++;
  return n;
}

/** Fraction of pixels that differ (0..1). */
export function diffFraction(a: string[], b: string[]): number {
  let diff = 0;
  let total = 0;
  for (let r = 0; r < Math.max(a.length, b.length); r++) {
    const x = a[r] ?? "";
    const y = b[r] ?? "";
    for (let c = 0; c < Math.max(x.length, y.length); c++) {
      total++;
      if ((x[c] ?? ".") !== (y[c] ?? ".")) diff++;
    }
  }
  return total ? diff / total : 0;
}

export function saveSnapshot(dir: string, name: string, snap: DisplaySnapshot): string {
  if (!SNAPSHOT_NAME.test(name)) fail("bad-name", `save_as '${name}' is not a valid snapshot name`, "names start with a letter and use letters, digits, '_' or '-'", 'pass e.g. "sad-face"');
  const path = snapshotPath(dir, name);
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  writeFileSync(path, JSON.stringify(snap, null, 1) + "\n");
  return path;
}

export function loadSnapshot(dir: string, name: string): DisplaySnapshot | undefined {
  const path = snapshotPath(dir, name);
  if (!existsSync(path)) return undefined;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as DisplaySnapshot;
    if (!Array.isArray(s.rows) || !Array.isArray(s.region)) return undefined;
    return s;
  } catch {
    return undefined;
  }
}
