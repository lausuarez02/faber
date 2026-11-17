# Migrating from Jumper

Fabwright was called **Jumper** until 2026-11-17 ([decision 0008](decisions/0008-rename-to-fabwright.md)).
Everything was renamed: the CLI, the MCP server and its tools, the packages, the project file, the
environment variables and the firmware shims. Projects, scripts and firmware made before the rename
keep working without changes. This page lists what still reads the old names, and how to move to the
new ones when you want to.

## What keeps working

| Before | Now | What happens to the old one |
| --- | --- | --- |
| `jumper` command | `fabwright` | `jumper` still works: it prints one line on stderr ("this command is now called fabwright") and runs `fabwright` with the same arguments. stdout is unchanged, so `--json` and MCP over stdio are not affected. |
| `jumper.json` | `fabwright.json` | A folder with only `jumper.json` opens as a project. Fabwright keeps reading and writing `jumper.json` there (no second file appears next to it). New projects get `fabwright.json`. |
| `"format": "jumper/1"` | `"fabwright/1"` | Read as the same format. The next save writes `"fabwright/1"`. |
| `<project>/.jumper/` | `.fabwright/` | Used when it is the folder there (action log, history, thumbnails, media, run audio). New projects get `.fabwright/`. |
| `~/.jumper/` | `~/.fabwright/` | Used when `~/.fabwright` does not exist, so the toolchains and emulators you installed (about 10 GB) keep working without `fabwright setup`. |
| `JUMPER_*` variables | `FABWRIGHT_*` | Each `JUMPER_<NAME>` is used when `FABWRIGHT_<NAME>` is not set. When both are set, `FABWRIGHT_<NAME>` wins. |
| MCP server `jumper`, tools `mcp__jumper__*` | `fabwright`, `mcp__fabwright__*` | Re-add the server under its new name (below). An MCP config that runs `apps/cli/bin/jumper.mjs mcp` keeps working through the alias, but its tools are still listed under the name you gave the server. |
| `JumperRelay.h`, `jumper_device.h`, `jumperRelayUrl()`, `JUMPER_TOKEN_HEADER` | `FabwrightRelay.h`, `fabwright_device.h`, `fabwrightRelayUrl()`, `FABWRIGHT_TOKEN_HEADER` | A sketch that includes `JumperRelay.h` still builds, in the simulator and for the device: Fabwright adds a forwarding `JumperRelay.h` when the folder has none, and the simulator also writes a `jumper_device.h` for an old copy of the header. `FabwrightRelay.h` reads `jumper_device.h` when there is no `fabwright_device.h`. Your own `jumper_device.h` is never compiled by Fabwright's builds, like `fabwright_device.h`. |
| `JumperSim.h`, `JumperSleep.h`, `JumperCamera.h`, `jumper_eth.h` | `FabwrightSim.h`, `FabwrightSleep.h`, `FabwrightCamera.h`, `fabwright_eth.h` | Thin forwarding headers under the old names (with the old function names as macros). |
| `#ifdef JUMPER_SIM` | `FABWRIGHT_SIM` | ESP32 simulation builds define both. |
| Wi-Fi `JumperNet`, hosts `ai.jumper`, `relay.sandbox.jumper` | `FabwrightNet`, `ai.fabwright`, `relay.sandbox.fabwright` | Firmware that joins `JumperNet` joins the default sandbox network, and the old host names resolve to the same sandbox hosts. |
| Agent-made parts `"format": "jumper-part/1"` | `"fabwright-part/1"` | Read as the same format. |
| `.claude/skills/jumper-hardware/`, AGENTS.md / CLAUDE.md "Written by Jumper" | `.claude/skills/fabwright-hardware/` | `fabwright skill install` (and `fabwright serve`) update files Jumper wrote, and remove the old skill folder when Jumper wrote it, so an agent does not load two guides. A file you edited by hand is left alone. |
| Browser settings (`jumper.theme`, `jumper:kit:*`, …) | `fabwright.*`, `fabwright:*` | Copied to the new keys the first time the app opens. |
| Deep-sleep line `[jumper:sleep]` | `[fabwright:sleep]` | Both are understood, so a firmware image built by an older version still sleeps and wakes. |

## What to do yourself (when you want to)

- **Rename a project file.** `git mv jumper.json fabwright.json` and `git mv .jumper .fabwright`
  (or delete `.jumper` if you do not need its history). Both at once: Fabwright picks
  `fabwright.json` and `.fabwright/` as soon as they exist.
- **Your user folder.** `mv ~/.jumper ~/.fabwright` moves the installed toolchains, emulators and the
  projects list in one step. Until then `~/.jumper` is used.
- **MCP clients.** Remove the old server and add the new one, for example in Claude Code:
  `claude mcp remove jumper && claude mcp add --transport http fabwright http://localhost:7780/mcp`.
  Permission rules that name `mcp__jumper__*` need the new prefix `mcp__fabwright__*`. The Claude
  Code plugin is now `plugins/fabwright` (skill `fabwright-hardware`).
- **Environment.** Rename `JUMPER_*` to `FABWRIGHT_*` in your shell profile and CI.
- **Firmware that uses the relay.** Change `#include "JumperRelay.h"` to `#include "FabwrightRelay.h"`
  and the `jumper*` / `JUMPER_*` names to `fabwright*` / `FABWRIGHT_*`, then run
  `fabwright relay device-header` (it writes `fabwright_device.h`) and delete the old
  `jumper_device.h` and `JumperRelay.h` from the sketch folder.
- **Docker images.** The images are now tagged `fabwright/…` (for example
  `fabwright/qemu-esp:9.2.2-20260417-jb7`, `fabwright/arduino-esp32:3.3.12-r3`, `fabwright/renode:1.17.0-r1`).
  With `FABWRIGHT_RUNTIME=docker`, run `fabwright setup` once to build them. Native runtimes (the
  default on a Mac without Docker) need nothing.
- **Local QEMU sources.** `FABWRIGHT_QEMU_SRC` still uses the spike repository's branch `jumper-jb7`
  (`QEMU_SRC_BRANCH`): that branch lives outside this repository and keeps its name.

## Not renamed on purpose

"Jumper" as an electronics word is still there: jumper wires (the BOM's "Jumper wires (dupont)"),
the L298N's `regulatorJumper` / `enaJumper` / `enbJumper` props, solder jumpers, address jumpers and
the TTP223's A / B jumpers. Those are parts of real boards, not the product.
