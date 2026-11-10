// Passive piezo sounder. Electrically a small capacitive load (about 0.5 mA average, modelled as
// 10 kΩ). Its pitch is the frequency of the signal on it: every 1 ms tick reads the period the
// simulator measures on the pin (cycle-exact edges of tone() / analogWrite) and records the notes.
import type { Diagnostic, PartModel, PartModelFactory, PwmReading } from "@jumper/sim-core";
import { clamp, num, round } from "../../lib/props.ts";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const MELODY_LENGTH = 24;

/** Nearest equal-tempered note name (A4 = 440 Hz), e.g. 262 → "C4". */
export function noteName(hz: number): string {
  if (!(hz > 0)) return "";
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** The pin is toggling (a tone), not sitting at one level. */
function toggling(p: PwmReading | undefined): p is PwmReading {
  if (!p || p.periodUs <= 0 || p.freqHz < 20 || p.freqHz > 20_000) return false;
  if (p.duty <= 0.01 || p.duty >= 0.99) return false;
  return p.sinceEdgeUs <= 2 * p.periodUs + 50;
}

export const create: PartModelFactory = (ctx): PartModel => {
  let f0 = num(ctx.props.resonantHz, 4000);
  let freq = 0;
  let lastFreq = 0;
  let tones = 0;
  let melody: string[] = [];
  let volts = 0;
  let amplitude = 0;
  /** Last voltage seen while the pin was HIGH (slow tones are solved edge by edge). */
  let vHigh = 0;
  let dcMs = 0;

  const read = (): { p: PwmReading; pin: string } | undefined => {
    for (const pin of ["POS", "NEG"]) {
      const p = ctx.pwm?.(pin);
      if (toggling(p)) return { p, pin };
    }
    return undefined;
  };

  const update = (dtMs: number) => {
    const r = read();
    const f = r ? r.p.freqHz : 0;
    if (f > 0 && (freq === 0 || Math.abs(f - freq) / freq > 0.01)) {
      tones++;
      melody.push(noteName(f));
      if (melody.length > MELODY_LENGTH) melody = melody.slice(-MELODY_LENGTH);
      lastFreq = f;
    }
    freq = f;
    // Peak-to-peak drive: the average voltage divided by the duty (a 50 % square wave of 5 V reads 2.5 V).
    amplitude = !r ? 0 : r.p.averaged ? clamp(Math.abs(volts) / Math.max(0.05, r.p.duty), 0, 30) : vHigh;
    dcMs = !r && Math.abs(volts) > 2 ? dcMs + dtMs : 0;
  };

  return {
    stamp(c) {
      c.resistor(ctx.node("POS"), ctx.node("NEG"), 10_000, { id: "piezo" });
    },
    onSolved(r) {
      volts = r.voltage(ctx.node("POS")) - r.voltage(ctx.node("NEG"));
      if (Math.abs(volts) > 0.5) vHigh = Math.abs(volts);
    },
    tick(_t, dtMs) {
      update(dtMs);
    },
    visualState() {
      const sounding = freq > 0;
      const reson = 0.25 + 0.75 / (1 + ((freq - f0) / (0.6 * f0)) ** 2);
      const volume = sounding ? round(clamp(amplitude / 5, 0, 1) * reson, 3) : 0;
      const note = noteName(freq);
      return {
        sounding,
        frequency: round(freq, 1),
        note,
        lastFrequency: round(lastFreq, 1),
        tones,
        melody: melody.join(" "),
        volume,
        label: sounding ? `${note} · ${Math.round(freq)} Hz` : "silent",
      };
    },
    setProp(id, v) {
      if (id === "resonantHz") f0 = clamp(num(v, f0), 100, 20_000);
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      if (dcMs > 200) {
        out.push({
          severity: "info",
          code: "passive-buzzer-dc",
          pin: "POS",
          message: `${ctx.id} has had a steady ${volts.toFixed(1)} V for ${Math.round(dcMs)} ms: a passive buzzer only clicks on DC and is silent. Play a tone with tone(pin, 440) (and noTone(pin) to stop), or use the active "buzzer" part for digitalWrite beeps.`,
        });
      }
      return out;
    },
  };
};
