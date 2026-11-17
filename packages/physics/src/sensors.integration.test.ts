// IR obstacle sensors and bump switches on a robot: the world finds them by type, reads their
// mount side, and feeds raycast distances / contact into the parts every physics step.
import { beforeAll, describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import { Simulation } from "@fabwright/sim-core";
import { backendFactory } from "@fabwright/sim-backends";
import { registry } from "@fabwright/parts";
import { attachPhysics, initPhysics, mountAngle, parseWorld, WorldSpecError } from "./index.ts";

const robot = (extra: { id: string; type: string; props?: Record<string, string | number> }[], world: Record<string, unknown>) => {
  const project = parseProject({
    format: "fabwright/1",
    name: "sensors",
    parts: [
      { id: "uno", type: "arduino-uno", x: 0, y: 0 },
      { id: "chassis", type: "robot-chassis-2wd", x: 0, y: 0 },
      { id: "mL", type: "dc-motor", x: 0, y: 0 },
      { id: "mR", type: "dc-motor", x: 0, y: 0 },
      ...extra.map((p) => ({ ...p, x: 0, y: 0 })),
    ],
    wires: [],
    world,
  });
  return project;
};

// Robot body centre at (40, 40) facing +x; the chassis is 20 cm long, so its front edge is at x = 50.
// A 10 cm wide wall-like box whose left face sits at x = 50 + gap.
const worldWithBox = (gap: number, heading = 0) => ({
  arena: { width: 300, height: 200 },
  obstacles: [{ id: "box", shape: "box", x: 50 + gap + 5, y: 40, w: 10, h: 80 }],
  robot: { leftMotor: "mL", rightMotor: "mR", start: { x: 40, y: 40, heading } },
});

beforeAll(async () => {
  await initPhysics();
});

describe("robot IR and bump sensors", () => {
  it("maps mount sides to angles from the heading", () => {
    expect(mountAngle("ir-proximity", "front-left")).toBe(-30);
    expect(mountAngle("bump-switch", "front-right")).toBe(45);
    expect(mountAngle("ir-proximity", "rear")).toBe(180);
  });

  it("finds every ir-proximity and bump-switch part and validates explicit lists", () => {
    const p = robot([{ id: "irL", type: "ir-proximity", props: { mount: "front-left" } }, { id: "bump", type: "bump-switch" }], worldWithBox(20));
    const w = parseWorld(p.world, p);
    expect(w.robot!.ir).toEqual([{ id: "irL", angleDeg: -30 }]);
    expect(w.robot!.bumpers).toEqual([{ id: "bump", angleDeg: 0 }]);
    expect(() => parseWorld({ ...worldWithBox(20), robot: { ...worldWithBox(20).robot, ir: ["bump"] } }, p)).toThrow(WorldSpecError);
    expect(() => parseWorld({ ...worldWithBox(20), robot: { ...worldWithBox(20).robot, ir: ["bump"] } }, p)).toThrow(/part 'bump' is a bump-switch, not a ir-proximity/);
  });

  it("feeds the IR sensor the distance to the box in front and presses the bumper on contact", () => {
    for (const [gap, sees, pressed] of [[6, true, false], [25, false, false], [0.5, true, true]] as const) {
      const project = robot([{ id: "ir", type: "ir-proximity" }, { id: "bump", type: "bump-switch" }, { id: "irBack", type: "ir-proximity", props: { mount: "rear" } }], worldWithBox(gap));
      const sim = new Simulation({ project, registry, backendFactory });
      const phys = attachPhysics(sim, project.world);
      sim.runFor(20);
      const ir = sim.partState("ir")!;
      expect(Number(ir.distance), `gap ${gap}`).toBeCloseTo(gap > 0 ? gap : 0, 0);
      // Unpowered parts still get the distance; obstacle needs power, so check distance vs threshold.
      expect(Number(ir.distance) > 0 && Number(ir.distance) <= 10, `gap ${gap} seen`).toBe(sees);
      expect(sim.partState("bump")!.pressed, `gap ${gap} bump`).toBe(pressed);
      // The rear sensor sees the arena wall at x = 0, 30 cm behind the back edge (x = 30).
      expect(Number(sim.partState("irBack")!.distance)).toBeCloseTo(30, 0);
      const snap = phys.snapshot();
      expect(snap.robot!.ir).toHaveLength(2);
      expect(snap.robot!.bumpers).toEqual([{ id: "bump", pressed }]);
      phys.dispose();
    }
  });
});
