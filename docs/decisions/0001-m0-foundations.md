# 0001 — M0 foundations

Status: accepted · 2026-11-08

M0 has to prove the whole loop on the smallest possible slice: a project file → a canvas you can wire → real firmware running on an emulated MCU → a part on the canvas reacting. Every choice below is about keeping that slice honest and extensible.

## Name and brand

**Jumper.** The jumper wire is the one part every hardware project uses, it is short, it works as a CLI verb (`jumper run`, `jumper test`), and it is not a template word like "lab" or "studio". (Renamed **Fabwright** on 2026-11-17: [0008](0008-rename-to-fabwright.md).) Brand details live in `brand/README.md`.

## Monorepo

| Option | Notes |
| --- | --- |
| pnpm workspaces | Fast, strict, boring. Already the norm for TS monorepos. |
| Turborepo / Nx | Caching we do not need yet; one more thing to learn. |

**Choice: plain pnpm workspaces.** Internal packages export TypeScript source (`"exports": "./src/index.ts"`) so there is no build step between packages; Vite and Vitest compile on the fly. We add a build step only when a package is published to npm.

## Canvas

| Option | Pros | Cons |
| --- | --- | --- |
| React Flow (`@xyflow/react`, MIT) | Pan/zoom/selection/handles/edges out of the box, virtualizes off-screen nodes, React-native DOM nodes make SVG part visuals trivial | DOM-based, so very large scenes cost more than a GPU canvas |
| PixiJS / Konva | GPU speed, total control | We would rebuild selection, handles, edge routing, a11y, text input |
| tldraw | Great UX | Production license is not open-source friendly. Excluded by the brief. |

**Choice: React Flow.** 200 parts is well inside what it handles when nodes are memoized and only nodes whose *visual state* changed re-render. Live animation is applied by mutating SVG attributes on bound elements (see the part spec), not by re-rendering React trees, so a blinking LED costs one `setAttribute`. If profiling shows we need it, the wire layer can move to a single canvas overlay without touching the part spec.

## Electrical model: a tiny DC solver instead of "logic only"

A pure logic model (pin is HIGH → LED on) is wrong in ways users hit on day one: an LED with no resistor "works", a potentiometer has no voltage, a button with no pull-up reads a clean value. ngspice is the right tool for real analog work (planned as optional, per the brief) but is heavy for the default path.

**Choice:** `sim-core` contains a small modified-nodal-analysis DC solver (resistors, voltage sources with output resistance, current-limited diodes, switches). Every part *stamps* its electrical behavior into it. GPIO outputs are voltage sources with the datasheet output resistance, `INPUT_PULLUP` is a resistor to VCC, an LED is a piecewise-linear diode. The circuit is re-solved only when something changes (a pin toggles, a knob turns), which is cheap for kit-sized circuits. That gives us: LED brightness from real current, ADC readings from real dividers, and overcurrent detection for the design-rule checks in M3. Its fidelity is declared as `behavioral` (DC operating point only, no transients, no capacitance).

## Deterministic clock

The simulation never reads the wall clock. Time is a 64-bit count of MCU cycles; the UI asks the sim to advance "N ms of virtual time" per animation frame (N = frame time × speed). Tests ask for fixed amounts of virtual time. Same project + same inputs → same trace, and a test asserts that by hashing the pin/serial trace of two runs.

## Firmware for M0

The brief puts containerized arduino-cli builds in M1. For M0 we already add `toolchains/arduino/Dockerfile` (arduino-cli and a pinned `arduino:avr` core) and use it to build `examples/blink`. The resulting `.hex` is committed as a **golden firmware** fixture, so CI and the browser demo do not need Docker to run Blink.

## Project format

One `fabwright.json` per project plus a `firmware/` folder, validated with a zod schema that we also export as JSON Schema. The file is written with a stable key order and one part/wire per line, so moving a part is a one-line diff. Details: `docs/project-format.md`.

## Part spec

One folder per part: `part.json`, `model.ts`, `visual.svg`, `fidelity.json`, `model.test.ts`. A codegen step builds a registry module that inlines the SVG and JSON, so the same registry works in the browser, Node tests and the future CLI without bundler-specific imports. Details: `docs/part-spec.md`.
