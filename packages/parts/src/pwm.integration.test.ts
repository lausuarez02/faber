// analogWrite on the real avr8js backend: Timer0 fast PWM on D5 at 976.56 Hz, measured from
// cycle-stamped pin edges, drives an LED with duty-averaged current while the circuit is solved a
// few times instead of on every edge. Uses the rover's golden firmware: with nothing on its sonar
// echo pin it reads "no obstacle" and keeps analogWrite(5, 170) on.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import { Simulation } from "@fabwright/sim-core";
import { backendFactory } from "@fabwright/sim-backends";
import { registry } from "./registry.gen.ts";
import { mount, need } from "./lib/bench.ts";

const hex = readFileSync(fileURLToPath(new URL("../../../examples/rover/firmware/rover.hex", import.meta.url)), "utf8");

const project = parseProject({
  format: "fabwright/1",
  name: "analogWrite LED",
  parts: [
    { id: "uno", type: "arduino-uno", x: 0, y: 0 },
    { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 220 } },
    { id: "led1", type: "led", x: 0, y: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "uno", pin: "D5" }, to: { part: "r1", pin: "1" } },
    { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" } },
    { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "uno", pin: "GND.1" } },
  ],
  firmware: { board: "uno", artifact: "rover.hex" },
});

describe("analogWrite (Timer0 PWM) on avr8js", { timeout: 60_000 }, () => {
  it("D5 at analogWrite(170): 976.56 Hz, duty 170/256, LED at duty × on-current", () => {
    const sim = new Simulation({ project, registry, backendFactory, firmware: hex });
    let solves = 0;
    sim.subscribe((e) => {
      if (e.type === "solved") solves++;
    });
    sim.runFor(1500);
    const pw = sim.pwm("uno", "D5")!;
    expect(pw.averaged).toBe(true);
    expect(pw.freqHz).toBeCloseTo(16e6 / 64 / 256, 2); // 976.5625 Hz
    // Datasheet fast PWM: (OCR0B + 1) / 256 = 171/256; avr8js toggles at OCR0B → 170/256.
    expect(Math.abs(pw.duty - 170 / 256)).toBeLessThanOrEqual(1 / 256);
    // On-current: the same LED + 220 Ω on a GPIO held HIGH (5 V behind the 25 Ω pin resistance).
    const ref = mount(need(registry.get("led"), "led"), { wiring: { A: "a", C: "0" } });
    ref.solve((c) => {
      c.voltageSource("g", "0", 5, 25);
      c.resistor("g", "a", 220);
    });
    const onmA = Number(ref.model.visualState().currentmA);
    const avgmA = Number(sim.partState("led1")!.currentmA);
    expect(avgmA / onmA).toBeCloseTo(pw.duty, 2);
    const edges = sim.trace.filter((e) => e.kind === "pin" && e.pin === "D5").length;
    expect(edges).toBeGreaterThan(2000);
    expect(solves).toBeLessThan(edges / 10);
    console.log(JSON.stringify({ duty: pw.duty, freq: pw.freqHz, onmA, avgmA, edges, solves }));
  });
});
