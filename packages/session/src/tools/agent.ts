import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { serverBase, viewerUrlFor } from "../agent-runtime.ts";
import { didYouMean, fail } from "../errors.ts";
import { planDevice, resolveBoard, type PlanConstraints } from "../planner.ts";
import { recordProject } from "../recorder.ts";
import type { ToolModule } from "./types.ts";
import { stateDirPath } from "@faber/project-format/node";
import { LEGACY_PROJECT_FILE, LEGACY_STATE_DIR, PROJECT_FILE, STATE_DIR } from "@faber/project-format/legacy";

/**
 * Track "agent" (owner): plan_device, record, viewer_url, delete_file, mark_stand_in.
 * Contract: docs/decisions/0003-round5-see-it-work.md, C5. mark_stand_in is not in C5: it is how a
 * part's `standIn` (C2, instance level) gets set, so exports can name the real part.
 */

const why = { type: "string", description: 'Short reason shown to the human in the step list, e.g. "remove the old test shots".' };

const NO_SERVER_FIX =
  "ask the person to start Faber's local server (pnpm start in the Faber repo, or faber serve --project <this folder>) and connect this agent to http://localhost:7780/mcp; meanwhile use screenshot (an image) or record (a video file)";

function relProjectPath(dir: string, path: unknown): string {
  if (typeof path !== "string" || !path.trim()) fail("missing-arg", "delete_file needs 'path'", "no path was given", 'pass a path inside the project, e.g. "shots/old.png" or "firmware/debug.ino"');
  const rel = relative(dir, resolve(dir, path.trim()));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("bad-path", `delete_file: '${path}' is outside the project`, `only files inside ${dir} can be deleted`, "pass a path relative to the project folder");
  }
  return normalize(rel).split(sep).join("/");
}

/** A file that is not valid UTF-8 text (or has NUL bytes) cannot go through the text undo history. */
function isBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  return Buffer.from(buf.toString("utf8"), "utf8").compare(buf) !== 0;
}

