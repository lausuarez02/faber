import type { PhysicsBinding } from "@faber/physics";
import { useCallback } from "react";
import { drawArm, drawWorld } from "./paint.ts";
import { PhysicsCanvas } from "./PhysicsCanvas.tsx";

export interface PhysicsViewProps {
  binding: PhysicsBinding | undefined;
  className?: string;
}

/** Top view of the robot arena: walls, obstacles, robot, sonar cone, trail, collision stats. */
export function WorldView({ binding, className }: PhysicsViewProps) {
  const get = useCallback(() => binding?.snapshot(), [binding]);
  return <PhysicsCanvas getSnapshot={get} paint={drawWorld} label="Robot world, top view" {...(className ? { className } : {})} />;
}

/** Side view of a servo arm: links, joints with servo angles, gripper and targets. */
export function ArmView({ binding, className }: PhysicsViewProps) {
  const get = useCallback(() => binding?.snapshot(), [binding]);
  return <PhysicsCanvas getSnapshot={get} paint={drawArm} label="Robot arm, side view" {...(className ? { className } : {})} />;
}
