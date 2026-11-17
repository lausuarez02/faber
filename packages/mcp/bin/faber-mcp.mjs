#!/usr/bin/env node
// Faber MCP server on stdio. Usage: node packages/mcp/bin/faber-mcp.mjs --project <dir>
// (or FABER_PROJECT=<dir>). See docs/agents.md for Claude Code / Codex config.
import { register } from "tsx/esm/api";
register();
// JUMPER_* variables from before the rename still work when the FABER_* one is not set.
(await import("@faber/project-format/legacy")).applyLegacyEnv(process.env);
await import("../src/main.ts");
