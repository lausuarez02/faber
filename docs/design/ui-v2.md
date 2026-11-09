# Jumper UI v2: floating controls on a quiet canvas

Status: implemented in `apps/web` (2026-11-09). Tokens live in `brand/tokens.css` (v2 block; the
old variable names are aliases, so nothing that read them breaks).

## Why

v1 was a classic IDE frame: a top bar, a parts column on the left, an inspector column on the
right, a dock on phones. It worked, but it framed the circuit like a form and spent a third of the
screen on chrome. v2 gives the canvas the whole window and floats a few precise controls over it.

## What we looked at (structure only, no code or assets taken)

| Tool | What we kept |
| --- | --- |
| Figma (UI3) | Everything floats over the canvas in rounded containers; the properties panel appears for the selection and goes away; one primary action per screen. |
| tldraw | Corner zoning: file/menu top-left, actions top-right, tools in one bar, zoom/minimap in a bottom corner, nothing along the edges. Tools have one-key shortcuts (V, H, W). |
| Excalidraw | "Islands": small rounded containers with hairline borders and a soft shadow, ghost icon buttons, a help dialog for shortcuts. |
| Flora / Krea (AI canvases) | Near-black dot grid, a vertical tool rail centred on the left with a white "+" on top, node cards with a muted label above them, a single white pill as the primary button, sparse green for "live" status, a queue/agent pill bottom-right. |

## Layout (desktop, 1440 x 900)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [J] Tamagotchi pet  …                     ┌ ▣ ⚗ ▭ │ Install MCP ▾ Open in Agent ▾ ⟲ (▶ Run|1×▾) ┐ │
│ Local workspace · Arduino Uno · 6 parts   └─────────────────────────────────────────────┘ │
│ ┌──┐                                                                ┌──────────────┐     │
│ │ +│                         canvas (dot grid)                      │ floating     │     │
│ │ ▤│                                                                │ panels stack │     │
│ │ ⌄│                 tiny label above each part                     │ (Inspector,  │     │
│ │ ◎│                 ┌─────────────┐                                │ Serial, Tests│     │
│ │──│                 │ part visual │                                │ World …)     │     │
│ │ ↖│                 └─────────────┘                                └──────────────┘     │
│ │ ✋│                                                                                     │
│ │ ⌇│                                                                                     │
│ │ ⌕│                                                                                     │
│ │ ☰│                                                                                     │
│ │ ⚗│                                                                                     │
│ │──│                                                                                     │
│ │ …│                                                                                     │
│ └──┘                                                                                     │
│ ┌─minimap──────────┐                                                                     │
│ └──────────────────┘                                                                     │
│ (☾) (?) (🎓)  [● 00:13.500 │ 1.00× rt]                      [Agent idle >] (⣿)            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Top-left**, no container: white Jumper mark, project name (15 px, medium, editable on click)
  and a muted `…` project menu (rename, new blank, open example, import / export `jumper.json`,
  load firmware `.hex`, export BOM / netlist). Subtitle in 13 px muted gray:
  `Local workspace · Arduino Uno · 6 parts` (follow mode: `Following <dir>`; replay: `Replay`).
- **Top-right**, one container: ghost icons `Serial console`, `Tests`, `Device view`; a hairline
  divider; outlined dropdowns `Install MCP ▾` and `Open in Agent ▾` (bodies come from
  `src/connect/`); a ghost `Reset`; the white primary pill `Run` / `Pause` with the speed as a split
  segment.
- **Left**, a vertical tool rail centred in the space between the title and the bottom-left
  cluster: white `+` (parts library popover), Firmware, a chevron that expands the rail to show
  labels, Instruments; separator; Select (V), Hand (H), Wire (W), Jump to part (/), Agent steps,
  Tests; separator; `…` more (undo, redo, fit view, zoom, shortcuts, theme).
- **Right**: floating panels stack in one column under the top-right container (Inspector opens for
  the selection, Serial, Tests, Firmware, Instruments, World, Agent steps). Each is closable;
  none is docked chrome.
- **Bottom-left**: minimap card (280 x 150), then 48 px circular buttons (theme, help / shortcuts,
  learn), then the status pill: green dot + virtual clock, a divider, the real-time factor.
  Gray when stopped or paused.
- **Bottom-right**: `Agent  idle >` pill (or `building · 3 steps`, `replay · 12/40`) opening the
  agent steps panel, and the dot-matrix avatar (`AgentPresence`) showing which agent is attached.

## Phone (390 x 844)

Title top-left (subtitle hidden), top-right collapses to the Run pill + `⋯` (serial, tests,
device view, install MCP, open in agent, theme, help). The rail becomes a horizontal floating bar
at the bottom (`+`, wire, jump, undo, redo, serial, inspector, more). Panels become bottom sheets
above the bar, one at a time. The status pill sits above the bar on the left. The canvas still pans
(one finger), pinches and runs.

## Canvas

- Background `--bg-canvas`, dots `--dot` every 22 px (size 1.2).
- Parts: a label above each part (`icon id · type`, 12 px muted, mono id) and the part's own SVG.
  Selection: a 1.5 px white (light: black) rounded outline 6 px out, not blue.
- Wires: 2.5 px core, colors mixed 18 % toward gray (desaturated), a thin dark casing; HIGH wires
  get the green glow and the moving dashes, nothing else glows.
- Pins: hover ring in the wire red, valid target ring green; label tooltip in mono.

