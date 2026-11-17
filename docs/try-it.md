# Try it yourself

A hands-on script: what to type, what to click, and what you should see. Three parts, about
15 minutes in all: the AI pet, the robot, then Claude Code building something new while you watch.
Both devices were built by Claude Code with only Fabwright's tools (videos:
[`docs/media/live-claude-ai-pet.mp4`](media/live-claude-ai-pet.mp4),
[`docs/media/live-claude-robot.mp4`](media/live-claude-robot.mp4)).

You need Node 24, pnpm 10 (`corepack enable`) and Docker Desktop running (firmware builds). Once,
in the repo:

```sh
pnpm i
```

Every `pnpm start` below prints the URL it uses. It is `http://localhost:7780/` unless that port is
taken (then the next free one; use what it prints). Stop it with Ctrl+C before starting the next.

## 1. The AI pet (colour screen, AI inside)

```sh
pnpm fabwright test --visual -p examples/agent-built/claude-ai-pet   # 5/5, saves the Tests filmstrips (about 30 s)
pnpm start --project examples/agent-built/claude-ai-pet
```

Open **`http://localhost:7780/?local`** (`?local` = run the project here, with its built firmware).

1. **Run** (top right, or Space). The clock bottom-left starts counting. After about 3 s the colour
   screen on the canvas shows Pip: a face, FOOD and JOY bars, a Wi-Fi badge, and "Hi! I'm Pip.
   Press TALK!". The Network panel on the right logs `wifi1 joined FabwrightNet`.
2. **Device view**: the third icon in the top-right group (a screen on a stand). The pet becomes a
   3D handheld with the live screen behind glass.
   - Press **1 / 2 / 3** (or click the round buttons) for **TALK / FEED / PLAY**. TALK shows a speech
     bubble; FEED and PLAY fill the bars; the face changes with the mood (top-right readout:
     food, joy, energy, mood).
   - **Drag** to orbit, scroll to zoom. The palette icons top-right change the shell colour.
   - Wait without pressing anything: it gets hungry and sad and double-beeps for attention.
   - **Esc** closes the Device view.
3. **Mock vs Live AI.** The Network panel's **Mock / Live** switch picks who answers TALK.
   - **Mock** (default): deterministic canned replies, the same every run (the tests use it).
   - **Live**: real Claude. Start the gateway first in another terminal:
     ```sh
     node services/ai-gateway/bin/ai-gateway.mjs      # port 8787; uses ANTHROPIC_API_KEY, else your logged-in `claude` CLI
     ```
     then click **Live**. Press TALK: after 2 to 4 s a new sentence from Claude Haiku appears in
     the bubble (each request is logged in the panel with its latency and "who answered"). Without
     the gateway, Live says what failed and the command to start it. Live answers only while the sim
     runs at 1x or slower.
4. **Tests**: the flask icon (top right). "5/5 passed, 44 checks". Each scenario opens into a
   filmstrip: the screen at every check, with what the check saw. **Click a frame** to open the 3D
   device at that exact moment, then scrub.
5. **Wi-Fi drop**: the scenario "Wi-Fi drops: shows OFFLINE, retries, recovers and talks again" in the Tests panel shows the
   OFFLINE badge in its filmstrip (the test cuts the sandbox Wi-Fi; the browser has no button for
   that yet, and the 3D scrub view cannot replay the cut).

## 2. The robot (OLED face, drives itself)

```sh
pnpm fabwright test --visual -p examples/agent-built/claude-robot   # 3/3 (about 20 s)
pnpm start --project examples/agent-built/claude-robot
```

Open **`http://localhost:7780/?local`**.

1. **Run**. The World card (right) shows the arena from above: the robot drives, leaves a trail and
   turns away before walls and the crate / pillar / box. Collisions stay at 0. The OLED on the
   canvas shows its face: happy while cruising, surprised when it dodges.
2. **Device view** (same icon). The robot in a 3D arena with spinning wheels and the sonar beam.
   - **F** cycles the cameras: track, chase, arena. **Drag** to orbit.
   - The readout (top right) shows distance, speed, wheel speeds, collisions, travelled and closest.
     After a minute: 0 collisions, about 20 m travelled, closest about 9 cm.
