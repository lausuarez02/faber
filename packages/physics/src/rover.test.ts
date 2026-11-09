import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "./rapier.ts";
import { PHYSICS_DT, RoverWorld, type RobotBody } from "./rover.ts";
import { parseWorld } from "./world.ts";

const body: RobotBody = { length: 20, width: 15, mass: 0.45, wheelRadius: 3.25, trackWidth: 13.5, grip: 0.8, sensorOffset: 15, axleOffset: -5 };
const open = parseWorld({ arena: { width: 1000, height: 1000 } });
const steps = (s: number) => Math.round(s / PHYSICS_DT);

beforeAll(async () => {
  await initPhysics();
});

describe("RoverWorld (differential drive on Rapier 2D)", () => {
  it("drives straight at wheel speed ω·r", () => {
    const w = new RoverWorld(open, body, { x: 100, y: 500, heading: 0 });
    const omega = 20; // rad/s ≈ 191 rpm → 65 cm/s
    for (let i = 0; i < steps(2); i++) w.step(omega, omega);
    const p = w.pose();
    expect(w.motion().speed).toBeGreaterThan(63);
    expect(w.motion().speed).toBeLessThan(66);
    expect(p.x).toBeGreaterThan(100 + 120);
    expect(Math.abs(p.y - 500)).toBeLessThan(0.01);
    expect(Math.min(p.heading, 360 - p.heading)).toBeLessThan(0.01);
    w.free();
  });

  it("turns in place about the axle: v = 0, yaw rate = (vr − vl)/track", () => {
    const w = new RoverWorld(open, body, { x: 500, y: 500, heading: 0 });
    for (let i = 0; i < steps(0.5); i++) w.step(5, -5);
    const m = w.motion();
    // left forward, right back → clockwise on screen → heading increases (towards +y).
    const expected = ((2 * 5 * 0.0325) / 0.135) * (180 / Math.PI);
    expect(m.yawRate).toBeCloseTo(expected, 0);
    w.free();
  });

  it("arcs when one wheel is faster", () => {
    const w = new RoverWorld(open, body, { x: 500, y: 500, heading: 0 });
    for (let i = 0; i < steps(1); i++) w.step(10, 5);
    expect(w.pose().y).toBeGreaterThan(500); // curving right (towards +y)
    w.free();
  });

  it("counts a collision with a wall, stops there, and tracks clearance", () => {
    const box = parseWorld({ arena: { width: 100, height: 100 } });
    const w = new RoverWorld(box, body, { x: 50, y: 50, heading: 0 });
    expect(w.clearanceCm).toBeGreaterThan(30);
    for (let i = 0; i < steps(3); i++) w.step(15, 15);
    expect(w.collisions).toBe(1);
    expect(w.touchingIds()).toEqual(["wall-right"]);
    expect(w.pose().x).toBeLessThan(100 - 10 + 0.5);
    expect(w.minClearanceCm).toBe(0);
    w.free();
  });

  it("sonar sees a wall ahead at the right distance and nothing beyond 4 m", () => {
    const box = parseWorld({ arena: { width: 300, height: 300 } });
    const w = new RoverWorld(box, body, { x: 50, y: 150, heading: 0 });
    // sensor 10 cm ahead of the centre → wall at 300 is 240 cm away
    expect(w.sonar().distanceCm).toBeCloseTo(240, 1);
    const far = new RoverWorld(parseWorld({ arena: { width: 1000, height: 300 } }), body, { x: 50, y: 150, heading: 0 }); // side walls 150 cm away: the ±15° rays reach them only after 560 cm
    expect(far.sonar().distanceCm).toBe(0);
    w.free();
    far.free();
  });

  it("sonar cone catches an obstacle off-axis (±15°) but not one beside the robot", () => {
    const wd = parseWorld({ arena: { width: 400, height: 400 }, obstacles: [{ shape: "circle", x: 160, y: 210, r: 4 }] });
    const w = new RoverWorld(wd, body, { x: 50, y: 200, heading: 0 });
    // obstacle 100 cm ahead, 10 cm to the side (≈ 5.7°) — inside the cone
    expect(w.sonar().distanceCm).toBeGreaterThan(90);
    expect(w.sonar().distanceCm).toBeLessThan(105);
    w.free();
    const beside = new RoverWorld(parseWorld({ arena: { width: 400, height: 400 }, obstacles: [{ shape: "circle", x: 110, y: 240, r: 4 }] }), body, { x: 50, y: 200, heading: 0 });
    // 50 cm ahead, 40 cm to the side (≈ 39°): outside the cone, beyond it is the far wall
    expect(beside.sonar().distanceCm).toBeGreaterThan(300);
    beside.free();
  });

  it("is deterministic: same inputs → bit-identical pose", () => {
    const run = () => {
      const w = new RoverWorld(parseWorld({ arena: { width: 200, height: 200 }, obstacles: [{ shape: "box", x: 120, y: 90, w: 20, h: 30, angle: 20 }] }), body, { x: 40, y: 40, heading: 30 });
      for (let i = 0; i < steps(5); i++) w.step(12 + (i % 7), 9 + (i % 5));
      const p = w.pose();
      w.free();
      return [p.x, p.y, p.heading, w.collisions];
    };
    expect(run()).toEqual(run());
  });
});