## Tokens (`brand/tokens.css`)

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg-canvas` | `#0A0A0A` | `#FAFAFA` | canvas, page |
| `--dot` | `#1F1F1F` | `#E0E0E0` | dot grid |
| `--bg-float` | `#131313` | `#FFFFFF` | floating containers, panels |
| `--bg-rail` | `#111111` | `#FFFFFF` | tool rail |
| `--bg-raised` | `#1A1A1A` | `#F5F5F5` | outlined buttons, inputs |
| `--bg-node` | `#141414` | `#FFFFFF` | node cards, minimap |
| `--bg-active` | `#2A2A2A` | `#EDEDED` | active tool, hover |
| `--border` | `#232323` | `#E5E5E5` | hairlines |
| `--border-strong` | `#2E2E2E` | `#D9D9D9` | outlined buttons |
| `--fg` | `#EDEDED` | `#0A0A0A` | text |
| `--fg-2` | `#B4B4B4` | `#404040` | secondary text, icons |
| `--fg-muted` | `#8A8A8A` | `#737373` | subtitles, labels |
| `--fg-faint` | `#5A5A5A` | `#A3A3A3` | placeholders, separators text |
| `--primary` / `--on-primary` | `#FFFFFF` / `#0A0A0A` | `#0A0A0A` / `#FFFFFF` | the one primary pill |
| `--accent` | `#3DDC97` | `#0E9F63` | live / running status only |
| `--warn` | `#F5A524` | `#B7791F` | warnings |
| `--error` | `#F2555A` | `#D93036` | errors |
| `--select` | `#FFFFFF` | `#0A0A0A` | selection outline |
| `--r-sm` `--r-md` `--r-lg` `--r-xl` | 8 / 12 / 16 / 18 px | | radii |
| `--shadow-float` | `0 16px 48px -12px rgb(0 0 0 / .6)` | softer | floating containers |
| `--dur` | 150 ms | | transitions |

Old names map onto these: `--ink → --bg-canvas`, `--panel → --bg-float`, `--panel-2 → --bg-raised`,
`--line → --border`, `--text → --fg`, `--muted → --fg-muted`, `--live → --accent`,
`--grid-dot → --dot`.

Type: Geist Variable for UI (13 / 14 / 15 px), Geist Mono Variable for pins, ids, serial, numbers.
Weights 400 / 500 only; no uppercase eyebrows except tiny section labels in panels.

## Rules

1. Nothing touches a screen edge: every control is 16 px in, inside a rounded container or alone.
2. One primary (white) button per screen. Everything else is ghost or outlined.
3. Color means something: green = running / live, amber = warning, red = error, wire colors.
4. Hairline borders, no gradients, one soft shadow for floating things.
5. Every interactive element has a visible focus ring (`--focus-ring`, 2 px).
6. 150 ms transitions; respect `prefers-reduced-motion`.

## Mount points for other builders

| Where | Component | Contract |
| --- | --- | --- |
| `Install MCP ▾` body | `apps/web/src/connect/InstallMcpMenu.tsx` | `export function InstallMcpMenu(props: { onClose(): void })` |
| `Open in Agent ▾` body | `apps/web/src/connect/OpenInAgentMenu.tsx` | `export function OpenInAgentMenu(props: { onClose(): void })` |
| Bottom-right avatar | `apps/web/src/connect/AgentPresence.tsx` | `export function AgentPresence()` (36 px circle) |
| Device view button | `apps/web/src/views/device/DeviceView.tsx` | `export function DeviceView(props: { onClose(): void })`, rendered full-canvas over everything |
| Tests panel body | `apps/web/src/views/tests/VisualTestReport.tsx` | `export function VisualTestReport()`, rendered inside the Tests floating panel |

## Component map (`apps/web/src`)

| Area | File |
| --- | --- |
| Shell, keyboard, theme, refit on chrome changes | `App.tsx` |
| UI state (tool, open panels, popover, rail labels, device view) | `lib/ui.ts` |
| Top-left title, project menu, subtitle | `shell/TitleBlock.tsx` |
| Top-right container, Run pill (+ speed), phone `⋯` menu | `shell/TopActions.tsx` |
| Tool rail (desktop vertical, phone bottom bar), jump-to, more menu | `shell/ToolRail.tsx` |
| Parts library popover body | `components/PartsLibrary.tsx` |
| Right panel column: Agent steps, Inspector, Serial, Tests, Firmware, Instruments, Shortcuts, Learn | `shell/Panels.tsx` |
| World card (robot projects) | `components/WorldPanel.tsx` |
| Bottom-left round buttons + status pill; bottom-right agent pill | `shell/Corners.tsx` |
| Icon button, popover, floating panel, menu item | `shell/primitives.tsx` |
| Fit (chrome-aware), export / import, BOM, netlist, new project | `shell/actions.ts` |
| Part node (label above + artwork), wires, canvas, minimap | `components/PartNode.tsx`, `WireEdge.tsx`, `Canvas.tsx` |
| Follow / replay overlays (live bar, tests, code, caption, cursor; steps list in the Agent panel) | `live/LiveLayer.tsx`, `live/live.css` |

Keyboard: Space run/pause · V/H/W tools · A add part · `/` or ⌘K jump to part · R rotate · C wire
color · ⌫ delete · ⌘Z / ⇧⌘Z · ⇧1 fit · +/− zoom · I inspector · `` ` `` serial · ? shortcuts · Esc.

Screenshots for review: `node apps/web/scripts/ui-shots.mjs <baseUrl> <outDir> [scene]` takes every
scene (blink, running, tamagotchi, rover, parts, select, serial + tests, MCP menu, more menu,
light, device view, replay, instruments) at 1440x900 and 390x844.
