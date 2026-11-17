# Fabwright brand

<img src="wordmark.svg" alt="Fabwright wordmark" width="280">

## The name

**Fabwright**: "fab" for fabrication, "wright" for a maker, as in shipwright or wheelwright. Fabwright is where you design a device, run its real firmware in a simulator, and then make it: the case, the kit, the factory files. It was called Jumper until 2026-11-17 ([decision 0008](../docs/decisions/0008-rename-to-fabwright.md)).

The CLI is `fabwright` (`fabwright run`, `fabwright test`). The name avoids the usual "lab", "studio" and "hub" names.

## Logo

The mark is a jumper wire, the one part every hardware project uses, bent into a hook. Each end has a dupont connector: a housing, a latch window, and a metal pin. The red wire is the brand's main accent. (The hook is the J of the project's first name, Jumper; a mark for Fabwright is open.)

| File | Use |
| --- | --- |
| [`logo.svg`](logo.svg) | The mark on its own, on a transparent background. It switches between dark and light colors with `prefers-color-scheme`. |
| [`wordmark.svg`](wordmark.svg) | The mark plus "fabwright", for headers, the README and docs. Also adapts to the color scheme. |
| [`favicon.svg`](favicon.svg) | The mark on an ink tile, for browser tabs and app icons. It is simplified for 16 px (no latch windows, thicker wire). |
| [`social-card.svg`](social-card.svg) | 1200×630 Open Graph / Twitter card (source). |
| [`social-card.png`](social-card.png) | The same card rendered with the brand fonts. Use this for `og:image`, because social sites don't render SVG. Re-render it whenever the SVG changes. |

**Rules**

- Leave clear space around the mark equal to the width of one connector housing (about a quarter of the mark's width).
- The smallest size for `logo.svg` is 16 px. Below 24 px, prefer `favicon.svg`.
- Keep the wire red (`--wire`). The housings use the text color of the theme: light housings on dark backgrounds, dark housings on light ones, like real dupont connectors. The pins use `--muted`.
- Don't rotate, outline, add shadows, gradients or glows, or redraw the hook in a typeface.
- The wordmark is always lower case: "fabwright". In running text, write **Fabwright**.
- `wordmark.svg` sets the word as live text in Bricolage Grotesque, with IBM Plex Sans and system fonts as fallbacks. If you export it for print or for use outside the web, convert the text to outlines first.

## Color

Fabwright is dark first. The canvas is a dark bench with a dot grid like a breadboard. The colors come from the workbench: a red jumper wire, the green of a lit signal, and amber and blue indicator LEDs. Use them for meaning, not decoration.

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--ink` | `#0D0F12` | `#F4F1EA` (paper) | App and canvas background (`--bg`). |
| `--panel` | `#15181D` | `#FFFFFF` | Sidebars, inspectors, menus. |
| `--panel-2` | `#1C2027` | `#FAF8F3` | Raised surfaces inside a panel: inputs, cards, hovered rows. |
| `--line` | `#262B33` | `#DAD5CB` | Borders and dividers. |
| `--grid-dot` | `#2A3039` | `#CFC8BB` | Canvas dot grid. |
| `--text` | `#E9EDF2` | `#14171C` | Primary text. |
| `--muted` | `#8A93A0` | `#5F6772` | Secondary text, pin labels, metal pins in the logo. |
| `--wire` | `#FF4D2E` | `#E0391B` | **Primary accent.** The jumper wire: the main button, the selection, the wire being dragged, the logo. |
| `--live` | `#5CF2A1` | `#14A862` | Signal HIGH, a lit LED's glow, "running". Use it only for things that are actually live in the simulation. |
| `--warn` | `#FFB23F` | `#C9800F` | Warnings: overcurrent, a stub part, an approximated fidelity area. |
| `--data` | `#4DA3FF` | `#1F74D1` | Data and links: serial output, buses, focus rings (`--focus`). |

The light theme keeps the same accents, darkened enough to stay readable on paper. All tokens live in [`tokens.css`](tokens.css). The app imports that file and must not hard-code colors. To pick a theme, set `<html data-theme="light|dark">`. With no attribute, Fabwright follows the OS setting.

Avoid purple gradients, glassmorphism, and default component-library grays. When something needs emphasis, use `--wire`. When something is happening in the simulation, use `--live`.

## Type

Fabwright uses three families, all under the SIL Open Font License and bundled through `@fontsource`:

| Family | Token | Use |
| --- | --- | --- |
| **Bricolage Grotesque** 600 / 800 | `--font-display` | Headings, the wordmark, big numbers, empty states. |
| **IBM Plex Sans** 400 / 500 / 600 | `--font-ui` | All interface text. |
| **IBM Plex Mono** 400 / 500 | `--font-mono` | Pin labels, part ids, values with units, code, the serial console. |

Scale (UI base 14 px):

| Token | Size | Family | Use |
| --- | --- | --- | --- |
| `--text-xs` | 11 px | Mono | Pin labels on parts, badges. |
| `--text-sm` | 12 px | Sans / Mono | Secondary UI, the serial console. |
| `--text-base` | 14 px | Sans | Body UI text. |
| `--text-md` | 16 px | Sans 600 | Panel titles. |
| `--text-lg` | 20 px | Display 600 | Section headings. |
| `--text-xl` | 28 px | Display 800 | Page titles. |
| `--text-2xl` | 44 px | Display 800 | Marketing, the empty canvas. |

Values with units are set in mono with a space before the unit: `220 Ω`, `13.3 mA`, `16 MHz`.

## Shape

- Radii: `--radius-sm` 4 px (pins, chips), `--radius` 8 px (controls), `--radius-lg` 12 px (panels).
- Grid: `--grid-size` is 20 px. One breadboard pitch (0.1") is 20 px at 100% zoom.
- Borders are 1 px `--line`. Prefer a border to a shadow. If something must float (a menu, for example), use one soft shadow.

## Voice

Plain, honest, and never more than the simulator can back up.

- **Say what it does.** "Runs the real `.hex` on an emulated ATmega328P", not "next-gen hardware AI".
- **Never overpromise.** If a part is approximated, say "approximated". If something is not simulated, say "not simulated". Write "the sim says this works", not "this works".
- **Short sentences, everyday words.** Avoid "leverage", "seamless", "revolutionary" and "magic".
- **Name the part and the number.** Write "LED draws 100 mA, limit is 20 mA. Add a resistor (220 Ω is typical)" instead of "Electrical error".
- **Errors say what failed, why, and how to fix it**, next to the thing that failed.

### The fidelity words

These three words have exact meanings. Use them only in these senses, everywhere (UI, docs, reports):

| Word | Meaning |
| --- | --- |
| **Exact** | Matches the real part for everything firmware can observe, within datasheet tolerance. |
| **Behavioral** | Behaves like the real part in normal use, with simplified physics. The known gaps are listed. |
| **Stub** | Present so a project loads. It does almost nothing, and says so. |

Area ratings are written as ✅ ok, ⚠️ approx, ❌ none and – n/a. See [docs/fidelity.md](../docs/fidelity.md).

## License

All brand files here are original work, under the same Apache-2.0 license as the rest of the repository. Apache-2.0 does not grant trademark rights (section 6). Please don't use the name or logo in a way that suggests your project is the official Fabwright.
