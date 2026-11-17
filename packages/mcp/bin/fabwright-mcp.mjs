#!/usr/bin/env node
// Fabwright MCP server on stdio. Usage: node packages/mcp/bin/fabwright-mcp.mjs --project <dir>
// (or FABWRIGHT_PROJECT=<dir>). See docs/agents.md for Claude Code / Codex config.
import { register } from "tsx/esm/api";
register();
// JUMPER_* variables from before the rename still work when the FABWRIGHT_* one is not set.
(await import("@fabwright/project-format/legacy")).applyLegacyEnv(process.env);
await import("../src/main.ts");
