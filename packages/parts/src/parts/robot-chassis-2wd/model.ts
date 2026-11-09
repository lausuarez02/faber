import type { PartModel, PartModelFactory, VisualState } from "@jumper/sim-core";
import { num, round } from "../../lib/props.ts";

/** Keys the physics world writes with interact({ kind: "set", key, value }). */
export const POSE_KEYS = ["x", "y", "heading", "collisions", "minClearance", "clearance", "travelled", "speed"] as const;
type PoseKey = (typeof POSE_KEYS)[number];

/**
 * A mechanical part: it stamps nothing. The physics world reads its body parameters from
 * visualState() (they echo the props) and writes the robot's pose and collision stats back with
 * interact({ kind: "set", key, value }), so agents, scenarios (expect_part chassis.collisions == 0)
 * and the UI read them like any other part state. Without a world the pose stays at 0.
 */
export const create: PartModelFactory = (ctx): PartModel => {
  const s: Record<PoseKey, number> = { x: 0, y: 0, heading: 0, collisions: 0, minClearance: 9999, clearance: 9999, travelled: 0, speed: 0 };
  return {
    stamp() {},
    visualState(): VisualState {
      return {
        label: `x ${Math.round(s.x)} y ${Math.round(s.y)} cm · ${Math.round(s.heading)}°`,
        x: round(s.x, 2),
        y: round(s.y, 2),
        heading: round(s.heading, 2),
        collisions: s.collisions,
        minClearance: round(s.minClearance, 2),
        clearance: round(s.clearance, 2),
        travelled: round(s.travelled, 1),
        speed: round(s.speed, 2),
        wheelRadius: num(ctx.props.wheelRadius, 3.25),
        trackWidth: num(ctx.props.trackWidth, 13.5),
        length: num(ctx.props.length, 20),
        width: num(ctx.props.width, 15),
        mass: num(ctx.props.mass, 450),
        grip: num(ctx.props.wheelGrip, 0.8),
        sensorOffset: num(ctx.props.sensorOffset, 15),
      };
    },
    setProp() {},
    interact(e) {
      if (e.kind !== "set" || e.key === undefined) return;
      const v = Number(e.value);
      if (Number.isFinite(v) && (POSE_KEYS as readonly string[]).includes(e.key)) s[e.key as PoseKey] = v;
    },
  };
};
