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

Plan first: `plan_device` and tell the person the plan in plain words (ask one question if the wish
is ambiguous); `new_project {"folder": true}` per idea; real parts or `create_part` over stand-ins.
The loop: `search_parts` → `get_part` → `place_part` → `connect` → `check_design` → `write_file` →
`run` (builds automatically) → `write_scenario` → `run_tests` → fix → show it (`screenshot`,
`record`, `viewer_url`) → `fidelity_report` (say what the simulation cannot check).
When the person wants a real device, finish with `design_case` (shape, renders, measured size,
fit checks; any shape they name, an egg or a heart, is `"shape": "custom"` with an `outline` you
draw and maybe `size_mm`: `check_fit` first says what fits and what smaller parts would;
`propose_layout` shows how Jumper would distribute the parts inside, thinnest / smallest / balanced,
with the reasons: tell the person which one and why, `layout: "<id>"` picks it; call it before
`design_case`) → `export_manufacturing` (case files for a printer, BOM, wiring, firmware, assembly
steps: the factory pack).
Case choices cost size: do not pin parts (`placements` x_mm / y_mm / layer / face) unless the person
asked for that spot, leave `dome_mm` and the edges on auto, and read `costs` in every `check_fit` /
`propose_layout` / `design_case` / `update_case` answer (what each choice adds, with the call that
relaxes it): relax the costly ones. Pocket and hand-held devices: aim for 20 mm thick or less.
Think how the person will put the stuff inside (what mounts where, insertion order, wire room,
USB / button access, battery safety) and, when asked what is needed, say what to buy, print,
assemble and flash with totals: [docs/hardware-guide.md](docs/hardware-guide.md) (also the MCP
resource `jumper://docs/hardware`, the prompts `design-device` / `build-kit` / `design-for-assembly`,
and the project skill `jumper skill install --project <dir>` writes).
Full guide with a worked example: [docs/agents.md](docs/agents.md). Tool reference:
[docs/mcp-tools.md](docs/mcp-tools.md). Every error says what failed, why, and the fix: do what it says.

## To change Jumper itself

- Read `STATUS.md`, then `docs/contracts.md` (APIs) and `docs/part-spec.md` (parts).
- pnpm workspaces, Node 24, TypeScript sources exported directly (no build step between packages).
- `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`; `pnpm gen` after touching a part, the project schema or a tool definition.
- Determinism: no `Date`, `Math.random` or timers in `sim-core`, `sim-backends`, part models or `physics`.
- Original work only (no Wokwi code or assets), MIT/Apache-2.0-compatible dependencies, no secrets.
- Agent surface: `packages/session` (the engine; tool definitions in `src/catalog.ts`),
  `packages/agent-skill` (the hardware know-how every agent face is rendered from; `pnpm gen` after changing it),
  `packages/mcp`, `apps/cli`, `services/runner` (Docker builds), `apps/web/src/live` (follow / replay).
