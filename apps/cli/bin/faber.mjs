#!/usr/bin/env node
// The faber CLI. Runs the TypeScript sources through tsx (no build step).
//   node apps/cli/bin/faber.mjs help        or, at the repo root:  pnpm faber help
import { register } from "tsx/esm/api";
register();
// JUMPER_* variables from before the rename still work when the FABER_* one is not set.
(await import("@faber/project-format/legacy")).applyLegacyEnv(process.env);
const { main } = await import("../src/main.ts");
const code = await main(process.argv.slice(2));
// Long-running commands (mcp, serve, replay, runner) resolve only when stopped.
process.exitCode = code;
if (code !== undefined) setTimeout(() => process.exit(code), 50).unref();
