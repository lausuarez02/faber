# Projects, history and code

Round 5, projects track ([decision 0003](decisions/0003-round5-see-it-work.md), C3). This needs the
local server: `pnpm start` (or `jumper serve --project <folder>`) and the page it opens. Without
the server (`pnpm dev`, a static build) the app shows the bundled examples and the examples' code
read-only, and says what needs the server.

## Projects home

Click the logo (top left) or **All projects** on an empty canvas. The page lists:

- **Your projects**: the folders in the projects folder (`projects/` for `pnpm start`, otherwise the
  parent of `--project`), plus every folder in `$JUMPER_HOME/projects.json` (`~/.jumper` by default).
  Folders get into that file when `jumper serve` or `jumper mcp` is started with `--project` (not
  for folders under the OS temp dir), when the web app creates or opens a project, and when an
  agent makes a new project folder (`new_project {folder}`, agent track).
- **Examples** and **Built by agents**: `examples/` and `examples/agent-built/`. They are read-only.
  Opening one copies it into the projects folder (`projects/<slug>`) and opens the copy, so neither
  the repo nor the circuit you had open is changed. An agent-built example's `agent-actions.jsonl`
  becomes the copy's history, so you can scrub through how the agent built it. Either way the
  copy as it came is a version (`open_example`, round 6): version 1 for an example, the last one
  for an agent-built example, so you can always restore the original.

Each card shows a render of the canvas with the device as it last ran: the last run or test in the
action log (lit LEDs, OLED and colour screens), or, for a project with built firmware and no such
run (the examples, a log from before colour screens were logged), the firmware run headless for 2 s.
It is cached as a PNG by the sha256 of `jumper.json` and the log's size, in
`<project>/.jumper/thumbs/` or `$JUMPER_HOME/thumbs/` for examples (rendered again when either
changes; an SVG is served when Playwright's Chromium is not installed), next to the board, the part
count, the last `run_tests` result and when it last changed. The server draws missing thumbnails in the
background shortly after it starts (one at a time, about 1 s each; `JUMPER_WARM_THUMBS=0` turns
that off), and a tile still waiting says "Drawing the circuit…".

**First screen (round 6).** The server's root lands on the Projects page when the active project
is a fresh playground (no parts) or this browser never opened a project; once you open, create or
close the page, you land on the canvas. Links that carry more than `?follow` (the viewer
`/v/:id`, `?autorun=1`) always open the canvas.

Opening a project switches the server's **active project**: the same MCP endpoint and live
websocket now work on it (an agent that is connected keeps working, on the new folder), and the
canvas reloads. Round 6 (decision 0004, R8): nothing of the old project comes along. The
simulation stops and resets, the old firmware is dropped before the new board loads, the code card
shows the new project's sketch, toasts, captions and test results are cleared, and History and the
code editor close. The page emits one switch event (`apps/web/src/lib/projectSwitch.ts`) that every
part of the UI resets on. An empty project shows a welcome with the pitch, four example cards and "or press +
to add a part".

## History

The clock next to the project name (or **History** in the project menu). Every change is a
version: version N is the N-th line of `.jumper/actions.jsonl` that changed the circuit or a file,
whoever made it (an agent, you on the canvas, the CLI). For each version the scrubber shows:

- the canvas at that version, with the device state of the run or test that followed it (lit LEDs,
  OLED pixels, colour TFT and round screens, live wires). Colour screens are logged as PNGs in the
  run's frames (`Frame.color`, round 6); runs logged before that show them dark, and the caption says so;
- what changed (`+ part buzzer1`, `~ file firmware/main.ino +3 −1`, `− wire w3`), who did it and
  why. Files count lines added and removed, also for changes that rewrite files without logging
  them (restore, undo, reject);
- the firmware hash that matches that version: built while it was current, or built earlier with
  no code change since. A sketch edit that was never built says "not built at this version" (the
  hex is kept in `.jumper/builds/<hash>.hex`; logs from before round 5 recorded a build without
  its hash);
- **Code at this version** (read-only) and **Restore this version**.

Restoring is a new version at the end (and an undoable step), so nothing is lost. The same is
available to agents as the `restore_version` tool.

How files are rebuilt: the log keeps the content of every `write_file` (up to 50 000 characters;
a longer file makes that version "approximate" and restore refuses with the reason). Files written
without a log entry (template files of `new_project`, undo / reject / restore of a write) come from
the undo history (`.jumper/history.json`). A firmware file Jumper never changed is shown as it is on
disk now.

## Code editor

Click the sketch or a file in the **Firmware** panel, or **Code** in the project menu. CodeMirror 6
with C++ highlighting. **Save** (⌘S) is `write_file` and **Build & Run** (⌘↵) is `build` then
`run` for 3 s, both through the server's queue as actor `web`: the exact path agents and the CLI
use, and the agent sees your edit as a step. Your own edits (actor `web`: the editor, a restore)
are never listed as pending in **Agent steps** or counted "to review" on the agent pill. Compile errors from arduino-cli are underlined at
their line, with the fix in the tooltip and in the problems list (click one to jump to it). On a
followed canvas the server's run shows on the canvas; a page running its own simulation (`?local`)
loads the new firmware and runs it. Files an agent changes while the editor is open reload unless
you have unsaved edits in them.

## HTTP endpoints

All local-only; changes need `x-jumper-token` from `GET /api/connect`. Errors are
`{ error: "<what failed>. Why: … Fix: …" }`.

| Method, path | Answer |
| --- | --- |
| `GET /api/projects` | `{ active, projects: ProjectCard[], examples: ProjectCard[] }` |
| `GET /api/projects/:id` | `{ card, project, files }` |
| `GET /api/projects/:id/thumbnail.png` | the canvas render |
| `POST /api/projects` `{ name, template?, from? }` | `{ id, dir }`; creates (or copies example `from`), registers and opens it |
| `POST /api/projects/:id/open` | `{ id, dir }`; 409 for examples (copy them) |
| `GET /api/history` | `{ id, dir, versions: VersionSummary[] }` |
| `GET /api/history/:version` | `{ version, summary, project, files, firmware?, frame?, changes }` |
| `GET /api/history/:version/preview.svg` | the canvas at that version with its run's device state |
| `POST /api/history/:version/restore` `{ why? }` | the `restore_version` result |
| `GET /api/files` | `{ files: { path, size }[], main }` |
| `GET /api/file?path=` | `{ path, content }` |
| `PUT /api/file` `{ path, content }` | the `write_file` result |
| `POST /api/build` `{ run?, ms? }` | `{ ok, diagnostics: [{ file, line, column, severity, message, hint }], hash?, hex?, size?, run? }` |

Tests: `apps/cli/test/projects.test.ts`, `apps/web/e2e/projects-flow.spec.ts`.
