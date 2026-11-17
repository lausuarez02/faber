// Physics views for the web app: the robot arena (top view) and the servo arm (side view).
//
// Wiring it in (for Integrate):
//   import { registerPhysicsViews } from "../renderers/physics";
//   const physics = registerPhysicsViews();
//   // after creating the Simulation for a project (raw = the faber.json text or object):
//   const binding = await physics.attach(sim, raw);        // undefined when the project has no "world"
//   // show a panel for each view that applies:
//   for (const v of physics.views) if (binding && v.applies(binding)) <v.Component binding={binding} />
//   // on project close: binding?.dispose()
// The binding steps physics on the simulation clock (sim.every), so it needs no animation loop of
// its own and follows pause / speed / reset of the Simulation. The views only read snapshots.
import type { ComponentType } from "react";
import { attachPhysics, initPhysics, worldOf, type PhysicsBinding, type SimHost } from "@faber/physics";
import { ArmView, WorldView, type PhysicsViewProps } from "./WorldView.tsx";

export { WorldView, ArmView } from "./WorldView.tsx";
export type { PhysicsViewProps } from "./WorldView.tsx";
export { PhysicsCanvas } from "./PhysicsCanvas.tsx";
export { drawWorld, drawArm, readPalette, fitArena } from "./paint.ts";
export type { Palette, Ctx2D, View } from "./paint.ts";

export interface PhysicsViewSpec {
  id: "world" | "arm";
  /** Panel / tab title. */
  title: string;
  /** Whether this view has something to show for the binding. */
  applies(binding: PhysicsBinding): boolean;
  Component: ComponentType<PhysicsViewProps>;
}

export interface PhysicsViews {
  views: readonly PhysicsViewSpec[];
  /** True when the project (raw faber.json text or object) has a "world" block. */
  hasWorld(project: string | unknown): boolean;
  /**
   * Load the engine and attach the project's world to a running Simulation. Resolves undefined
   * when there is no world. Rejects with a WorldSpecError whose message lists every bad field.
   */
  attach(sim: SimHost, project: string | unknown): Promise<PhysicsBinding | undefined>;
}

export const PHYSICS_VIEWS: readonly PhysicsViewSpec[] = [
  { id: "world", title: "World", applies: (b) => b.world.robot !== undefined || b.world.obstacles.length > 0 || b.world.walls.length > 0, Component: WorldView },
  { id: "arm", title: "Arm", applies: (b) => b.world.arm !== undefined, Component: ArmView },
];

export function registerPhysicsViews(): PhysicsViews {
  return {
    views: PHYSICS_VIEWS,
    hasWorld: (project) => worldOf(project) !== undefined,
    async attach(sim, project) {
      const raw = worldOf(project);
      if (raw === undefined) return undefined;
      await initPhysics();
      return attachPhysics(sim, raw);
    },
  };
}
