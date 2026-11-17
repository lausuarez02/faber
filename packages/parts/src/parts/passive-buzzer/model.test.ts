import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { serialLines } from "../../lib/firmwareBench.ts";
import { pwmReading, timedMount } from "../../lib/timedBench.ts";
import { noteName } from "./model.ts";

const def = need(registry.get("passive-buzzer"), "passive-buzzer");

const tone = (hz: number) => ({ ...pwmReading(0.5, hz, "mcu:D8"), averaged: hz >= 200 });

describe("passive-buzzer", () => {
  it("names notes", () => {
    expect(noteName(440)).toBe("A4");
    expect(noteName(262)).toBe("C4");
    expect(noteName(523)).toBe("C5");
    expect(noteName(31)).toBe("B0");
    expect(noteName(0)).toBe("");
  });

  it("reports the tone() frequency and records a melody", () => {
    const t = timedMount(def, { wiring: { POS: "d8", NEG: GROUND } });
    t.set("d8", 2.5);
    for (const hz of [262, 330, 392, 523]) {
      t.pwm.set("POS", tone(hz));
      t.advance(100);
      expect(t.model.visualState().frequency).toBeCloseTo(hz, 0);
    }
    const s = t.model.visualState();
    expect(s).toMatchObject({ sounding: true, note: "C5", tones: 4, melody: "C4 E4 G4 C5", label: "C5 · 523 Hz" });
    expect(Number(s.volume)).toBeGreaterThan(0.2);
  });

  it("goes silent when the pin stops toggling and counts a repeated note again", () => {
    const t = timedMount(def, { wiring: { POS: "d8", NEG: GROUND } });
    t.pwm.set("POS", tone(440));
    t.set("d8", 2.5);
    t.advance(50);
    t.pwm.set("POS", { ...pwmReading(0, 440, "mcu:D8"), duty: 0, level: 0, sinceEdgeUs: 50_000 });
    t.set("d8", 0);
    t.advance(50);
    expect(t.model.visualState()).toMatchObject({ sounding: false, frequency: 0, note: "", lastFrequency: 440 });
    t.pwm.set("POS", tone(440));
    t.set("d8", 2.5);
    t.advance(50);
    expect(t.model.visualState()).toMatchObject({ tones: 2, melody: "A4 A4" });
  });

  it("is louder near its resonance", () => {
    const loud = timedMount(def, { wiring: { POS: "d8", NEG: GROUND } });
    loud.pwm.set("POS", tone(4000));
    loud.set("d8", 2.5);
    loud.advance(5);
    const quiet = timedMount(def, { wiring: { POS: "d8", NEG: GROUND } });
    quiet.pwm.set("POS", tone(200));
    quiet.set("d8", 2.5);
    quiet.advance(5);
    expect(Number(loud.model.visualState().volume)).toBeGreaterThan(Number(quiet.model.visualState().volume) * 2);
  });

  it("explains that DC only clicks", () => {
    const t = timedMount(def, { wiring: { POS: "d8", NEG: GROUND } });
    t.set("d8", 5);
    t.advance(300);
    expect(t.model.visualState().sounding).toBe(false);
    expect(t.model.diagnostics!()[0]!.code).toBe("passive-buzzer-dc");
  });
});

describe("passive-buzzer: real firmware (tone() on D8, example.ino)", () => {
  it("hears the melody C4 E4 G4 C5 that tone() plays", () => {
    const sim = exampleSim("passive-buzzer", [{ id: "bz", type: "passive-buzzer", x: 0, y: 0 }], [
      ["bz.POS", "uno.D8"],
      ["bz.NEG", "uno.GND.1"],
    ]);
    sim.runFor(100);
    expect(sim.partState("bz")).toMatchObject({ sounding: true, note: "C4" });
    expect(Number(sim.partState("bz")!.frequency)).toBeCloseTo(262, -1);
    sim.runFor(1100);
    expect(serialLines(sim)).toContain("melody done");
    expect(sim.partState("bz")).toMatchObject({ sounding: false, tones: 4, melody: "C4 E4 G4 C5" });
    expect(Number(sim.partState("bz")!.lastFrequency)).toBeCloseTo(523, -1);
  }, 60_000);

  it("an ACTIVE buzzer on the same sketch says tone() is the wrong way to drive it", () => {
    const sim = exampleSim("passive-buzzer", [{ id: "bz", type: "buzzer", x: 0, y: 0 }], [
      ["bz.POS", "uno.D8"],
      ["bz.NEG", "uno.GND.1"],
    ]);
    sim.runFor(100);
    expect(sim.diagnostics().map((d) => d.code)).toContain("buzzer-tone");
  }, 60_000);
});
