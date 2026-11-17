# Fidelity: what the simulator can promise

Fabwright's promise is **"if it doesn't crash here, it won't crash there"**. That promise only holds for things the simulator actually models. So the most important rule of the project is:

> **Never pretend.** If something is not simulated, say so, in the part, in the report and in the UI. A clear "not simulated" is better than a convincing fake.

A simulator that is quietly wrong is worse than having no simulator. It teaches people to trust results they shouldn't. Every part therefore ships a `fidelity.json`, and every project will get a "real-world confidence" report built from those files.

## Three levels per part

| Level | Means | Example |
| --- | --- | --- |
| **Exact** | Matches the real part for everything firmware can observe, within the datasheet's tolerances. Tests use datasheet numbers. | A resistor in the DC solver: Ohm's law is the whole story at these frequencies. |
| **Behavioral** | Does what firmware expects in the normal case, with real electrical effects where they matter, but simplifies the physics. The simplifications are listed. | An LED as a piecewise-linear diode: correct current and brightness, warns on overcurrent, but no color shift, no thermal behavior and no reverse breakdown. |
| **Stub** | Present so a project loads and wires up. It does almost nothing, and it says so loudly. | A WiFi module that accepts commands but has no network behind it. |

Stub parts are allowed, because a project that loads and says what is missing is more useful than one that fails to load. The UI must show stub parts as stubs.

## Per-area levels

A single level hides too much. A part can have exact logic and approximate timing. So `fidelity.json` also rates five areas:

| Area | Covers |
| --- | --- |
| **logic** | Digital behavior: pin levels, registers, protocol responses. |
| **timing** | When things happen: delays, protocol timing, PWM frequency, response latency. |
| **analog** | Voltages and currents: dividers, ADC readings, LED current, thresholds. |
| **power** | Supply behavior: current draw, regulators, brownout, battery drain. |
| **radio** | WiFi, Bluetooth, LoRa, IR, anything over the air. |

Each area gets one of these ratings:

| Rating | Shown as | Means |
| --- | --- | --- |
| `ok` | ✅ | Modeled well enough to trust. |
| `approx` | ⚠️ | Modeled with known simplifications (the `note` lists them). |
| `none` | ❌ | Not modeled. Test this on real hardware. |
| `n/a` | – | Not relevant for this part (a resistor has no radio). |

Every area also gets a `note` in plain language. It should be one sentence that a maker understands, not "TODO".

## The `fidelity.json` file

```json
{
  "level": "behavioral",
  "areas": {
    "logic":  { "level": "n/a",    "note": "An LED has no logic of its own." },
    "timing": { "level": "approx", "note": "Brightness follows the pin instantly; there is no turn-on delay or persistence." },
    "analog": { "level": "approx", "note": "Piecewise-linear diode: forward voltage plus series resistance, tuned to the datasheet at 20 mA." },
    "power":  { "level": "approx", "note": "Current is real; heat and long-term damage are not modeled, but overcurrent is flagged." },
    "radio":  { "level": "n/a",    "note": "No radio." }
  },
  "emulates": ["Forward voltage and current through the series resistor", "Brightness from current", "Overcurrent warning above 20 mA"],
  "doesNotEmulate": ["Reverse breakdown", "Color shift with current", "Heating and burn-out"],
  "testOnRealDevice": ["Brightness in daylight with your chosen resistor"]
}
```

- **`emulates`** lists what you can rely on.
- **`doesNotEmulate`** lists known gaps. Be specific. "Accuracy" is not a gap; "no ±0.5 °C sensor noise" is.
- **`testOnRealDevice`** holds the checks the confidence report tells users to do on the real board.

The schema is `FidelitySchema` in `@fabwright/sim-core`. The registry generator rejects a part whose `fidelity.json` does not validate.

## The simulator core has a fidelity too

Fabwright's own engine is rated the same way:

| Piece | Level | Notes |
| --- | --- | --- |
| AVR CPU (avr8js) | Behavioral → close to exact | Runs the real compiled `.hex`, cycle-counted. Peripherals that avr8js does not implement are listed in the backend's docs. |
| Clock | Exact (deterministic) | Time is counted in MCU cycles. The same project and inputs always give the same trace. |
| DC circuit solver | Behavioral | DC operating point only: no capacitance, no inductance, no transients. Diodes are piecewise-linear. A GPIO is a source with 25 Ω output resistance. |
| Ground | Simplified | In M0 all ground pins are one node, even across boards that are not wired together. |

## Rules for contributors

1. When in doubt, choose the lower level. Moving a part up later is good news. Moving it down means a past promise was wrong.
2. A gap you know about goes in `doesNotEmulate` in the same PR that adds the part.
3. If a bug report shows the sim and real hardware disagree, fix the model or update `fidelity.json`. Never leave the two out of sync.
4. Don't hide gaps behind optimistic UI. If the part is a stub, the canvas shows it as a stub.
5. Fault injection (sensor disconnect, noisy readings, I2C NACK, brownout) is planned for later milestones. Until it exists, don't imply that it does.
