# Exploring robot with an OLED face, built live by Claude Code

Built from a one-line goal by Claude Code connected to `faber serve` over **HTTP MCP**, with
**only Faber's tools** allowed. The live canvas was open in a browser the whole time and recorded.
This folder is the agent's final project, unedited (plus `final.png` and one browser shot).

<p align="center"><img src="../../../docs/media/live-claude-robot.gif" alt="Claude Code builds the robot on the live canvas, the arena view shows 3 collisions and then the fix, the robot explores in the 3D Device view, and the Tests panel filmstrip is scrubbed" width="720"></p>

Video (91 s, 1440x900 H.264): [`docs/media/live-claude-robot.mp4`](../../../docs/media/live-claude-robot.mp4).
What it shows: 0:00 the empty live canvas; 0:02-0:31 the build at 10x (parts, wires, the
firmware card, the arena view with **3 collisions**, the fix "dodge earlier and weave", happy and
surprised faces on the OLED, 3/3 tests); 0:35 the Device view (3D) running the robot for about 55
virtual seconds with track, chase, arena and orbit cameras, 0 collisions; 1:02 the canvas with
the serial log; 1:08 the Tests panel; 1:18 a filmstrip frame opened in 3D at 1.26 s (the first dodge).

Replay the agent's steps yourself: `pnpm faber replay examples/agent-built/claude-robot/agent-actions.jsonl`.

## The prompt (exact)

> Build a little robot on wheels that explores an arena on its own: it drives around, uses an
> ultrasonic sensor to avoid walls and obstacles, and has an OLED face that looks happy while
> cruising and surprised when it has to dodge something. Use an Arduino, an L298N motor driver, two
> DC motors on a 2WD chassis and a battery. Prove with scenario tests that it explores for 60
> seconds without colliding and that the face changes when it dodges, then show it running in the
> 3D device view. Use the faber tools; the owner is watching the canvas live, so explain each step
> in its why.

## The agent and how it ran

- **Agent:** Claude Code 2.1.319, model claude-opus-5-5, 2026-11-09.
- **Server:** `pnpm faber serve --project <empty folder> --port 7791` (Docker running for builds).
- **Command** (run from the project folder; your real `~/.claude` is not touched):

```sh
claude -p "<prompt>" \
  --mcp-config '{"mcpServers":{"faber":{"type":"http","url":"http://localhost:7791/mcp"}}}' \
  --strict-mcp-config --allowedTools mcp__faber \
  --output-format stream-json --verbose --max-turns 250
```

| What | Number |
| --- | --- |
| Wall time | **277 s** (4 min 37 s), 73 turns |
| Faber tool calls | 66, **1 error** (`remove boots`, see friction) |
| Other tool attempts | 3 denied by the harness (2 `Edit`, 1 `Bash` on `firmware/main.ino`; a `Read` of it went through); it fell back to `write_file` |
| Tokens | 1.85 M cache read, 86 k cache write, 25 k out; reported cost $1.57 |
| Firmware writes | 3 (`write_file`), every build compiled first time |
| Firmware iterations | 2: the first sketch hit obstacles **3 times** in 60 s (clipped the box corner: the ±15° sonar beam is narrower than the 15 cm body); dodge at 40 cm plus a weave fixed it. The happy face's smile mask erased half of each eye; fixed before saving the golden frame |
| Test runs | 1: **3/3 passed** |

Tool calls: 23 `connect`, 7 `place_part`, 6 `get_part`, 5 `run`, 3 `write_file`, 3 `read_display`,
3 `write_scenario`, 3 `screenshot` (two of them `view: "device"`), 2 `search_parts`, 2 `check_design`,
and one each of `new_project`, `get_project`, `set_world`, `set_part_property`, `set_libraries`,
`remove`, `run_tests`, `fidelity_report`, `export`.

What it built: Uno, L298N (5V-EN jumper off, logic from the Uno's 5 V), two DC motors on a 2WD
chassis, 2S LiPo (7.4 V) on the driver and the Uno's VIN, HC-SR04 on D9/D10, SSD1306 on A4/A5.
Arena 250x200 cm with a crate, a pillar and a box. Firmware: cruise with a gentle weave, dodge at
< 40 cm (back up, spin until > 70 cm clear, random extra turn), face redrawn only on mood change.

## Tests (the agent's, in `faber.json`)

| Scenario | Checks |
| --- | --- |
| `explores-60s-no-collision` | runs exactly 60 000 ms, then `world.collisions == 0`, `world.min_clearance_cm >= 3`, `world.travelled_cm >= 1000`, at least 10 dodges, no errors |
| `face-changes-on-dodge` | OLED **pixels** match the golden `happy-face` at boot, `surprised-face` within 200 ms of dodge #1, `happy-face` again once clear, `surprised-face` again at dodge #2 |
| `boots` | the starter template's placeholder (the agent could not delete it; it passes) |

## Verified by a person (the experimenter), not by the agent

- `faber check` on a copy: 0 errors, 0 warnings. `faber build --force`: compiles (Adafruit
  SSD1306 2.5.17, GFX 1.13.0, BusIO 1.17.4). `faber test`: **3/3 pass**; 60 s run 0 collisions,
  closest 9.0 cm, 23.2 m travelled; face matches 0.6-1.6 % pixel difference. `faber fidelity`:
  8 behavioural parts, 25 checks for the real robot.
- In the browser (Device view, local copy) it drove **77 virtual seconds with 0 collisions**,
  closest 9.0 cm, 29.8 m, 49 dodges; the OLED on the canvas alternated happy / surprised.
- Added to `packages/session/test/examples.test.ts` ("agent-built examples", at least 3 passing).
- **Not verified:** real hardware; the 3D face on the rover is small and mounted facing forward,
  so the track and chase cameras see its back (orbit to the front to read it).

## Friction (from the transcript and the recording)

1. **"The template's `boots` test can't be removed with `remove`, which only handles parts and
   wires, so I'm leaving it in."** No tool deleted a scenario. **Fixed in this round:** `remove`
   now deletes a test scenario by id (undoable; the miss message lists scenario ids too), with a
   test in `connect-polish.test.ts`.
2. **"Editing the file directly needs a permission I don't have, so I'll go through Faber's
   `write_file` instead."** The agent wanted a two-line change; Faber has no partial edit, so it
   resent the whole 168-line sketch three times. Root cause: `write_file` is whole-file only.
3. **Device view Run did nothing while following the agent** (`pnpm start` page): the "Following
   an agent session" toast is hidden behind the full-screen Device view. To film the robot I had
   to open `/?local`, import `faber.json` and load `firmware/main.hex` by hand. A fix (`GET
   /api/project` + a clearer toast) was in progress in the working tree by another session at the
   time of writing.
4. **The Tests filmstrip shows the arena, not the screen,** for the face checks of a robot: the
   `oled1 matches surprised-face` frame is a top view of the rover. The check text is right, the
   picture does not show what was checked.
5. **Scrub view title overlap:** opening a filmstrip frame in 3D draws the Device title on top of
   the canvas title block (top-left "Explorer Bot" twice).
6. The agent pill kept saying "building · 29 steps · 29 to review" after the agent had finished.
