#!/usr/bin/env node
// Jumper MCP server on stdio. Usage: node packages/mcp/bin/jumper-mcp.mjs --project <dir>
// (or JUMPER_PROJECT=<dir>). See docs/agents.md for Claude Code / Codex config.
import { register } from "tsx/esm/api";
register();
await import("../src/main.ts");
