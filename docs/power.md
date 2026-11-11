# Power: batteries, USB and how a device is built

Round 6 (decision [0004](decisions/0004-round6-real-device.md), contract R2). A pocket device runs
from its battery in the simulation the same way it does on the bench: the cell, the charger, the
switch, the diode and the board's own regulator are circuit elements, and the board's firmware only
runs while its supply is up.

## The model

- **Boards have a supply chain.** USB (a stiff 5 V source on `VBUS` / `5V`) is there when
  `jumper.json` says a cable is plugged in (`"power": {"usb": true}`, the default, as before round
  6). Behind it are the board's own regulators: the XIAO RP2040 and RP2040-Zero have a 3.3 V LDO
  from `VBUS` (0.25 V dropout, typical); the Pico has a Schottky from `VBUS` to `VSYS` (~0.3 V) and a
  buck-boost from `VSYS` (1.8 to 5.5 V) to `3V3`, switched off by `3V3_EN` LOW; the Uno and Nano make
  5 V from `VIN` (~1.1 V dropout) and 3.3 V from 5 V. The board's own typical current (XIAO 25 mA)
  is drawn from its logic rail.
- **The firmware is held in reset while the board has no power** (its logic rail under
  `limits.min3v3V`, 2.7 V on the RP2040 boards: the flash chip's minimum; 80 % of 5 V on the AVR
  boards). When power comes back it boots from reset, as a real board does. Trace and serial times
  stay on the one virtual clock.
- **Regulators** are a solver element (`CircuitBuilder.regulator`, `packages/sim-core/src/circuit.ts`):
  regulating (output at the set point, the input supplies the output current + quiescent, or output
  power / efficiency for a switcher), tracking (an LDO in dropout: VOUT = VIN − dropout; a boost
  above its set point passes VIN through) and off. Iterated with the diodes until the states settle.
- **Battery current follows the load**: the LiPo drains with whatever the circuit draws from it, the
  TP4056 charges it from its own USB socket (prop `usb`), the protection cuts it off when empty.

## Wiring a pocket device

```
LiPo + ── TP4056 BAT (B+)        TP4056 IN+ / IN−: leave unconnected (its USB-C socket is the charge port)
LiPo − ── TP4056 GND.2 (B−)
TP4056 OUT ── slide-switch 2 (COM)
slide-switch 1 ── schottky-diode A
schottky-diode C (stripe) ── XIAO / RP2040-Zero 5V (VBUS)       Pico: OUT → switch → VSYS (no diode needed)
TP4056 GND.3 ── board GND
```

The diode keeps the board's USB from pushing current into the cell when someone plugs the board in
to flash it. A 5 V board (Uno, Nano) needs a `boost-converter` between the charger's OUT and its 5V.
Then `set_power {"usb": false}` and run: the board must stay powered and the cell's `currentmA` is
what the device draws.

## Project fields

| Field | Meaning |
| --- | --- |
| `power.usb` | A USB cable is plugged into the board. Absent = `true`. `false` = it runs only from what is wired to its supply pins. |
| `assembly` | `"breadboard"` or `"soldered"`. Absent = soldered for a project with an `enclosure` or a pocket board (XIAO, RP2040-Zero), breadboard otherwise (`assemblyStyle()` in `packages/session/src/assembly.ts`). |

## Tools

| Tool | What it does |
| --- | --- |
| `set_power {usb, why?}` | Plug / unplug the board's USB (an undoable edit; live in a running simulation). Returns `{usb, board_powered, supply: {net, volts, from}, battery?: {part, volts, ma, hours_left}}`. |
| `set_assembly {style, why?}` | breadboard or soldered; export follows it. |
| `export` | Soldered: `BOM.md` with hook-up wire per gauge, heat-shrink and solder (no breadboard, no dupont), `WIRE-CUTS.csv` (`wire,from,to,color,length_mm,gauge_awg,note`; 24 AWG on power nets including the switch and diode, 26 AWG for signals; lengths rounded up to 5 mm with 10 mm strip and 15 mm slack, estimated from part sizes until the case gives positions), `ASSEMBLY.md` (power path first, measured before modules are connected). Breadboard: as before. |
| `search_parts` | Nothing that really fits (only description mentions) → `{results: [], hint, create_part_template, mentioned_in}`; the template compiles with `create_part`. |
| `get_part` | Short ids resolve: `rp2040-zero` → `waveshare-rp2040-zero`, `xiao` → `seeed-xiao-rp2040` (`matched` says which); ambiguous ones list the candidates. |

