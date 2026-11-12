# Jumper plugin for Claude Code

Two things for Claude Code, from this repository:

- **The `jumper-hardware` skill** (`skills/jumper-hardware/SKILL.md`): Jumper's hardware know-how. Claude plans the device, picks the smallest parts that fit, thinks how every part goes inside (what mounts where, the insertion order, wire room, USB and button access, battery safety), designs the printable case, tests the firmware, and answers "what do I need to buy, print and how do I put it together".
- **The `jumper` MCP server** of a running Jumper app (`.mcp.json`: `http://localhost:7780/mcp`). Start Jumper first with `pnpm start` in this repository; if it runs on another port, change the URL in `.mcp.json`.

The skill file is generated from `packages/agent-skill` by `pnpm gen`; do not edit it by hand.

## Install (you run this; Jumper never installs anything on its own)

For one session, without installing:

```sh
claude --plugin-dir /path/to/jumper/plugins/jumper
```

To keep it, add this repository as a plugin marketplace and install the plugin (Claude Code 2.1.275 or later):

```sh
/plugin install jumper --marketplace /path/to/jumper
```

or, in two steps: `/plugin marketplace add /path/to/jumper` then `/plugin install jumper@jumper`.

## Without the plugin

Every Jumper project already carries the skill: `new_project`, `jumper new`, the app's **Open in Agent → Launch Claude Code** and `jumper skill install --project <dir>` write `<project>/.claude/skills/jumper-hardware/SKILL.md` (Claude Code loads it when it runs in that folder) and `<project>/AGENTS.md` (Codex and other agents). Files you wrote yourself are kept. Any MCP client also gets the same know-how from the server: its instructions, the prompts `design-device`, `build-kit` and `design-for-assembly`, and the resource `jumper://docs/hardware`.

## Privacy

The plugin talks only to the Jumper server on your own machine (localhost). Nothing is sent anywhere else.
