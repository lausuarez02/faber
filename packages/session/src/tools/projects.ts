import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../errors.ts";
import { projectEntities, same } from "../history.ts";
import { listVersions, versionDetail, versionFiles } from "../versions.ts";
import type { ToolModule } from "./types.ts";

/**
 * Track "projects" (owner): restore_version.
 * Contract: docs/decisions/0003-round5-see-it-work.md, C3 and C5.
 *
 * A version is an ok action-log line that changed the project or a file (src/versions.ts).
 * Restoring one is itself a new, undoable edit: the circuit, scenarios and firmware block go back to
 * that version, and the source files Faber knows about get that version's content (files that did
 * not exist then are deleted). Nothing in the history is thrown away.
 */
export const projectsTools: ToolModule = {
  name: "projects",
  tools: [
    {
      name: "restore_version",
      title: "Restore an earlier version",
      description:
        'Put the project back the way it was at version N of its history (parts, wires, props, scenarios, firmware block and the sketch files). Versions are numbered from 1 in the order changes happened; the web app\'s History scrubber shows them, and GET /api/history lists them with who made each change and why. Restoring is a new step (undo brings the newer state back), and the firmware is rebuilt on the next run. Example: {"version": 4, "why": "go back to before the buzzer was added"}. Returns {version, step, changes: {added, removed, changed}} (entity keys such as "part:led1", "wire:w3", "file:firmware/main/main.ino").',
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "integer", minimum: 1, description: "Version number, 1 = the first change in the history." },
          why: { type: "string", description: 'Short reason shown to the human in the step list, e.g. "back to the working version".' },
        },
        required: ["version"],
      },
      edits: true,
    },
  ],
  ops: {
    restore_version(args, x) {
      const s = x.session;
      const n = Number(args.version);
      const count = listVersions(s.dir).length;
      if (!Number.isInteger(n) || n < 1) fail("bad-arg", `restore_version: version ${String(args.version)} is not valid`, "versions are whole numbers starting at 1", count ? `pass a number from 1 to ${count}` : "make a change first; every change becomes a version");
      if (n > count) fail("unknown-version", `There is no version ${n}`, count ? `this project has ${count} version${count === 1 ? "" : "s"}` : "this project has no recorded changes yet (.faber/actions.jsonl is empty)", count ? `pass a number from 1 to ${count} (GET /api/history lists them)` : "make a change first; every change becomes a version");
      const detail = versionDetail(s.dir, n)!;
      if (detail.approxFiles.length) {
        fail("version-incomplete", `Version ${n} cannot be restored exactly`, `${detail.approxFiles.join(", ")} ${detail.approxFiles.length > 1 ? "were" : "was"} longer than the 50000 characters the action log keeps`, "restore a later version, or rewrite the file with write_file");
      }
      const files: Record<string, string | null> = {};
      for (const [path, content] of versionFiles(s.dir, n)) {
        if (/\.(hex|bin|elf)$/.test(path) || path.split("/").includes("..")) continue;
        const now = existsSync(join(s.dir, path)) ? readFileSync(join(s.dir, path), "utf8") : null;
        if (!same(now, content)) files[path] = content;
      }
      const before = projectEntities(s.project);
      const after = projectEntities(detail.project);
      const changes = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const a = before[k] ?? null;
        const b = after[k] ?? null;
        if (same(a, b)) continue;
        (a === null ? changes.added : b === null ? changes.removed : changes.changed).push(k);
      }
      for (const [path, content] of Object.entries(files)) {
        const existed = existsSync(join(s.dir, path));
        (content === null ? changes.removed : existed ? changes.changed : changes.added).push(`file:${path}`);
      }
      const total = changes.added.length + changes.removed.length + changes.changed.length;
      if (!total) {
        x.summary(`version ${n} is the same as the current project`);
        return { version: n, step: null, changes, note: `nothing to restore: the project already matches version ${n}` };
      }
      const step = x.commit(`restore_version ${n}`, detail.project, files);
      x.summary(`restored version ${n}${detail.summary.why ? ` ("${detail.summary.why}")` : ""}: ${total} change${total === 1 ? "" : "s"}`);
      return { version: n, step: step.id, changes, next: "run (it rebuilds the firmware if the sketch changed) or run_tests" };
    },
  },
};
