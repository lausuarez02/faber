# Built by agents

Each folder is a device an AI agent built from a one-line goal using only Fabwright's MCP tools, kept
exactly as the agent left it, with the prompt, the agent's numbers, what a person checked
afterwards and what the simulation does not prove.

| Device | Agent | Time | Tool calls (failed) | Tests | Video |
| --- | --- | --- | --- | --- | --- |
| [claude-tamagotchi](claude-tamagotchi/README.md): Uno, SSD1306 OLED, 3 buttons, buzzer | Claude Code 2.1.319 | 358 s, $1.48 | 59 (2) | 8/8 | [mp4](../../docs/media/agent-claude-tamagotchi.mp4) |
| [codex-rover](codex-rover/README.md): Uno, L298N, 2 DC motors, HC-SR04, battery, 2WD chassis | codex-cli 0.163.0 (gpt-6.1-sol, low effort) | 109 s | 44 (0) | 2/2 | [mp4](../../docs/media/agent-codex-rover.mp4) |
| [claude-robot-arm](claude-robot-arm/README.md): Uno, 2 SG90 servos, 2 pots, REC/PLAY buttons | Claude Code 2.1.319 | 127 s, $0.88 | 62 (0) | 6/6 | [mp4](../../docs/media/agent-claude-robot-arm.mp4) |
| [claude-robot](claude-robot/README.md): Uno, L298N, 2 DC motors, HC-SR04, SSD1306 face, 2S LiPo, 2WD chassis (built live over HTTP MCP, canvas recorded) | Claude Code 2.1.319 | 277 s, $1.57 | 66 (1) | 3/3 | [mp4](../../docs/media/live-claude-robot.mp4) |
| [claude-ai-pet](claude-ai-pet/README.md): Uno, ILI9341 colour TFT, ESP-01 Wi-Fi (sandbox AI), 3 buttons, buzzer (built live over HTTP MCP, canvas recorded; real Claude replies in the Device view) | Claude Code 2.1.319 | 576 s, $2.69 | 98 (4) | 5/5 | [mp4](../../docs/media/live-claude-ai-pet.mp4) |
| [claude-pocket-muse](claude-pocket-muse/README.md): XIAO RP2040, GC9A01 round TFT, MPU-6050, pet button, buzzer, 500 mAh LiPo + TP4056; re-wired in round 6 (switch + 1N5817) so the LiPo powers it with USB unplugged | Claude Code 2.1.321 | 682 s, $2.64 | 88 (2) | 11/11 (8 the agent's) | – |

All three were re-checked on 2026-11-09 against the current `main` (`fabwright check`, `test`,
`fidelity`; the builds are cached from a forced rebuild right after each run).
`packages/session/test/examples.test.ts` runs their scenarios on every `pnpm test`.

Open one in the CLI like any project: `pnpm fabwright test -p examples/agent-built/codex-rover`.
Replay how it was built: `pnpm fabwright replay examples/agent-built/codex-rover/agent-actions.jsonl`.

Earlier runs (round 1, before the fixes their friction led to) are in
[docs/media/agent-runs](../../docs/media/agent-runs/README.md).
