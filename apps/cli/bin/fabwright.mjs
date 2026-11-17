#!/usr/bin/env node
// The jumper CLI. Runs the TypeScript sources through tsx (no build step).
//   node apps/cli/bin/jumper.mjs help        or, at the repo root:  pnpm jumper help
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/main.ts");
const code = await main(process.argv.slice(2));
// Long-running commands (mcp, serve, replay, runner) resolve only when stopped.
process.exitCode = code;
if (code !== undefined) setTimeout(() => process.exit(code), 50).unref();
