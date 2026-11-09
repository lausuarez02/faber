// Planar serial arm (side view): servo angles → joint angles → link end points. Pure math, no
// engine: the servos already model travel speed and end stops, so the arm pose follows them.
// Side-view coordinates are centimetres with y UP from the table.
import type { ArmSpec } from "./world.ts";

export interface ArmPose {
  /** Absolute angle of each link (deg, counter-clockwise from +x). */
  linkAngles: number[];
  /** base, then the end of every link (cm). The last point is the gripper. */
  points: { x: number; y: number }[];
  end: { x: number; y: number };
  /** Targets the gripper is within r of. */
  reached: string[];
}

/** Forward kinematics for `servoAngles` (deg, one per joint, in the order of spec.joints). */
export function armPose(spec: ArmSpec, servoAngles: readonly number[]): ArmPose {
  const points = [{ x: spec.base.x, y: spec.base.y }];
  const linkAngles: number[] = [];
  let abs = 0;
  let { x, y } = spec.base;
  spec.joints.forEach((j, i) => {
    const s = servoAngles[i] ?? j.zero;
    const rel = (s - j.zero) * j.direction + j.offset;
    abs = i === 0 ? rel : abs + rel;
    linkAngles.push(abs);
    const len = spec.links[i] ?? 0;
    x += len * Math.cos((abs * Math.PI) / 180);
    y += len * Math.sin((abs * Math.PI) / 180);
    points.push({ x, y });
  });
  const end = points[points.length - 1]!;
  const reached = spec.targets.filter((t) => Math.hypot(t.x - end.x, t.y - end.y) <= t.r).map((t) => t.id);
  return { linkAngles, points, end, reached };
}

/**
 * Inverse kinematics for a 2-link arm: servo angles that put the gripper at (x, y), or undefined
 * when the point is out of reach. `elbowUp` picks the solution with the elbow above the line.
 * Handy for agents writing firmware ("which angles reach the cup?").
 */
export function armReach(spec: ArmSpec, x: number, y: number, elbowUp = true): number[] | undefined {
  if (spec.joints.length !== 2 || spec.links.length !== 2) return undefined;
  const [l1, l2] = spec.links as [number, number];
  const dx = x - spec.base.x;
  const dy = y - spec.base.y;
  const d2 = dx * dx + dy * dy;
  const c = (d2 - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  if (c < -1 || c > 1) return undefined;
  const q2 = (elbowUp ? -1 : 1) * Math.acos(c);
  const q1 = Math.atan2(dy, dx) - Math.atan2(l2 * Math.sin(q2), l1 + l2 * Math.cos(q2));
  const deg = (r: number) => (r * 180) / Math.PI;
  const [j1, j2] = spec.joints as [ArmSpec["joints"][number], ArmSpec["joints"][number]];
  return [(deg(q1) - j1.offset) / j1.direction + j1.zero, (deg(q2) - j2.offset) / j2.direction + j2.zero];
}
