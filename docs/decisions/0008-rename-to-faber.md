# 0008 — Jumper is now Faber

Status: accepted · 2026-11-17

## Decision

The project is renamed from **Jumper** to **Faber**: Latin for a maker or craftsman who works wood,
stone or metal (as in *homo faber*, "man the maker"). It says what the project does (design a device,
simulate it, and make it: case, kit, factory pack) instead of naming one part. The tagline stays: Figma for hardware, with a
real simulator underneath. Open source, Apache-2.0, for people and for AI agents through MCP.

Everything is renamed: the CLI (`faber`), the MCP server (`faber`, tools `mcp__faber__*`),
the packages (`@faber/*`), the project file (`faber.json`, format `faber/1`) and state
folder (`.faber/`), the user folder (`~/.faber`), the environment variables (`FABER_*`),
the Claude Code plugin and skill (`plugins/faber`, `faber-hardware`), the firmware shims
(`FaberSim`, `FaberSleep`, `FaberCamera`, `FaberEth`, `FaberRelay.h`), the QEMU
patches (`000N-faber-*.patch`, `hw/misc/faber_*`), the Renode models (`FaberBridge.cs`, …),
the Docker images (`faber/…`) and the sandbox names (`FaberNet`, `ai.faber`,
`relay.sandbox.faber`).

## Compatibility

Existing projects, scripts and firmware must keep working with no edits
([migrating-from-jumper.md](../migrating-from-jumper.md) has the full list):

- **One lookup rule** for files and folders (`packages/project-format/src/node.ts`): the new name when
  it exists, else the old name when that exists, else the new name. So an old project keeps writing
  its `jumper.json` and `.jumper/` (nothing appears or moves behind the person's back, and its git
  history stays in one file), a new one gets `faber.json`, and `~/.jumper` (gigabytes of installed
  toolchains) is used until `~/.faber` exists.
- **Environment:** every `JUMPER_<NAME>` fills `FABER_<NAME>` when that is unset, once, in each
  entry point (`applyLegacyEnv`), so the rest of the code reads only the new names.
- **Firmware:** forwarding headers under the old names, `JUMPER_SIM` defined next to `FABER_SIM`,
  the old sleep marker, SSID and host names accepted, and a person's `jumper_device.h` treated as the
  secret it is (never compiled by Faber's builds).
- **Commands:** `jumper` is an alias bin that says once, on stderr, that it is now `faber`.

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


## Update, 2026-11-17: Faber, not Fabwright

The first rename was to "Fabwright". The same day the name became **Faber** (Latin for a maker or craftsman, as in *homo faber*, "man the maker"): shorter, and fabwright.dev / fabwright.com were already registered by others. Fabwright was never released, so no fallback reads it; the Jumper fallbacks above stay.
