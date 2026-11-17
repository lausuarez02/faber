// HC-SR04 + real firmware: the rover sketch's distanceCm() (TRIG 10 µs, pulseIn(ECHO), / 58)
// reads back the distance the sensor is set to, because the ECHO edges land on the exact MCU
// cycle (the Simulation stops the CPU there via McuBackend.stopAt).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import { Simulation } from "@fabwright/sim-core";
import { backendFactory } from "@fabwright/sim-backends";
import { registry } from "./registry.gen.ts";

const hex = readFileSync(fileURLToPath(new URL("../../../examples/rover/firmware/rover.hex", import.meta.url)), "utf8");
const project = parseProject({
  format: "fabwright/1",
  name: "sonar",
  parts: [
    { id: "uno", type: "arduino-uno", x: 0, y: 0 },
    { id: "sonar", type: "hc-sr04", x: 0, y: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "uno", pin: "5V" }, to: { part: "sonar", pin: "VCC" } },
    { id: "w2", from: { part: "sonar", pin: "GND" }, to: { part: "uno", pin: "GND.1" } },
    { id: "w3", from: { part: "uno", pin: "D9" }, to: { part: "sonar", pin: "TRIG" } },
    { id: "w4", from: { part: "sonar", pin: "ECHO" }, to: { part: "uno", pin: "D10" } },
  ],
  firmware: { board: "uno", artifact: "rover.hex" },
});

describe("HC-SR04 with pulseIn() on avr8js", { timeout: 60_000 }, () => {
  it.each([3, 12, 20, 27])("firmware measures %i cm", (cm) => {
    const sim = new Simulation({ project, registry, backendFactory, firmware: hex });
    sim.setProp("sonar", "distance", cm);
    sim.runFor(400);
    // pulseIn() comes back a few µs short (its 16-cycle loop granularity, also true on hardware) and
    // the sketch truncates µs / 58 while the true round trip is 58.2 µs/cm: so cm or cm − 1.
    const got = Number(/obstacle (\d+) cm/.exec(sim.serialText())?.[1]);
    expect([cm - 1, cm]).toContain(got);
    expect(Number(sim.partState("sonar")!.lastEchoUs)).toBeCloseTo(cm * 58.24, -1);
    expect(sim.diagnostics().filter((d) => d.partId === "sonar")).toEqual([]);
  });

  it("a clear path (no echo within 30 ms) reads as no obstacle", () => {
    const sim = new Simulation({ project, registry, backendFactory, firmware: hex });
    sim.setProp("sonar", "distance", 450);
    sim.runFor(600);
    expect(sim.serialText()).not.toContain("obstacle");
    expect(Number(sim.partState("sonar")!.pings)).toBeGreaterThan(5);
  });
});
