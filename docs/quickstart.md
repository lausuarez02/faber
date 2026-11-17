# Quickstart

This takes about five minutes, from cloning the repo to watching an LED blink on the canvas.

## 1. Install

You need **Node 24** and **pnpm 10**.

```sh
corepack enable          # gives you the pnpm version pinned in package.json
pnpm i
```

## 2. Run the app

```sh
pnpm dev
```

Open <http://localhost:5173>. You get a dark canvas with a dot grid that looks like a breadboard.

- **Pan:** drag the empty canvas. On a phone, drag with one finger.
- **Zoom:** scroll wheel or pinch.
- **Place a part:** drag it from the parts library onto the canvas.
- **Wire:** drag from one pin to another.

## 3. Run Blink

The **Blink** example (`examples/blink/faber.json`) opens by default. It has an Arduino Uno, a 220 Ω resistor and a red LED, wired D13 → resistor → LED → GND. Press **Run** in the top bar (or the Space key).

The LED turns on for one second and off for one second. That timing comes from the simulation, not your computer's clock:

- The Uno runs the real compiled firmware (`examples/blink/firmware/blink.hex`) on an emulated ATmega328P ([avr8js](https://github.com/wokwi/avr8js)).
- When the firmware sets D13 high, a small DC solver works out the current through the resistor and the LED. That current sets the LED's brightness.
- Time is counted in CPU cycles, so the run is identical every time.

Try this: delete the resistor and wire D13 straight to the LED. The LED now draws about 100 mA, and Faber warns about overcurrent. A real LED and a real pin would not survive that for long.

## 4. Check your setup

```sh
pnpm typecheck
pnpm test
pnpm --filter @faber/web exec playwright install chromium   # once
pnpm test:e2e                           # desktop + phone viewports
```

## 5. Rebuild the firmware (optional)

The `.hex` is committed, so you don't need a toolchain to run Blink. To rebuild it from `blink/blink.ino`, follow `examples/blink/firmware/BUILD.md`. It uses Docker with a pinned arduino-cli and AVR core, so everyone gets the same binary.

## Next

- [Project format](project-format.md): what is inside `faber.json`.
- [Fidelity](fidelity.md): what the simulator can and cannot promise.
- [Adding a part](adding-a-part.md): the best first contribution.
- [Architecture](architecture.md): how the packages fit together.
