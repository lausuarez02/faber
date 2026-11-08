# Add a part in 15 minutes

This walkthrough adds a hypothetical **tilt switch** (SW-520D: a ball that closes a contact when
the part is upright). Read `docs/part-spec.md` once for the rules; this page is the recipe.

Everything happens in `packages/parts/src/parts/tilt-switch/`. You need no other file.

## 0. Pick an id and copy a neighbour (1 min)

The id is kebab-case and permanent. Copy the closest existing part:

```sh
cp -r packages/parts/src/parts/pushbutton packages/parts/src/parts/tilt-switch
```

## 1. `part.json` (3 min)

```json
{
  "id": "tilt-switch",
  "name": "Tilt switch (SW-520D)",
  "category": "sensor",
  "description": "Ball tilt switch: closed when upright, open when tilted past ~45°. Wire one leg to an INPUT_PULLUP pin and the other to GND.",
  "pins": [
    { "id": "1", "label": "1", "x": 10, "y": 56, "type": "passive" },
    { "id": "2", "label": "2", "x": 30, "y": 56, "type": "passive" }
  ],
  "size": { "w": 40, "h": 60 },
  "props": [
    { "id": "tilted", "label": "Tilted", "type": "boolean", "default": false }
  ],
  "limits": { "maxCurrentmA": 20, "maxVoltage": 12 },
  "footprint": "THT 6 mm can, 0.1 in lead pitch",
  "bindings": [
    { "key": "closed", "type": "boolean", "description": "True when the contact is closed (upright)." },
    { "key": "bodyTransform", "type": "string", "description": "SVG transform tilting the can." }
  ],
  "tags": ["tilt", "sw-520d", "ball switch", "orientation", "sensor"]
}
```

Checklist: 20 px = 0.1 in, so legs 0.1 in apart are 20 px apart; pin `x`/`y` are where wires
attach (lead tips), inside the viewBox; every key the SVG will bind is in `bindings`.

## 2. `visual.svg` (4 min)

Draw it yourself, dark-first, white silkscreen, `IBM Plex Mono` labels. Put the moving part in a
group bound to a transform string, and one `data-pin` circle per pin at the exact `part.json`
coordinates:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 60" width="40" height="60">
  <path d="M10 34 V56 M30 34 V56" stroke="#9AA3AF" stroke-width="2" stroke-linecap="round"/>
  <g transform="rotate(0 20 20)" data-bind="transform:bodyTransform">
    <rect x="8" y="4" width="24" height="30" rx="4" fill="#2B313B" stroke="#4A5363"/>
    <circle cx="20" cy="26" r="5" fill="#C9CED6"/>
  </g>
  <circle cx="20" cy="2" r="2" fill="#5CF2A1" display="none" data-bind="visible:closed"/>
  <circle data-pin="1" cx="10" cy="56" r="3" fill="#C9CED6"/>
  <circle data-pin="2" cx="30" cy="56" r="3" fill="#C9CED6"/>
</svg>
```

No scripts, styles, images or external links; any `id` starts with `tilt-switch-`.

## 3. `model.ts` (3 min)

```ts
import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import { truthy } from "../../lib/props.ts";

export const create: PartModelFactory = (ctx): PartModel => {
  let tilted = truthy(ctx.props.tilted);
  return {
    stamp(c) {
      c.switch(ctx.node("1"), ctx.node("2"), !tilted, { id: "contact" });
    },
    visualState() {
      return { closed: !tilted, bodyTransform: tilted ? "rotate(60 20 20)" : "rotate(0 20 20)" };
    },
    setProp(id, v) {
      if (id === "tilted") tilted = truthy(v);
    },
    interact(e) {
      if (e.kind === "press") tilted = !tilted;
      else if (e.kind === "set") tilted = truthy(e.value);
    },
  };
};
```

Stamp from the current state every time; no clocks, no randomness. If the part can be misused
(over-current, reversed, wrong voltage), add `diagnostics()` with a message that says what, why
and how to fix.

## 4. `fidelity.json` (2 min)

Be honest; this is shown to users.

```json
{
  "level": "behavioral",
  "areas": {
    "logic": { "level": "ok", "note": "Closed upright, open when tilted." },
    "timing": { "level": "approx", "note": "Switches instantly; the real ball rattles for tens of ms." },
    "analog": { "level": "approx", "note": "Closed contact 0.01 Ω; real contact resistance is up to 10 Ω and varies." },
    "power": { "level": "n/a", "note": "Rating documented, not enforced." },
    "radio": { "level": "n/a", "note": "Not a radio part." }
  },
  "emulates": ["Upright / tilted switching"],
  "doesNotEmulate": ["Ball bounce and chatter", "Exact tilt angle threshold", "Vibration sensitivity"],
  "testOnRealDevice": ["Debounce and the angle at which it switches"]
}
```

## 5. `model.test.ts` (2 min)

Test the behaviour a datasheet promises, through the real solver:

```ts
import { describe, expect, it } from "vitest";
import { GROUND, PULLUP_OHMS } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("tilt-switch"), "tilt-switch");

describe("tilt-switch", () => {
  it("pulls an INPUT_PULLUP pin LOW when upright and lets it go HIGH when tilted", () => {
    const b = mount(def, { wiring: { "1": "d2", "2": GROUND } });
    b.solve((c) => void c.voltageSource("d2", GROUND, 5, PULLUP_OHMS));
    expect(b.result!.voltage("d2")).toBeLessThan(0.01);
    expect(b.setProp("tilted", true).voltage("d2")).toBeCloseTo(5, 3);
    expect(b.model.visualState().closed).toBe(false);
  });
});
```

## 6. Generate and test (1 min)

```sh
pnpm gen                                   # validates the folder, rewrites src/registry.gen.ts
pnpm vitest run packages/parts             # your test + the spec test for every part
pnpm typecheck
```

`pnpm gen` prints every problem with the file and the fix (e.g. `tilt-switch/visual.svg line 7:
data-pin="1" is drawn at (10, 58) but part.json says (10, 56)`). The spec test additionally
checks that every bound key comes out of `visualState()` with the documented type, that every
prop value and interaction solves, and that `registry.gen.ts` is up to date. Commit the part
folder together with the regenerated `registry.gen.ts`.

## Common mistakes

- **Pin anchor off by a few px**: copy coordinates from `part.json` into the `data-pin` circle.
- **Binding key typo**: the spec test names the missing key; add it to `bindings` and return it
  from `visualState()`.
- **Reading a stale element id**: store the id returned by `c.resistor(...)` in `stamp()` and use
  that in `onSolved`; do not build the id string yourself.
- **Using wall-clock time**: use `ctx.now()` or `tMs`; the simulator must replay identically.
- **Copying artwork**: draw original SVGs. Never take graphics from other simulators or vendor
  sites.
