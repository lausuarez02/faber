# 0005 — Round 8: Fabwright distributes the parts inside the case by itself, and shows how

Status: accepted · 2026-11-11

The person saw the talking egg a real Claude built in round 7 (`jumper-evals/round7/egg/talking-egg-2/`):
78.2 x 102 x 34.3 mm, "bulky", while its parts are only about 23 cm³ and would cover about
67 x 67 mm laid flat. Round 7's packer stacked the parts front to back and gave up on thin layouts.
They asked for Fabwright itself to work out the best way to distribute the parts, to propose or show
it, automatically, for any custom outline at any size (never a preset per object).

## Options considered

1. **Tune round 7's stacker** (more search, different order). Cheap, but it only ever stacks front
   to back; it cannot find "everything side by side" in a curved outline, which is where the
   thickness goes.
2. **An exact packer** (MILP / constraint solver over boxes in a spline outline). Optimal in
   principle, but a new heavy dependency, seconds to minutes per answer, and hard to keep honest
   about the rim round-over, side ports and wiring room the CAD adds.
3. **Ask the agent to place every part.** Already possible with `placements`; it is what made the
   34 mm egg. Agents do not reason well about mm in a curved outline, and the person has no way to
   see the alternatives.
4. **A deterministic heuristic search over layers, plus proposals the person can see** (chosen).
   Each part is a box with a few allowed poses (0 / 90°, on its edge, front / middle / back of the
   depth, port side). Depths are tried flat first, then 2 and 3 layers; at each depth a seeded walk
   over order and poses finds the smallest scale of the real outline that holds everything,
   inset by wall, wiring gap and rim at that part's depth. Round 7's stacker stays as one more
   candidate, so no answer is worse than before.

## Choice

- Three proposals per case: **thinnest**, **smallest** (volume), **balanced** (volume weighed
  past 18 / 22 mm thick and past a 110 x 70 mm footprint). Each carries layers, placements,
  fill ratio, pocket verdict, plain-language `why`, and front / side views.
- `enclosure.layout`: `auto` (= balanced, the default), `thinnest`, `smallest`, `balanced`.
  `check_fit` returns the proposals and the chosen one; `design_case` builds exactly that one.
- Pins (`placements` x / y / layer / face) are kept and the rest is arranged around them; each
  proposal says how to pin each part where it is.
- The person sees it in the Case view's **Layout** tab (three cards, 3D preview, Use, drag a part
  to pin it), and agents through `propose_layout`.
- The parts advice (`check_design` info notes: unneeded boost, smaller speaker, charger + boost
  in one module, smaller board) shrinks the parts themselves; two of them apply in one click.

## Why

- Deterministic and fast enough to run on every fit check (about 2 s for the egg) with no new
  dependency, and the same code path for the quick preview and the real CAD.
- Proposals instead of one silent answer: thickness vs footprint is a trade the person should see
  (the egg is 21.5 mm flat at 100 x 131 mm, or 34.3 mm stacked at 78 x 102 mm).
- Keeping the round-7 stacker as a candidate makes the change monotonic: a case only gets better.

## Known costs

- It is a heuristic, not an optimum. Pins an agent set early can cost a lot: the advised egg
  (boost removed, 20 mm speaker) lays flat at 111 x 145 x 21.5 mm with the agent's two `y_mm`
  pins, and at 84.7 x 110.4 x 21.5 mm without them. Fabwright does not yet say what a pin costs.
- Presets at auto size keep round 6's full stacker search, 2 to 5 s.
- The proposal `volume_cm3` is the outline-box estimate; the built report's volume is the real
  shell (the egg: 223.9 vs 204.4 cm³).
