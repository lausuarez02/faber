// Round 6, frames track (decision 0004, R7): the device at one moment for still pictures that are
// not the live canvas, such as gallery thumbnails: the last logged run (part states, HIGH wires and
// colour screens), or the built firmware run headless when the project has no log yet (examples).
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@faber/project-format";
import type { PartRegistry, VisualState } from "@faber/sim-core";
import { SimHost, type ColorFrameImage, type Frame } from "./sim.ts";
import { stateDirPath } from "@faber/project-format/node";

/** The device at one moment, for a still picture (gallery thumbnail): part states, HIGH wires, colour screens. */
export interface DeviceStill {
  states: Record<string, VisualState>;
  live: string[];
  color?: Record<string, ColorFrameImage>;
  /** "log": the last run / test in the project's action log; "sim": a fresh 2 s run of the built firmware. */
  from: "log" | "sim";
}

/** Bytes read from the end of a big action log when looking for the last frames. */
const TAIL_BYTES = 8_000_000;

/** The last run's frames in <dir>/.faber/actions.jsonl, merged into one still; undefined when none. */
export function lastLoggedStill(dir: string): DeviceStill | undefined {
  const log = join(stateDirPath(dir), "actions.jsonl");
  if (!existsSync(log)) return undefined;
  let text: string;
  const fd = openSync(log, "r");
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"frames":[')) continue;
    let entry: { frames?: Frame[] };
    try {
      entry = JSON.parse(line) as { frames?: Frame[] };
    } catch {
      continue; // a torn first line of the tail
    }
    if (!entry.frames?.length) continue;
    const still: DeviceStill = { states: {}, live: [], from: "log" };
    for (const f of entry.frames) {
      for (const [id, st] of Object.entries(f.states ?? {})) still.states[id] = { ...(still.states[id] ?? {}), ...st };
      if (f.live) still.live = f.live;
      if (f.color) still.color = { ...still.color, ...f.color };
    }
    return still;
  }
  return undefined;
}

/**
 * A still of the device for a thumbnail: the last logged run, else (an example that ships its
 * built firmware but no log, or a log written before colour screens were recorded) the firmware
 * run headless for `ms` of virtual time. Undefined when there is nothing to show. Never throws: a thumbnail without a lit screen beats no thumbnail.
 */
export async function deviceStill(dir: string, project: Project, registry: PartRegistry, ms = 2000): Promise<DeviceStill | undefined> {
  try {
    const logged = lastLoggedStill(dir);
    if (logged?.color) return logged;
    const artifact = project.firmware?.artifact;
    if (!artifact || !existsSync(join(dir, artifact))) return logged;
    const hex = readFileSync(join(dir, artifact), "utf8");
    await SimHost.preparePhysics(project);
    const host = new SimHost(project, registry, hex);
    try {
      host.run(ms);
      const f = host.frame();
      // A log from before colour screens were recorded: the fresh run only wins when it has a colour screen.
      if (logged && !f?.color) return logged;
      return { states: f?.states ?? {}, live: host.liveWires(), ...(f?.color ? { color: f.color } : {}), from: "sim" };
    } finally {
      host.dispose();
    }
  } catch {
    return undefined;
  }
}

/** Changes when the still a thumbnail shows may have changed (the action log grew). For cache keys. */
export function stillKey(dir: string): string {
  try {
    return String(statSync(join(stateDirPath(dir), "actions.jsonl")).size);
  } catch {
    return "";
  }
}
