# 0008 — Jumper is now Fabwright

Status: accepted · 2026-11-17

## Decision

The project is renamed from **Jumper** to **Fabwright**: "fab" for fabrication, "wright" for a maker
(shipwright, wheelwright). It says what the project does (design a device, simulate it, and make it:
case, kit, factory pack) instead of naming one part. The tagline stays: Figma for hardware, with a
real simulator underneath. Open source, Apache-2.0, for people and for AI agents through MCP.

Everything is renamed: the CLI (`fabwright`), the MCP server (`fabwright`, tools `mcp__fabwright__*`),
the packages (`@fabwright/*`), the project file (`fabwright.json`, format `fabwright/1`) and state
folder (`.fabwright/`), the user folder (`~/.fabwright`), the environment variables (`FABWRIGHT_*`),
the Claude Code plugin and skill (`plugins/fabwright`, `fabwright-hardware`), the firmware shims
(`FabwrightSim`, `FabwrightSleep`, `FabwrightCamera`, `FabwrightEth`, `FabwrightRelay.h`), the QEMU
patches (`000N-fabwright-*.patch`, `hw/misc/fabwright_*`), the Renode models (`FabwrightBridge.cs`, …),
the Docker images (`fabwright/…`) and the sandbox names (`FabwrightNet`, `ai.fabwright`,
`relay.sandbox.fabwright`).

## Compatibility

Existing projects, scripts and firmware must keep working with no edits
([migrating-from-jumper.md](../migrating-from-jumper.md) has the full list):

- **One lookup rule** for files and folders (`packages/project-format/src/node.ts`): the new name when
  it exists, else the old name when that exists, else the new name. So an old project keeps writing
  its `jumper.json` and `.jumper/` (nothing appears or moves behind the person's back, and its git
  history stays in one file), a new one gets `fabwright.json`, and `~/.jumper` (gigabytes of installed
  toolchains) is used until `~/.fabwright` exists.
- **Environment:** every `JUMPER_<NAME>` fills `FABWRIGHT_<NAME>` when that is unset, once, in each
  entry point (`applyLegacyEnv`), so the rest of the code reads only the new names.
- **Firmware:** forwarding headers under the old names, `JUMPER_SIM` defined next to `FABWRIGHT_SIM`,
  the old sleep marker, SSID and host names accepted, and a person's `jumper_device.h` treated as the
  secret it is (never compiled by Fabwright's builds).
- **Commands:** `jumper` is an alias bin that says once, on stderr, that it is now `fabwright`.

All of it is named in `packages/project-format/src/legacy.ts` (or next to the code that needs it, with a
comment saying so), and tested in `packages/project-format/src/legacy.test.ts`,
`packages/session/test/legacy-names.test.ts`, `apps/cli/test/legacy-alias.test.ts`,
`services/runner/test/legacy-libraries.test.ts` and `apps/web/src/lib/legacyStorage.test.ts`.

## Kept

- "Jumper" as an electronics word: jumper wires, solder / address jumpers, the L298N's
  `regulatorJumper` / `enaJumper` / `enbJumper`, the TTP223's A / B jumpers.
- `QEMU_SRC_BRANCH = "jumper-jb7"`: a branch in the spike QEMU repository outside this one.
- Committed firmware images that print the old name (`esp32c3_blink_io.merged.bin.gz` says
  "hello from jumper esp32"), until they are rebuilt; their sources say so.
- Paths of folders outside the repository in older notes (`jumper-evals/…`).
- The mark: still a jumper wire with a dupont connector at each end. It was bent into the J of
  Jumper; a mark for the new name is open.
