# AGENTS.md

You are an agent in the Jumper repo. Jumper is a browser hardware sandbox: Arduino boards, parts and
wires on a canvas, real compiled firmware, a deterministic simulator.

## To build a device (not to change Jumper)

Use the MCP server or the CLI. You never need to read Jumper's source.

```sh
node /Users/lautaritos/Projects/hardware/jumper/apps/cli/bin/jumper.mjs mcp --project /path/to/my-device   # MCP server on stdio
pnpm jumper mcp --project ../my-device          # same, from inside the repo
pnpm jumper new ../my-device --template blink   # or drive it from the shell, same operations
pnpm jumper test -p ../my-device
```

The loop: `search_parts` → `get_part` → `place_part` → `connect` → `check_design` → `write_file` →
`run` (builds automatically) → `write_scenario` → `run_tests` → fix → `fidelity_report`.
Full guide with a worked example: [docs/agents.md](docs/agents.md). Tool reference:
[docs/mcp-tools.md](docs/mcp-tools.md). Every error says what failed, why, and the fix: do what it says.

## To change Jumper itself

- Read `STATUS.md`, then `docs/contracts.md` (APIs) and `docs/part-spec.md` (parts).
- pnpm workspaces, Node 24, TypeScript sources exported directly (no build step between packages).
- `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`; `pnpm gen` after touching a part, the project schema or a tool definition.
- Determinism: no `Date`, `Math.random` or timers in `sim-core`, `sim-backends`, part models or `physics`.
- Original work only (no Wokwi code or assets), MIT/Apache-2.0-compatible dependencies, no secrets.
- Agent surface: `packages/session` (the engine; tool definitions in `src/catalog.ts`),
  `packages/mcp`, `apps/cli`, `services/runner` (Docker builds), `apps/web/src/live` (follow / replay).
