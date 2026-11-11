# Project format: `jumper.json`

A Jumper project is a folder:

```
my-project/
  jumper.json          parts, positions, wires, firmware, scenarios
  firmware/            sketch sources and the built binary
    blink/blink.ino    arduino-cli wants the sketch in a folder of the same name
    blink.hex          the built image that jumper.json points at
```

`jumper.json` is plain JSON. A person, the app, an AI agent or a script can write it, and it is designed to be reviewed in a pull request. The format is defined by a zod schema in [`@jumper/project-format`](../packages/project-format/src/schema.ts). The same schema is exported as JSON Schema (draft 2020-12) at [`packages/project-format/jumper.schema.json`](../packages/project-format/jumper.schema.json), so editors can autocomplete and validate it.

The current version is **`jumper/1`**.

## Annotated example

This is [`examples/blink/jumper.json`](../examples/blink/jumper.json). JSON has no comments, so the notes are below the file.

```jsonc
{
  "format": "jumper/1",                                   // (1)
  "name": "Blink",
  "description": "The Arduino Blink sketch: pin D13 drives a red LED through a 220 ohm resistor, on for 1 s, off for 1 s.",
  "parts": [                                              // (2)
    { "id": "uno", "type": "arduino-uno", "x": 0, "y": 0, "rotation": 0 },
    { "id": "r1", "type": "resistor", "x": 300, "y": -130, "rotation": 0, "props": { "resistance": 220 } },
    { "id": "led1", "type": "led", "x": 440, "y": -210, "rotation": 0, "props": { "color": "red" } }
  ],
  "wires": [                                              // (3)
    { "id": "w1", "from": { "part": "uno", "pin": "D13" }, "to": { "part": "r1", "pin": "1" }, "color": "#FF4D2E" },
    { "id": "w2", "from": { "part": "r1", "pin": "2" }, "to": { "part": "led1", "pin": "A" }, "color": "#FF4D2E" },
    { "id": "w3", "from": { "part": "led1", "pin": "C" }, "to": { "part": "uno", "pin": "GND.1" }, "color": "#4A515C" }
  ],
  "firmware": {                                           // (4)
    "board": "uno",
    "dir": "firmware",
    "sketch": "blink/blink.ino",
    "artifact": "firmware/blink.hex",
    "build": {
      "tool": "arduino-cli",
      "fqbn": "arduino:avr:uno"
    }
  },
  "scenarios": []                                         // (5)
}
```

1. **`format`** is required and must be exactly `"jumper/1"`. A future breaking change gets a new version and a migration.
2. **`parts`**: one entry per part placed on the canvas.
   - `id` is your name for this instance. It starts with a letter and may contain letters, digits, `_` and `-`. It must be unique within the project.
   - `type` is a part id from the parts registry (`packages/parts/src/parts/<type>/`).
   - `x`/`y` is the top-left corner in canvas pixels. One breadboard pitch (0.1") is 20 px.
   - `rotation` is `0`, `90`, `180` or `270` (clockwise). It defaults to `0`.
   - `props` holds only the values you changed from the part's defaults (see the part's `part.json`).
3. **`wires`** connect two pins. A pin is referenced as `{ part, pin }`, where `pin` is a pin id from that part's `part.json` (for example `D13`, `GND.1`, `A` for an LED anode, `C` for its cathode). `color` is any CSS color. `waypoints` is an optional list of `{x, y}` bend points. Wires carry no direction: `from` and `to` are interchangeable.
4. **`firmware`** is optional, so a blank canvas has none.
   - `board` is the part id of the microcontroller board that runs the firmware.
   - `artifact` is the built binary (Intel HEX for AVR), relative to `jumper.json`.
   - `sketch` and `build` say how to rebuild it. M0 supports `arduino-cli` with an FQBN.
   - `language` (round 10, optional, default `"arduino"`): `"micropython"` (main file `main.py`,
     `build.tool` `"micropython"`), `"esp-idf"` (`main/main.c`, `build.target`), `"platformio"`
     (`platformio.ini`, `build.env`). See [firmware-languages.md](firmware-languages.md) for what runs
     on which board.
5. **`scenarios`** are reserved for M1 scenario tests. For now each needs only an `id`.

## What validation checks

`parseProject` / `safeParseProject` check:

- the shape and types of every field above (unknown keys are dropped);
- that part ids are unique and wire ids are unique;
- that both ends of every wire point at a part that exists;
- that `firmware.board` is one of the parts.

Errors come back with a readable path, for example:

```
Invalid jumper.json (1 problem):
  - wires[0].to.part: wire 'w1' points at part 'r9', which is not in parts
```

The file format does **not** check pin ids against the parts registry, because the format package does not know which parts exist. The simulator and the canvas report unknown part types and pins when they load the project.

## Diff-friendliness rules

`serializeProject` is the only way Jumper writes `jumper.json`. For the same project it always produces exactly the same bytes, so git diffs show only real changes:

| Rule | Why |
| --- | --- |
| **One part, wire or scenario per line.** | Moving a part changes one line. Adding a wire adds one line. Merge conflicts stay small and readable. |
| **Fixed key order.** Top level: `format, name, description, parts, wires, firmware, scenarios`. Part: `id, type, x, y, rotation, props`. Wire: `id, from, to, color, waypoints`. Pin ref: `part, pin`. | Re-saving never reorders anything. |
| **`props` keys sorted alphabetically**, and keys inside scenarios too. | Same reason. |
| **Array order is kept as written.** New parts and wires go at the end. | Inserting at the end makes the diff a single added line. |
| **Defaults are written out** (`"rotation": 0`). | A line doesn't change shape when you rotate a part later. |
| **2-space indent, `\n` line endings, trailing newline.** | Matches `.editorconfig`, and avoids "no newline at end of file" noise. |

If you hand-edit `jumper.json`, any formatting is accepted. The next save from Jumper normalizes it.

## Nets

The simulator never stores nets. It derives them from wires with `buildNets`, a union-find over wire ends. Net ids (`n0`, `n1`, ...) are deterministic: nets are ordered by their first pin, sorting by part id and then by pin id. Every pin of type `ground` is merged into the ground node `0` in M0, even on boards whose grounds are not wired to each other.

## Using it from code

```ts
import { parseProject, serializeProject, buildNets } from "@jumper/project-format";

const project = parseProject(await readFile("jumper.json", "utf8")); // throws ProjectParseError
project.parts.push({ id: "led2", type: "led", x: 600, y: 40, rotation: 0 });
await writeFile("jumper.json", serializeProject(project));
```

The full API is in [contracts.md](contracts.md#jumperproject-format).

## Versioning

- Adding an optional field is not a breaking change. The format stays `jumper/1`.
- Renaming or removing a field, or changing what a value means, bumps the version to `jumper/2`. That version ships with a migration from `jumper/1`.
