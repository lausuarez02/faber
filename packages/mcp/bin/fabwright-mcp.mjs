#!/usr/bin/env node
// Fabwright MCP server on stdio. Usage: node packages/mcp/bin/fabwright-mcp.mjs --project <dir>
// (or FABWRIGHT_PROJECT=<dir>). See docs/agents.md for Claude Code / Codex config.
import { register } from "tsx/esm/api";
register();
await import("../src/main.ts");
