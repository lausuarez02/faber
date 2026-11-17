#!/usr/bin/env node
// `jumper`: the command's name before the project was renamed Faber. Kept so scripts and MCP
// configs that still call it work; it says so once on stderr (stdout stays clean for MCP stdio and
// --json) and runs `faber` with the same arguments. See docs/migrating-from-jumper.md.
process.stderr.write("jumper: this command is now called faber (same arguments); `jumper` still works for now.\n");
await import("./faber.mjs");
