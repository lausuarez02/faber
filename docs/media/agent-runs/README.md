# Agent runs: one-line goal to tested device (round 1)

> The later runs (round 2, after the fixes below) are in
> [examples/agent-built](../../../examples/agent-built/README.md), with the projects themselves and
> 1440x900 videos in `docs/media/agent-*.mp4`.

Three real, unedited runs (2026-11-09). Each agent was started fresh in an empty folder with only
the Jumper MCP server (no shell, no file tools, no access to Jumper's source) and a one-paragraph goal.
Each `.actions.jsonl` is the session's own action log; the `.mp4` is `jumper record` of that log
(`pnpm jumper replay <file>` plays it in the browser).

| Run | Agent | Goal | Wall time | Tool calls | Failed calls | Result |
| --- | --- | --- | --- | --- | --- | --- |
| [claude-builds-tamagotchi](claude-builds-tamagotchi.mp4) | Claude Code (`claude -p`) | Tamagotchi pet: Uno, SSD1306 OLED face + stats, 3 buttons, buzzer, hunger/happiness decay | 4.9 min, $1.03 | 54 | 1 | 9/9 scenarios pass |
| [codex-builds-rover](codex-builds-rover.mp4) | Codex (`codex exec`) | 2WD obstacle-avoiding rover: Uno, L298N, 2 DC motors, HC-SR04, battery, chassis, arena with obstacles | 4.0 min | 48 | 0 | 5/5 pass, incl. a 10-minute run with zero collisions |
| [claude-builds-robot-arm](claude-builds-robot-arm.mp4) | Claude Code | 2-joint servo arm, each joint driven by its own potentiometer | 1.9 min, $0.73 | 47 | 1 | 6/6 pass |

What went wrong, and what changed because of it:

- **Tamagotchi**: the sketch declared `enum Mood` and used it as a return type; Arduino's
  auto-generated prototypes land above the enum, so it failed with "'Mood' does not name a type". The
  hint then said "add a library", which was wrong; Claude fixed it anyway by moving the enum to
  `pet.h`. The runner now detects types declared in the sketch and gives the right fix.
- **Robot arm**: the agent wrote a scenario step `{"inject_fault": "pot1", "kind": "noisy", "field": …,
  "amplitude": …}`, which the tool accepted but the scenario schema did not. Scenario fault steps now
  take the same options as the tool. Its noise test then caught a real firmware bug (the servo
  chattered between 87° and 91° on ±1 % knob noise), which it fixed with smoothing and a deadband.
- **Rover (Codex)**: `codex exec` refuses every editing tool unless the server is configured with
  `default_tools_approval_mode = "approve"`; that line is now in the setup docs.

Prompts used:

- Claude, pet: "Build a tamagotchi-style pet on an Arduino Uno: an SSD1306 OLED shows its face and
  stats, three buttons (feed, play, show stats) and a buzzer that chirps. Hunger and happiness drop
  over time. Use only the jumper tools. Make sure it really works: write scenario tests for each
  behaviour and get them all passing, then tell me what still needs testing on real hardware."
- Codex, rover: "Build a 2-wheel obstacle-avoiding robot rover: Arduino Uno, L298N motor driver, two
  DC motors, an HC-SR04 ultrasonic sensor, battery pack, robot chassis, driving in an arena with a few
  obstacles. Use only the jumper MCP tools … write scenario tests (it moves, it never collides) and get
  them passing, then tell me what still needs testing on real hardware."
- Claude, arm: "Build a small 2-joint servo robot arm on an Arduino Uno: two SG90 servos (shoulder and
  elbow) each controlled by its own potentiometer … write scenario tests (knob to angle mapping, both
  joints independent) and get them passing …"
