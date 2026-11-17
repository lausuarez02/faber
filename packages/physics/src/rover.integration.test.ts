// examples/rover end to end: the real faber.json (incl. its world), the real parts, the avr8js
// backend running the committed golden firmware, and Rapier stepping on the simulation clock.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseProject } from "@faber/project-format";
import { Simulation } from "@faber/sim-core";
import { backendFactory } from "@faber/sim-backends";
import { registry } from "@faber/parts";
import { attachPhysics, initPhysics, worldOf } from "./index.ts";

const dir = new URL("../../../examples/rover/", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, dir)), "utf8");
const raw = read("faber.json");
const project = parseProject(raw);
const firmware = read("firmware/rover.hex");

const start = () => {
  const sim = new Simulation({ project, registry, backendFactory, firmware });
  const phys = attachPhysics(sim, worldOf(raw));
  return { sim, phys };
};

beforeAll(async () => {
  await initPhysics();
});

describe("examples/rover", { timeout: 300_000 }, () => {
  it("golden firmware matches the arduino-cli build output", () => {
    expect(firmware).toBe(read("firmware/build/rover.ino.hex"));
  });

  it("drives 30 virtual seconds without a single collision", () => {
    const { sim, phys } = start();
    sim.runFor(30_000);
    const s = phys.stats();
    const chassis = sim.partState("chassis")!;
    expect(s.collisions).toBe(0);
    expect(chassis.collisions).toBe(0);
    expect(s.travelledCm).toBeGreaterThan(300);
    expect(s.minClearanceCm).toBeGreaterThan(0.5);
    expect(sim.serialText()).toMatch(/rover ready/);
    expect(sim.serialText()).toMatch(/obstacle \d+ cm: avoid/);
    expect(sim.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
    phys.dispose();
  });

  it("is deterministic: one 8 s run == 500 animation frames of 16 ms, bit for bit", () => {
    const a = start();
    const b = start();
    a.sim.runFor(8000);
    for (let i = 0; i < 500; i++) b.sim.runFor(16);
    expect(b.sim.timeMs).toBeCloseTo(8000, 6);
    expect(a.phys.traceHash()).toBe(b.phys.traceHash());
    expect(a.sim.traceHash()).toBe(b.sim.traceHash());
    expect(a.phys.stats()).toEqual(b.phys.stats());
    expect(a.phys.trail().length).toBe(80);
    a.phys.dispose();
    b.phys.dispose();
  });

  it("reset() rewinds the world too", () => {
    const { sim, phys } = start();
    sim.runFor(3000);
    const hashAt3s = phys.traceHash();
    const p1 = phys.stats().pose!;
    sim.reset();
    expect(phys.stats().pose!.x).toBeCloseTo(40, 4); // Rapier stores f32
    expect(phys.stats().pose!.y).toBeCloseTo(40, 4);
    sim.runFor(3000);
    expect(phys.traceHash()).toBe(hashAt3s);
    expect(phys.stats().pose).toEqual(p1);
    phys.dispose();
  });

  it("drives through the L298N with duty-averaged PWM: ENA 170/255 → about 2/3 speed", () => {
    const { sim, phys } = start();
    sim.runFor(1000); // straight ahead, nothing within 28 cm yet
    expect(sim.pwm("drv", "ENA")).toMatchObject({ averaged: true, source: "mcu:D5" });
    const drv = sim.partState("drv")!;
    expect(drv.aState).toBe("fwd");
    expect(Number(drv.aDuty)).toBeCloseTo(170 / 256, 2);
    const rpm = Number(sim.partState("mL")!.rpm);
    expect(rpm).toBeGreaterThan(120);
    expect(rpm).toBeLessThan(190);
    expect(Number(sim.partState("chassis")!.speed)).toBeGreaterThan(40);
    expect(Number(sim.partState("sonar")!.pings)).toBeGreaterThan(10);
    phys.dispose();
  });
});
