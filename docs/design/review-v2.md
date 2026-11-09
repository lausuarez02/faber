# Design review: UI v2 against the reference

Date: 2026-11-09. Reviewer stance: would I ship this next to Figma, tldraw or Flora?
Method: `node apps/web/scripts/ui-shots.mjs <url> <dir>` (now 19 scenes: empty, Blink stopped and
running, tamagotchi, AI pet with its reply bubble, rover with its world, parts popover, selection,
serial + tests, Install MCP, Open in Agent, more menu, light (Blink and AI pet), device view (pet,
rover), replay, instruments) at 1440x900 and 390x844, every PNG read, then point-by-point against
[ui-v2.md](ui-v2.md).

## Verdict before

The shell structure was right (corner zoning, floating islands, one white pill, rail, minimap,
status and agent pills all where the reference puts them). What still read as "slop" was on the
canvas itself and in a few menus: the circuit looked noisy and cheap, not the chrome.

## Findings (before) and what was done

| # | Where | Finding | Severity | Fix |
| --- | --- | --- | --- | --- |
| 1 | Canvas, every running example | HIGH wires drew green dashes over a green halo on top of the wire's own colour: red, blue and purple wires turned into red/green "barber poles" (rover, tamagotchi). Noisy, toy-like, and it breaks "colour means something". | High | HIGH wires now wake up in their **own** colour: full saturation (idle wires stay 18 % desaturated), a soft 7 px halo of that colour, and small bright beads moving along. No second colour. |
| 2 | Canvas labels | Wires ran straight through part labels (`uno`, `oled`, `esp`): the router treated the label strip above each part as free space, and wires are drawn on top. Labels looked struck through. | High | The 24 px label strip counts as part of each part's body for routing. Every example now routes around its labels. |
| 3 | Displays (OLED, TFT) | A big white / green halo around the whole display module while running: reads as a cheap glow effect and bleeds into neighbouring wires. | High | Displays get no module glow (the glass is the light). LED glow is 10 px at 70 % instead of 18 px at 100 %. |
| 4 | Empty project | A lone Uno was zoomed to 1.25x and filled the window: no empty canvas, no hint what to do. The reference's calm "node card with muted text" was missing. | High | Lone board fits at most 0.8x; a node-style **Start here** card (label above, muted text, outlined `Add a part A` and `Connect an agent`) sits under it, and the fit keeps the board above the card (desktop and phone). Disappears with the second part or first wire. |
| 5 | Open in Agent menu | A second solid button (grey-white "Launch Claude Code here") competed with the white Run pill; disabled it looked like a heavy grey slab. The checkbox was the browser's blue. | Medium | Menu actions are outlined (`--bg-raised`, `--border-strong`); disabled is a dashed hairline with faint text. Checkbox uses `accent-color: var(--fg)`. Run stays the screen's one primary. |
| 6 | Parts popover | Ran to the bottom of the window and covered the round buttons and status pill; the category chips were cut mid-word ("Sensors" clipped, more hidden). | Medium | Popover stops above the bottom-left cluster; the chip row fades out at its edge so the cut reads as "scroll for more". |
| 7 | Minimap | Box-in-box: a dark mask and a strong viewport stroke made the minimap look like two nested frames. Spec size not met. | Medium | Lighter mask, hairline viewport stroke, 264 x 144. Bottom fit inset raised to 236 px so circuits never sit under it (light AI pet had the ESP-01 under it). |
| 8 | Serial panel title | "Serial · UART0" in Geist read as "UARTO". | Low | Title "Serial" plus a muted mono meta "UART0" (new `meta` slot on `FloatingPanel`). |
| 9 | Part labels | 11.5 px mono ids were below the spec's 12-13 px and hard to read at fit zoom. | Low | 12 px mono id, 12.5 px label. |
| 10 | World card (rover) | The stats line started at the card's edge (12 px) while the arena started at 29 px; the two-line wrap could touch the arena's bottom wall. | Low | Stats line aligns with the arena's left edge; narrow views reserve room for two lines. |
| 11 | React Flow credit | A "React Flow" link floats bottom-centre. | Note | Kept on purpose (React Flow asks open-source users to keep it unless they subscribe), styled at 22 % opacity in `--fg-faint`. Owner decision if we want it gone. |

## Checked and fine (no change)

- Corner zoning, 16 px gutters, radii (12 / 16 / 18), hairline borders, single soft shadow: match.
- Top-right container: 3 ghost icons, divider, two outlined dropdowns, Reset, white Run / Pause pill
  with the speed segment. Phone collapses to Run + `⋯`.
- Rail: white `+` on top, 40 px ghost buttons, active `#2A2A2A`, separators, `…` at the bottom.
- Status pill green only while running; agent pill and avatar bottom-right.
- Device views (AI pet handheld, rover arena) and the Tests filmstrips: strong, nothing cheap.
- Light theme: inverted tokens, black primary pill, readable.
- Phone: bottom rail, bottom sheets, canvas still pans and runs.

## Still open (not blocking ship)

- Some example layouts route long wires around the whole board (tamagotchi's outer loop). That is
  the example's part placement, not the shell; better placement in the examples would tighten it.
- The first Tests filmstrip frames of the tamagotchi are black (the screen is genuinely off at
  26 ms). A "screen off" placeholder would read better than a black tile.
- Device view readouts show raw firmware keys (`t`, `wifi 0`); friendlier labels would help.

## Screenshots

Before and after sets are produced by the script above; the review's own runs were saved outside the
repo (screenshots are not committed).
