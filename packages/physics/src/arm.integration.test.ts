// examples/robot-arm end to end: pots → analogRead → Timer1 servo pulses (cycle-measured) →
// servo slew → forward kinematics.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject } from "@faber/project-format";
import { Simulation } from "@faber/sim-core";
import { backendFactory } from "@faber/sim-backends";
import { registry } from "@faber/parts";
import { armPose, armReach, attachPhysics, parseWorld, worldOf } from "./index.ts";

const dir = new URL("../../../examples/robot-arm/", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, dir)), "utf8");
const raw = read("faber.json");
const project = parseProject(raw);
const firmware = read("firmware/robot-arm.hex");
const angle = (sim: Simulation, id: string) => Number(sim.partState(id)!.angle);

describe("examples/robot-arm", { timeout: 120_000 }, () => {
  it("golden firmware matches the arduino-cli build output", () => {
    expect(firmware).toBe(read("firmware/build/robot-arm.ino.hex"));
  });

  it("servos follow the pots; pulses are 50 Hz, 544–2400 µs, measured to the cycle", () => {
    const sim = new Simulation({ project, registry, backendFactory, firmware });
    const phys = attachPhysics(sim, worldOf(raw));
    sim.runFor(600);
    // pot 0.5 → analogRead 511 → map(…, 0, 180) = 89° (integer math) → 1461 µs → 88.9°
    expect(angle(sim, "shoulder")).toBeCloseTo(88.9, 1);
    expect(angle(sim, "elbow")).toBeCloseTo(88.9, 1);
    const pw = sim.pwm("shoulder", "SIG")!;
    expect(pw.averaged).toBe(false); // 50 Hz is solved per edge, not averaged
    expect(pw.periodUs).toBeCloseTo(20_000, 0);
    // map(511, 0, 1023, 0, 180) = 89 → 544 + 89·1856/180 = 1461 µs → OCR1A = 2922 ticks of 0.5 µs.
    // The datasheet's fast-PWM high time is OCR1A + 1 ticks (1461.5 µs); avr8js gives OCR1A ticks.
    expect(Math.abs(pw.highUs - 1461)).toBeLessThanOrEqual(0.5);

    for (const [ps, pe] of [[0.25, 0.75], [1, 0], [0.1, 0.9]] as const) {
      sim.interact("potS", { kind: "set", value: ps });
      sim.interact("potE", { kind: "set", value: pe });
      sim.runFor(500); // the SG90 needs ≤ 0.3 s for 180°
      const s = angle(sim, "shoulder");
      const e = angle(sim, "elbow");
      expect(Math.abs(s - ps * 180), `shoulder at pot ${ps}`).toBeLessThan(1.5);
      expect(Math.abs(e - pe * 180), `elbow at pot ${pe}`).toBeLessThan(1.5);
      const snap = phys.snapshot();
      expect(snap.arm!.pose.end).toEqual(armPose(snap.arm!.spec, [s, e]).end);
    }
    expect(sim.serialText()).toMatch(/shoulder \d+ elbow \d+/);
    expect(sim.diagnostics().filter((d) => d.severity !== "info")).toEqual([]);
    phys.dispose();
  });

  it("can reach the cup: inverse kinematics → pots → gripper inside the target", () => {
    const spec = parseWorld(worldOf(raw), project).arm!;
    const [s, e] = armReach(spec, 15, 4)!;
    const sim = new Simulation({ project, registry, backendFactory, firmware });
    const phys = attachPhysics(sim, spec ? worldOf(raw) : undefined);
    sim.interact("potS", { kind: "set", value: s! / 180 });
    sim.interact("potE", { kind: "set", value: e! / 180 });
    sim.runFor(800);
    expect(phys.snapshot().arm!.pose.reached).toEqual(["cup"]);
  });
});
