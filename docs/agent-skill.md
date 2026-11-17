# The hardware skill: how Claude (and any agent) learns to build the real thing

A person asks an agent for a device, then asks "what do I need to build it, what do I print, how do I
put it all inside". Faber answers that with tools (`get_assembly_plan`, `get_build_kit`) and with
know-how injected into the agent so it thinks about assembly from the first answer, not after the
case is printed. The know-how is written once and rendered into every place an agent reads.

## One source

`packages/agent-skill/src/knowledge.ts` holds, for any device (nothing per project):

- **The loop**: goal → `plan_device` → smallest parts that fit (`check_fit`, `propose_layout`, read
  `costs`) → think how it goes together (checklist, before the case) → `design_case` →
  `get_assembly_plan` (fix its `assembly-*` checks) → firmware and tests → `get_build_kit`.
- **Rules of thumb**, each with what every face must say and must not say: pocket devices 20 mm thick
  or less, smallest parts then prove the fit, a board with a built-in charger for battery devices, no
  pinning, dome and edges on auto, read costs, `propose_layout` before `design_case`, say what was not
  tested, never put API keys in firmware.
- **"How it goes inside" checklist**: where each part mounts, insertion order, wire room, access from
  outside, battery safety, closing and opening, printing.
- **The answer to "what do I need to build it?"**: Buy / Print / Assemble / Flash with totals.

A step that needs a tool names it in `needs` with a fallback that uses only tools that exist; the
renderer picks from the live tool list, so the text never names a tool the server does not have.

## Where it reaches the agent

| Face | What | Rendered by |
| --- | --- | --- |
| MCP server instructions | The loop (AGENT_LOOP) ends with a short "Design for assembly" block | `renderInstructionsBlock` |
| MCP prompts | `design-device` (argument `goal`), `build-kit`, `design-for-assembly` | `renderPrompt` |
| MCP resource | `faber://docs/hardware`, the whole guide ([hardware-guide.md](hardware-guide.md)) | `renderGuide` |
| Claude Code, in a project | `<project>/.claude/skills/faber-hardware/SKILL.md` and `<project>/CLAUDE.md` importing `AGENTS.md` (Claude Code always loads CLAUDE.md; in the round-12 runs it never picked the skill by itself) | `faber skill install`, `new_project`, `faber new`, Open in Agent → Launch |
| Codex and others | `<project>/AGENTS.md` | same |
| Claude Code, anywhere | The plugin in [plugins/faber](../plugins/faber/README.md): the skill and the MCP server of a running Faber (`http://localhost:7780/mcp`) | `pnpm gen` |

Project files someone wrote by hand are kept unless `--force`; `FABER_AGENT_FILES=0` turns writing
them off. `faber skill print [--target skill|agents|guide|instructions]` prints any face. Nothing is
written to `~/.claude`; the plugin is installed by the person (`claude --plugin-dir
/path/to/faber/plugins/faber` for one session, or `/plugin install`).

## What the tools give the agent

- `get_assembly_plan` (after `design_case`): what to buy, what to print (each STL with the face on the
  bed), consumables and tools, and the steps in an order that is physically possible, with which
  shell each part goes into, what holds it, when each wire is soldered, the battery last, a test
  before closing and a picture per step; plus the design-for-assembly checks. See
  [enclosures.md](enclosures.md#how-it-goes-together-round-12).
- `get_build_kit`: the person-ready kit built on that plan: shopping list with variants, links and
  totals, print list with grams and time, tools, the steps, flashing and troubleshooting, as
  `kit.html` / PDF / zip. See [build-kit.md](build-kit.md).

## Keeping it true

`pnpm gen` regenerates `plugins/faber/skills/faber-hardware/SKILL.md` and `docs/hardware-guide.md`.
`packages/session/test/agent-skill-sync.test.ts` fails when a face names a tool that does not exist
(or an operation that is neither a tool nor a schema field), when an optional tool is named while
missing, when a rule's must-say is absent from the instructions, the skill or AGENTS.md, when a
must-not-say appears anywhere (including tool descriptions), or when the pocket thickness differs.

## Limits

- The model does not always choose to load a skill; the project `CLAUDE.md` is what makes the guide
  certain in Claude Code. Other clients get the server instructions and prompts.
- In the round-12 runs the agent called `propose_layout` before `design_case` but never `check_fit`.
- `plan_device` itself still picks a board without a charger for some battery devices; the skill makes
  the agent offer the swap.
- The plugin's MCP address is fixed at `localhost:7780`.