`plan_device`, `search_parts` and `get_part` called before `new_project {"folder": true}` are
written into the new project's action log (with `moved_from`), not the project that was open.

## check_design codes

| Code | Severity | When |
| --- | --- | --- |
| `usb-backfeed` | error | a battery path reaches a board's USB pin (VBUS / 5V) with no diode on the way (a switch does not help while it is on) |
| `battery-reversed` | error | a cell's NEG on a supply pin or its POS on ground |
| `battery-overvoltage` | error | a full cell (4.2 V) reaches a pin rated lower (the board's 3V3, a 3.3 V module, a GPIO without a divider) |
| `no-power-path` | error with `power.usb: false`, else warning when the project has a battery | nothing takes a battery to the board's supply pins |
| `ldo-dropout` | warning (info when the board keeps running to empty) | the board's LDO needs more than the cell gives near empty: says at which cell voltage 3V3 falls under 3.3 V and where the board stops |
| `diode-reversed` | warning | a diode in a battery path has its stripe towards the battery |
| `board-unpowered`, `usb-backfeed` (live) | from the simulation | the board's logic rail is down; current flows back into the USB port |

Round 8 adds advice (all `info`: it works as wired, it is only bigger than it needs to be). Each
says what, why with the millimetres from the parts' `dimensions_mm`, and the fix:

| Code | When |
| --- | --- |
| `boost-not-needed` | a boost converter feeds only parts that run from a 1S cell (a module whose supply takes 3.3 to 4.2 V, such as the DFPlayer's 3.2 to 5 V; a XIAO / RP2040-Zero VBUS through a diode; a Pico VSYS). The talking egg of round 7 had one: 36 x 17 x 6 mm for nothing |
| `combine-charge-boost` | a TP4056 and a boost that is needed, on a cell of 2000 mAh or more: one `charge-boost-5v` saves 577 mm² |
| `charger-not-needed` | a TP4056 / charge-boost module on a board whose data says it charges a LiPo itself (`limits.chargerBuiltIn: 1` or the tag `lipo charger`; no simulated board does today) |
| `board-bigger-than-needed` | a board in a device with a battery or a case, when a simulated board at most 70 % of its footprint has enough GPIO for the wired pins (same chip first: Uno → Nano keeps the sketch) |
| `smaller-speaker` | the 28 mm speaker in a device with a battery or a case: `speaker-20mm` saves 384 mm² and 1 mm |

A battery on a charger's `BAT` is not `parallel-regulators`; a power part's input (an LDO's VIN, a
charger's IN+) is not a rail; the TP4056's IN+ / IN− are optional and no fix sends them to a board pin.

## Parts

`schottky-diode` (1N5817), `generic-diode` (1N4148), `n-mosfet` (AO3400), `npn-transistor`
(2N2222 / BC547), `pnp-transistor` (2N2907 / BC557), `ldo-regulator` (MCP1700-3.3 / AP2112K-3.3),
`boost-converter` (MT3608), and (round 8) `charge-boost-5v` (IP5306-class charger + 5 V boost on one
25 x 21 mm board: charges at about 2 A, so only for cells of 2000 mAh or more; cuts OUT at a 3.0 V
cell; switches OUT off after 32 s under about 45 mA, woken by a press = its KEY or by USB, prop
`auto_off: false` for the I2C version). Each has its datasheet figures in `limits`, physical data, `mechanical`
and `sourcing` (no LCSC numbers: none were checked), fidelity notes and model tests.

## What it does not model

Inrush and capacitors, regulator current limits and thermal shutdown, light-load efficiency of
switchers, a gradual brownout (real chips misbehave between about 2.7 and 3.0 V), the Uno's USB /
VIN auto-switch, the boards' sleep currents, and the exponential diode / transistor curves (they are
piecewise linear). Numbers are datasheet typicals: measure a real unit.

Example: [`examples/agent-built/claude-pocket-muse`](../examples/agent-built/claude-pocket-muse/README.md).
Tests: `packages/sim-core/src/circuit-regulator.test.ts`, `packages/sim-core/src/power.test.ts`,
`packages/session/test/power-*.test.ts`, `apps/web/e2e/power-usb.spec.ts`.
