import { describe, expect, it } from "vitest";
import { armPose, armReach } from "./arm.ts";
import { parseWorld, worldOf, WorldSpecError } from "./world.ts";

const parts = {
  parts: [
    { id: "chassis", type: "robot-chassis-2wd" },
    { id: "motorLeft", type: "dc-motor" },
    { id: "motorRight", type: "dc-motor" },
    { id: "sonar", type: "hc-sr04" },
    { id: "s1", type: "servo-sg90" },
    { id: "s2", type: "servo-sg90" },
  ],
};
const issues = (raw: unknown, p = parts) => {
  try {
    parseWorld(raw, p);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(WorldSpecError);
    return (e as WorldSpecError).issues;
  }
};

describe("world spec", () => {
  it("fills defaults and finds the robot's parts by type and by left/right in their ids", () => {
    const w = parseWorld({ arena: { width: 300, height: 200 }, robot: {} }, parts);
    expect(w.arena).toEqual({ width: 300, height: 200, enclosed: true, wallThickness: 2 });
    expect(w.robot).toEqual({ chassis: "chassis", leftMotor: "motorLeft", rightMotor: "motorRight", sonar: "sonar", start: { x: 40, y: 40, heading: 0 } });
  });

  it("reads walls, boxes and circles", () => {
    const w = parseWorld({ walls: [{ x1: 0, y1: 50, x2: 100, y2: 50 }], obstacles: [{ shape: "box", x: 1, y: 2, w: 3, h: 4 }, { x: 5, y: 6, r: 7 }] });
    expect(w.walls[0]).toMatchObject({ thickness: 2 });
    expect(w.obstacles).toEqual([
      { shape: "box", x: 1, y: 2, w: 3, h: 4, angle: 0 },
      { shape: "circle", x: 5, y: 6, r: 7 },
    ]);
  });

  it("errors name the field, say what is wrong and how to fix it", () => {
    expect(issues({ arena: { width: "big", height: 200 } })[0]).toMatch(/^world\.arena\.width: must be a number, got "big"/);
    expect(issues({ obstacles: [{ shape: "triangle", x: 1, y: 1 }] })[0]).toMatch(/world\.obstacles\[0\]\.shape: "triangle" is not a shape; use "box".*or "circle"/);
    expect(issues({ robot: { chassis: "nope" } })[0]).toMatch(/world\.robot\.chassis: there is no part 'nope' in the project; robot-chassis-2wd parts in it: chassis/);
    expect(issues({ robot: { sonar: "s1" } })[0]).toMatch(/world\.robot\.sonar: part 's1' is a servo-sg90, not a hc-sr04/);
    expect(issues({ robot: { start: { x: 500, y: 10 } } })[0]).toMatch(/outside the 300 × 200 cm arena/);
    expect(issues({ robot: {} }, { parts: [{ id: "c", type: "robot-chassis-2wd" }] })[0]).toMatch(/needs two 'dc-motor' parts; the project has 0/);
    expect(issues({ robot: {} }, { parts: [{ id: "c", type: "robot-chassis-2wd" }, { id: "m1", type: "dc-motor" }, { id: "m2", type: "dc-motor" }] })[0]).toMatch(/cannot tell which motor is which \(m1, m2\)\. Set "leftMotor" and "rightMotor"/);
    expect(issues({ robot: {} }, { parts: [{ id: "a", type: "dc-motor" }, { id: "b", type: "dc-motor" }] }).join("\n")).toMatch(/no 'robot-chassis-2wd' part\. Add one \(place_part type "robot-chassis-2wd"\)/);
    expect(issues(42)[0]).toMatch(/world must be an object like/);
    expect(new WorldSpecError(["a: b"]).message).toBe("world is not valid:\n  - a: b");
  });

  it("reads the world block from raw jumper.json text", () => {
    expect(worldOf('{"format":"jumper/1","world":{"arena":{"width":100,"height":100}}}')).toEqual({ arena: { width: 100, height: 100 } });
    expect(worldOf("{}")).toBeUndefined();
  });
});

describe("arm kinematics", () => {
  const spec = parseWorld({ arm: { base: { x: 0, y: 6 }, links: [12, 10], joints: [{ servo: "s1" }, { servo: "s2" }], targets: [{ id: "cup", x: 15, y: 4 }] } }, parts).arm!;

  it("servo angles → link end points (shoulder 90° = straight up, elbow 90° = straight on)", () => {
    const up = armPose(spec, [90, 90]);
    expect(up.end.x).toBeCloseTo(0, 9);
    expect(up.end.y).toBeCloseTo(6 + 22, 9);
    const flat = armPose(spec, [0, 90]);
    expect(flat.end).toEqual({ x: 22, y: 6 });
    const bent = armPose(spec, [0, 180]);
    expect(bent.points[1]).toEqual({ x: 12, y: 6 });
    expect(bent.end.x).toBeCloseTo(12, 9);
    expect(bent.end.y).toBeCloseTo(16, 9);
  });

  it("inverse kinematics round-trips and flags unreachable points", () => {
    const angles = armReach(spec, 15, 4)!;
    const p = armPose(spec, angles);
    expect(p.end.x).toBeCloseTo(15, 6);
    expect(p.end.y).toBeCloseTo(4, 6);
    expect(p.reached).toEqual(["cup"]);
    expect(armReach(spec, 40, 6)).toBeUndefined();
  });
});
