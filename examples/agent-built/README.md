# Built by agents

Each folder is a device an AI agent built from a one-line goal using only Jumper's MCP tools, kept
exactly as the agent left it, with the prompt, the agent's numbers, what a person checked
afterwards and what the simulation does not prove.

| Device | Agent | Time | Tool calls (failed) | Tests | Video |
| --- | --- | --- | --- | --- | --- |
| [claude-tamagotchi](claude-tamagotchi/README.md): Uno, SSD1306 OLED, 3 buttons, buzzer | Claude Code 2.1.319 | 358 s, $1.48 | 59 (2) | 8/8 | [mp4](../../docs/media/agent-claude-tamagotchi.mp4) |
| [codex-rover](codex-rover/README.md): Uno, L298N, 2 DC motors, HC-SR04, battery, 2WD chassis | codex-cli 0.163.0 (gpt-6.1-sol, low effort) | 109 s | 44 (0) | 2/2 | [mp4](../../docs/media/agent-codex-rover.mp4) |
| [claude-robot-arm](claude-robot-arm/README.md): Uno, 2 SG90 servos, 2 pots, REC/PLAY buttons | Claude Code 2.1.319 | 127 s, $0.88 | 62 (0) | 6/6 | [mp4](../../docs/media/agent-claude-robot-arm.mp4) |

All three were re-checked on 2026-11-09 against the current `main` (`jumper check`, `test`,
`fidelity`; the builds are cached from a forced rebuild right after each run).
`packages/session/test/examples.test.ts` runs their scenarios on every `pnpm test`.

Open one in the CLI like any project: `pnpm jumper test -p examples/agent-built/codex-rover`.
Replay how it was built: `pnpm jumper replay examples/agent-built/codex-rover/agent-actions.jsonl`.

Earlier runs (round 1, before the fixes their friction led to) are in
[docs/media/agent-runs](../../docs/media/agent-runs/README.md).
