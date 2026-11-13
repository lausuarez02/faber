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
`design_case`) → `get_assembly_plan` (what to buy, what to print, and how it goes together for that
case: the order per shell, when each wire is soldered, the battery last, a test before closing, a
picture per step; tell the person in plain words and fix what its `assembly-*` checks flag) →
`export_manufacturing` (case files for a printer, BOM, wiring, firmware, the assembly steps: the
factory pack). When the person builds it themselves ("what do I buy / print, how does it
go together"), `get_build_kit`: the shopping list with store links and totals, the print list with
grams and time, the tools, the assembly plan's steps into the case with cut lengths, flashing and
troubleshooting, as `build-kit/<name>-kit/kit.html` (and the Build it button in the Case view).
Case choices cost size: do not pin parts (`placements` x_mm / y_mm / layer / face) unless the person
asked for that spot, leave `dome_mm` and the edges on auto, and read `costs` in every `check_fit` /
`propose_layout` / `design_case` / `update_case` answer (what each choice adds, with the call that
relaxes it): relax the costly ones. Pocket and hand-held devices: aim for 20 mm thick or less.
Think how the person will put the stuff inside (what mounts where, insertion order, wire room,
USB / button access, battery safety) and, when asked what is needed, say what to buy, print,
assemble and flash with totals: [docs/hardware-guide.md](docs/hardware-guide.md) (also the MCP
resource `jumper://docs/hardware`, the prompts `design-device` / `build-kit` / `design-for-assembly`,
and the project skill `jumper skill install --project <dir>` writes).
Behaviour over time (things that happen at random, a spoken countdown before a picture, an offline
queue that posts later, battery life from duty cycles) is tested with scenarios too: each test seeds the
board's random numbers, `preceded_by` checks order and timing, `expect_capture` pictures, `request`
what an upload carried, `network_fault` wifi_drop / clear and `reset_board` (flash survives) the offline
path; `add_mock_api` {"kind": "openapi"} mocks any API from its spec; a local service is reached only
with `"local": true` + `"to"`; `estimate_power` / `set_power {target_hours, duty}` for battery life:
[docs/behaviour-tests.md](docs/behaviour-tests.md).
A case that holds something that is not electronics (a tin, a card deck) declares it with `design_case`
`{"held": [{"id", "name", "shape", "size_mm", "insert": "slide" | "pocket" | "snap", "from", "sensor"}]}`
(its real size with its source; tell the person to measure theirs with calipers). Always-on battery
devices: e-paper (`epaper-154-ssd1681`) or a memory LCD (`sharp-memory-lcd-128`), lids sensed by a
`reed-switch` or `hall-switch-drv5032` (`{"set": "lid.magnet", "value": "away"}` in a test), and
`esp_deep_sleep_start()` really sleeps in the simulator (no firmware runs, hours pass in seconds, it
wakes on its timer or a pin with RTC memory and the clock kept); `set_clock` also sets RTC parts;
`estimate_power` takes `wakes_per_day`: [docs/low-power.md](docs/low-power.md).
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
