# Faber plugin for Claude Code

Two things for Claude Code, from this repository:

- **The `faber-hardware` skill** (`skills/faber-hardware/SKILL.md`): Faber's hardware know-how. Claude plans the device, picks the smallest parts that fit, thinks how every part goes inside (what mounts where, the insertion order, wire room, USB and button access, battery safety), designs the printable case, tests the firmware, and answers "what do I need to buy, print and how do I put it together".
- **The `faber` MCP server** of a running Faber app (`.mcp.json`: `http://localhost:7780/mcp`). Start Faber first with `pnpm start` in this repository; if it runs on another port, change the URL in `.mcp.json`.

The skill file is generated from `packages/agent-skill` by `pnpm gen`; do not edit it by hand.

## Install (you run this; Faber never installs anything on its own)

For one session, without installing:

```sh
claude --plugin-dir /path/to/faber/plugins/faber
```

To keep it, add this repository as a plugin marketplace and install the plugin (Claude Code 2.1.275 or later):

```sh
/plugin install faber --marketplace /path/to/faber
```

or, in two steps: `/plugin marketplace add /path/to/faber` then `/plugin install faber@faber`.

## Without the plugin

Every Faber project already carries the skill: `new_project`, `faber new`, the app's **Open in Agent → Launch Claude Code** and `faber skill install --project <dir>` write `<project>/.claude/skills/faber-hardware/SKILL.md` (Claude Code loads it when it runs in that folder) `<project>/AGENTS.md` (Codex and other agents) and `<project>/CLAUDE.md` (imports AGENTS.md, so Claude Code always has the guide in context). Files you wrote yourself are kept. Any MCP client also gets the same know-how from the server: its instructions, the prompts `design-device`, `build-kit` and `design-for-assembly`, and the resource `faber://docs/hardware`.

## Privacy

The plugin talks only to the Faber server on your own machine (localhost). Nothing is sent anywhere else.