export const agentTools: ToolModule = {
  name: "agent",
  tools: [
    {
      name: "plan_device",
      title: "Plan a device before building it",
      description:
        'Call this FIRST for a new wish, before placing anything. Turns the goal into a plan to show the person: which board and why, a parts list with one line of why per part, which parts Faber simulates as themselves ("simulated-exactly"), with a stand-in ("stand-in"), as an agent-made part ("agent-made", via create_part) or not at all ("not-simulated"), a rough size (parts and case in mm), battery life from each part\'s current and the battery capacity, total price and buy links, plus what the simulation cannot check. Example: {"goal": "a virtual pet that fits in my pocket and beeps when hungry", "constraints": {"pocket": true, "budget_usd": 30}}. Returns {summary, question?, board {type, why}, bom [{type, name, qty, why, source, current_ma, price_usd, buy_links}], size_mm {parts, enclosure}, battery {type, capacity_mah, avg_ma, hours}, size_budget {footprint_mm2, flat_mm, max_thickness_mm, thickest, parts_volume_cm3, choices} (compact plans: each smaller choice and the mm it saves), total_usd, cannot_check, warnings, missing_data, next}. Tell the person the summary in plain words; if question is set, ask it (one question) and wait. Figures a part does not have are listed in missing_data, never guessed.',
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: 'The wish in the person\'s words, e.g. "a night light that plays a song".' },
          constraints: {
            type: "object",
            description: "Optional limits.",
            properties: {
              pocket: { type: "boolean", description: "Must fit in a pocket (about 110 x 70 x 30 mm)." },
              max_size_mm: { type: "object", properties: { w: { type: "number" }, h: { type: "number" }, d: { type: "number" } }, description: "Largest case, mm." },
              budget_usd: { type: "number" },
              battery_hours: { type: "number", description: "Hours it should run on one charge." },
              board: { type: "string", description: 'Force a board type, e.g. "arduino-nano".' },
              compact: { type: "boolean", description: "Pick the smallest parts that do the job (smallest board, screen, speaker and LiPo cell for the runtime, no boost converter unless something needs 5 V). On by itself when the goal says pocket, small, tiny, keychain or names a shape (an egg, a heart): those are custom outlines." },
            },
          },
        },
        required: ["goal"],
      },
      readOnly: true,
    },
    {
      name: "record",
      title: "Video of the build",
      description:
        'Record an MP4 the person can watch: your build replayed from the action log (parts appearing with your "why" captions, wires, the sketch, the device running in each run / run_tests, tests turning green). Only your calls by default (actor "mcp"); "all" adds the person\'s and the CLI\'s. Takes about as long as the video (speed is picked for about a minute unless given). Returns {path (absolute), url (open it in a browser), viewer_url (the live project, when Faber\'s server runs), duration_s}. Give the person the path or url, not a terminal command. Fails within seconds, saying how to install it, when Chromium is missing. Example: {} or {"speed": 3, "size": "1280x720"}.',
      inputSchema: {
        type: "object",
        properties: {
          actor: { type: "string", enum: ["mcp", "all"], description: 'Whose calls to show (default "mcp", the agent).' },
          ms: { type: "number", description: "Longest video in wall-clock ms (default: long enough for the whole replay)." },
          speed: { type: "number", description: "Replay speed-up (default: about a one-minute video)." },
          size: { type: "string", description: 'Video size, default "1280x720".' },
        },
      },
    },
    {
      name: "viewer_url",
      title: "Link to watch and play",
      description:
        "A link the person opens in their browser on this computer: the project live on the canvas, the device running with its real firmware, buttons and knobs they can press, following every change you make. Needs Faber's local server (faber serve / pnpm start); over plain stdio it says how to start one. Returns {url, note}. Give it to the person whenever they ask to see or try the device.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
    {
      name: "delete_file",
      title: "Delete a file",
      description:
        'Delete a file inside the project, e.g. a stale screenshot or a debug sketch: {"path": "shots/old.png"} or {"path": "firmware/probe.ino"}. Text files are an undoable step (undo brings them back); images, videos and other binary files are moved to .faber/trash/ (the result says where). Refuses faber.json, Faber\'s own .faber/ state and the board\'s main sketch (overwrite it with write_file instead).',
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative to the project folder." }, why }, required: ["path"] },
      edits: true,
    },
    {
      name: "mark_stand_in",
      title: "Mark a part as a stand-in",
      description:
        'Say that a placed part stands in for a real part Faber does not have, so BOM / WIRING exports print the real part with a STAND-IN note instead of the stand-in: {"id": "soil1", "real": "capacitive soil moisture sensor"}. plan_device lists stand-ins in its bom (source "stand-in"). Prefer a real part, or create_part, over a stand-in. {"id": "soil1", "real": null} clears it.',
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Part id, e.g. soil1." }, real: { type: ["string", "null"], description: "The real part in plain words." }, why }, required: ["id", "real"] },
      edits: true,
    },
  ],
  ops: {
    async plan_device(args, x) {
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      if (!goal) fail("missing-arg", "plan_device needs 'goal'", "the goal is empty", 'pass the wish in the person\'s words, e.g. { "goal": "a pet that fits in my pocket" }');
      if (args.constraints !== undefined && (typeof args.constraints !== "object" || args.constraints === null || Array.isArray(args.constraints))) {
        fail("bad-arg", "plan_device: constraints must be an object", `got ${JSON.stringify(args.constraints)}`, 'pass e.g. { "pocket": true, "budget_usd": 30 }');
      }
      const c = (args.constraints ?? {}) as PlanConstraints;
      for (const k of ["budget_usd", "battery_hours"] as const) {
        if (c[k] !== undefined && !(typeof c[k] === "number" && c[k]! > 0)) fail("bad-arg", `plan_device: constraints.${k} must be a positive number`, `got ${JSON.stringify(c[k])}`, `pass e.g. { "${k}": ${k === "budget_usd" ? 30 : 8} }`);
      }
      const size = c.max_size_mm as Record<string, unknown> | undefined;
      if (size !== undefined && !["w", "h", "d"].every((k) => typeof size?.[k] === "number" && (size[k] as number) > 0)) {
        fail("bad-arg", "plan_device: constraints.max_size_mm needs w, h and d in mm", `got ${JSON.stringify(c.max_size_mm)}`, 'pass e.g. { "max_size_mm": { "w": 90, "h": 60, "d": 25 } }');
      }
      const reg = x.session.registry;
      if (c.board !== undefined) {
        const defs = reg.list().filter((d) => d.spec.category === "board" && d.spec.mcu);
        const boards = defs.map((d) => d.spec.id);
        if (typeof c.board !== "string") fail("bad-arg", "plan_device: constraints.board must be a board id", `got ${JSON.stringify(c.board)}`, `pass one of: ${boards.join(", ")}`);
        // Round 10: short names a person uses ("esp32", "black pill", "pico") resolve to the one board they mean.
        let id: string | undefined;
        let several: string | undefined;
        try {
          id = resolveBoard(defs, c.board).spec.id;
        } catch (err) {
          const m = /fits several boards: (.*)\. Fix:/.exec((err as Error).message);
          several = m?.[1];
        }
        if (several) fail("ambiguous-board", `plan_device: '${c.board}' fits several boards`, `it could be ${several}`, "pass one of those ids as constraints.board");
        if (!id) fail("unknown-board", `plan_device: no board '${c.board}'`, `boards are: ${boards.join(", ")}`, `pass one of them or leave board out.${didYouMean(c.board, boards)}`);
        c.board = id;
      }
      const { allOpNames } = await import("../session.ts");
      const plan = planDevice(goal, c, reg, { createPartAvailable: allOpNames().includes("create_part") });
      x.summary(`plan: ${plan.board.type} + ${plan.bom.length - 1} lines, $${plan.total_usd}`);
      return plan;
    },

    async record(args, x) {
      const dir = x.session.dir;
      const r = await recordProject({
        dir,
        ...(args.actor !== undefined ? { actor: args.actor as "mcp" | "all" } : {}),
        ...(args.speed !== undefined ? { speed: Number(args.speed) } : {}),
        ...(args.size !== undefined ? { size: String(args.size) } : {}),
        ...(args.ms !== undefined ? { maxMs: Number(args.ms) } : {}),
      });
      const base = serverBase();
      const inMedia = r.path.startsWith(join(stateDirPath(dir), "media") + sep);
      const url = base && inMedia ? `${base}/api/media/${encodeURIComponent(basename(r.path))}` : pathToFileURL(r.path).href;
      const viewer = viewerUrlFor(dir);
      x.summary(`recorded a ${r.duration_s} s video (${r.entries} steps)`);
      return {
        path: r.path,
        url,
        viewer_url: viewer ?? null,
        duration_s: r.duration_s,
        format: r.format,
        speed: r.speed,
        actor: r.actor,
        steps: r.entries,
        ...(r.truncated ? { truncated: true } : {}),
        notes: [...r.notes, ...(viewer ? [] : ["no viewer_url: Faber's local server is not running, so the person can watch the file but not open the live project"])],
      };
    },

    async viewer_url(_args, x) {
      const url = viewerUrlFor(x.session.dir);
      if (!url) fail("no-server", "viewer_url: no Faber server is running for this project", "this MCP connection has no web page (a stdio server or the CLI)", NO_SERVER_FIX);
      return { url, note: "Open it in a browser on this computer: the project runs live with its firmware, the person can press its buttons and turn its knobs, and it follows every change you make. It is a local link (it does not work on another device)." };
    },

    async delete_file(args, x) {
      const s = x.session;
      const rel = relProjectPath(s.dir, args.path);
      if (rel === PROJECT_FILE || rel === LEGACY_PROJECT_FILE) fail("protected-file", `delete_file: refusing to delete ${rel}`, "it is the project itself", "remove parts, wires or tests with remove; start over with new_project");
      const state = [STATE_DIR, LEGACY_STATE_DIR].find((d) => rel === d || rel.startsWith(`${d}/`));
      if (state && !rel.startsWith(`${state}/media/`) && !rel.startsWith(`${state}/test-frames/`)) {
        fail("protected-file", `delete_file: refusing to delete ${rel}`, `the ${state} folder holds the action log, undo history and build cache`, `leave it; only ${state}/media and ${state}/test-frames files can be deleted`);
      }
      const abs = join(s.dir, rel);
      if (!existsSync(abs)) fail("no-file", `delete_file: no file ${rel}`, `nothing exists at ${abs}`, "check the path (list_files shows firmware files)");
      if (statSync(abs).isDirectory()) fail("bad-path", `delete_file: ${rel} is a folder`, "only single files can be deleted", "delete the files inside it one by one");
      const sketch = s.project.firmware?.sketch ? `firmware/${s.project.firmware.sketch}` : undefined;
      if (sketch && rel === sketch) fail("protected-file", `delete_file: ${rel} is the board's main sketch`, "the firmware build points at it", "overwrite it with write_file instead");
      const buf = readFileSync(abs);
      if (isBinary(buf) || buf.length > 2_000_000) {
        const trash = join(stateDirPath(s.dir), "trash");
        mkdirSync(trash, { recursive: true });
        let dest = join(trash, basename(rel));
        for (let i = 2; existsSync(dest); i++) dest = join(trash, basename(rel).replace(/(\.[^.]*)?$/, `-${i}$1`));
        renameSync(abs, dest);
        x.summary(`deleted ${rel} (moved to ${basename(dirname(trash))}/trash)`);
        return { deleted: rel, undoable: false, kept_in: dest, note: `binary files are not part of the undo history; it is kept in ${basename(dirname(trash))}/trash in case it is needed` };
      }
      x.commit(`delete_file ${rel}`, s.project, { [rel]: null });
      x.summary(`deleted ${rel}`);
      return { deleted: rel, undoable: true };
    },

    async mark_stand_in(args, x) {
      const s = x.session;
      const id = String(args.id ?? "");
      const part = s.project.parts.find((p) => p.id === id);
      const ids = s.project.parts.map((p) => p.id);
      if (!part) fail("unknown-part", `mark_stand_in: no part '${id}'`, `parts are: ${ids.join(", ") || "none"}`, `pass one of them.${didYouMean(id, ids)}`);
      const real = args.real === null || args.real === undefined ? null : String(args.real).trim();
      if (real !== null && (!real || real.length > 120)) fail("bad-arg", "mark_stand_in: 'real' must be 1 to 120 characters", `got ${JSON.stringify(args.real)}`, 'pass the real part in plain words, e.g. "capacitive soil moisture sensor", or null to clear');
      const next = {
        ...s.project,
        parts: s.project.parts.map((p) => {
          if (p.id !== id) return p;
          const { standIn: _old, ...rest } = p;
          return real ? { ...rest, standIn: real } : rest;
        }),
      };
      x.target(id);
      x.commit(`mark_stand_in ${id}`, next, {});
      x.summary(real ? `${id} stands in for ${real}` : `${id} is no longer a stand-in`);
      return { id, type: part.type, stand_in_for: real, note: real ? `exports print "${real}" with a STAND-IN note; the simulation still uses ${part.type}` : "cleared" };
    },
  },
};