3. **Tests** (flask icon): "3/3 passed". "Explores the arena for 60 s" asserts 0 collisions and the
   clearance; "Face is happy while cruising, surprised while dodging" compares the OLED pixels with saved
   frames. Click a frame to open that moment in 3D.

## 3. Watch Claude Code build something new

```sh
pnpm start                       # follows projects/playground; open the URL it prints (no ?local)
```

In a second terminal (anywhere):

```sh
claude mcp add --transport http fabwright http://localhost:7780/mcp     # once
claude
```

In Claude Code, `/mcp` lists **fabwright** as connected. Ask for a device, for example:

> Use the fabwright tools to build a plant monitor on an Uno: a soil moisture knob, an SSD1306 OLED
> showing the level, and a buzzer that beeps when it is dry. Write scenario tests and run them.

What to expect:

- Claude Code asks permission the first time it uses each Fabwright tool (choose "don't ask again" for
  `fabwright` to let it run).
- The canvas shows each step as it happens: parts appear, wires draw, the **Agent steps** panel lists
  every step with Claude's "why", the agent pill (bottom right) says what it is doing: "No agent"
  (grey, with Connect) until Claude calls a tool, then "building", "idle" after 10 s of quiet, and
  "done" when its session ends.
- Firmware builds take 10 to 40 s the first time (Docker). Test runs show in the Tests panel.
- **Run** runs what it built right on this page, with the latest firmware the agent built. When the
  agent builds, runs or tests again, the page reloads the firmware and starts the device by itself
  (untick **Auto-run** in the Live bar to stop that). While it runs: click a button's cap to press
  it (a quick click holds it at least 120 ms, so the sketch sees it; hold to keep it down), drag a
  knob to turn it, click a slide switch to flip it, drag the IMU part to tilt it. To move a part
  while it runs, drag its body away from the cap, or its label, or pick **Arrange** in the **Live
  controls** card. That card is docked at the bottom right (panels stack above it, never over it,
  and it collapses): a tilt pad, **Shake** (a click shakes for the set duration, holding shakes for
  as long as you hold), **Drop**, **Spin**, and a slider for what each sensor measures. Motions run
  on simulation time, so they wait while paused. These values only change the running simulation,
  never `fabwright.json`. Serial follows the newest line unless you scroll up (then **Newest** jumps
  back); once you zoom or pan, run, save and build leave your view alone.

Other agents: `codex mcp add fabwright --url http://localhost:7780/mcp`; Cursor and Claude Desktop
snippets are in the **Install MCP** menu (top right).

## Known gaps

- **The page's run and the agent's run are two simulations** of the same project and firmware: what
  you press here does not reach the agent's session, and the agent's runs do not move your device
  (they only reload it). A sketch the agent changed but has not built yet keeps running the last
  build here (the Live bar says "sketch changed, not built yet").
- **IMU motions are approximate** (a 7 Hz shake, 0.4 s of free fall then a 6 g bump, 360 °/s spin),
  played on simulation time: shapes firmware usually detects, not a model of a hand.
- **An agent on a separate stdio MCP process** (`fabwright mcp --project`) shows as "idle" after it
  stops, never "done": the server cannot see that process end. HTTP clients (`claude mcp add
  --transport http`) and `--attach` show "done".
- **Opening a test frame in 3D** draws the Device title over the project title (top left), and the
  toolbar stays visible. Fault steps (Wi-Fi drop) are not replayed in the scrub view.
- **The robot's filmstrip** shows the arena for its face checks, not the OLED. In 3D the robot's
  face points forward, so the track and chase cameras mostly see its back; use orbit.
- **Live AI** needs the gateway running, pauses above 1x speed, and once returned an empty reply
  that was cached for 15 s (not reproduced since).
- **Firmware builds** need Docker; the browser cannot build firmware itself.
- **Boards**: Uno / Nano (ATmega328P) only. Wi-Fi is the ESP-01 sandbox (FabwrightNet), not the real
  internet.
- The Network panel is desktop-only; on a phone the exchange shows in the serial console.
