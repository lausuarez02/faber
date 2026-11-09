import { armPose, parseWorld, type WorldSnapshot, type WorldSpec } from "@jumper/physics";
import type { Project } from "@jumper/project-format";
import type { VisualState } from "@jumper/sim-core";

/**
 * Follow / replay have no local simulation, so the arena view is rebuilt from what the session
 * streams: the chassis part's state (x, y, heading, collisions, …), the sonar's distance and the
 * servos' angles, on top of the project's `world` block.
 */
export class WorldTracker {
  private spec: WorldSpec | undefined;
  private project: Project | undefined;
  private states = new Map<string, VisualState>();
  private trail: { x: number; y: number }[] = [];
  private tMs = 0;
  private version = 0;

  setProject(p: Project): void {
    this.project = p;
    try {
      this.spec = p.world ? parseWorld(p.world, p) : undefined;
    } catch {
      this.spec = undefined;
    }
    this.version++;
  }

  get hasWorld(): boolean {
    return this.spec !== undefined;
  }

  get hasArm(): boolean {
    return this.spec?.arm !== undefined;
  }

  get hasRobot(): boolean {
    return this.spec?.robot !== undefined || (this.spec?.obstacles.length ?? 0) > 0;
  }

  reset(): void {
    this.states.clear();
    this.trail = [];
    this.tMs = 0;
    this.version++;
  }

  apply(states: Record<string, VisualState> | undefined, vt: number): void {
    if (!this.spec || !states) return;
    for (const [id, st] of Object.entries(states)) this.states.set(id, { ...(this.states.get(id) ?? {}), ...st });
    if (vt < this.tMs) this.trail = [];
    this.tMs = vt;
    const c = this.spec.robot ? this.states.get(this.spec.robot.chassis) : undefined;
    if (c && typeof c.x === "number" && typeof c.y === "number") {
      const last = this.trail.at(-1);
      if (!last || Math.hypot(last.x - c.x, last.y - (c.y as number)) > 1) this.trail.push({ x: c.x, y: c.y as number });
      if (this.trail.length > 3000) this.trail.shift();
    }
  }

  snapshot = (): WorldSnapshot | undefined => {
    const spec = this.spec;
    if (!spec) return undefined;
    const num = (s: VisualState | undefined, k: string, d = 0) => (typeof s?.[k] === "number" ? (s[k] as number) : d);
    const snap: WorldSnapshot = {
      tMs: this.tMs + this.version * 1e-6,
      arena: spec.arena,
      walls: spec.walls,
      obstacles: spec.obstacles,
      trail: this.trail,
      stats: { timeS: this.tMs / 1000, collisions: 0, minClearanceCm: Infinity, travelledCm: 0 },
    };
    if (spec.robot) {
      const c = this.states.get(spec.robot.chassis);
      const pose = c && typeof c.x === "number" ? { x: num(c, "x"), y: num(c, "y"), heading: num(c, "heading") } : spec.robot.start;
      const length = num(c, "length", 20);
      const robot: NonNullable<WorldSnapshot["robot"]> = { pose, length, width: num(c, "width", 15), trackWidth: num(c, "trackWidth", 13.5), axleOffset: -length / 4, wheelSpeeds: { left: 0, right: 0 }, speed: num(c, "speed"), touching: [] };
      const sonarState = spec.robot.sonar ? this.states.get(spec.robot.sonar) : undefined;
      if (sonarState && typeof sonarState.distance === "number") {
        const h = (pose.heading * Math.PI) / 180;
        const off = num(c, "sensorOffset", 15) * 0.5 + length * 0.25;
        const from = { x: pose.x + Math.cos(h) * off, y: pose.y + Math.sin(h) * off };
        const d = sonarState.distance as number;
        const to = { x: from.x + Math.cos(h) * d, y: from.y + Math.sin(h) * d };
        robot.sonar = { distanceCm: d, from, to, rays: [{ ...to, hit: d < 400 }] } as NonNullable<typeof robot.sonar>;
      }
      snap.robot = robot;
      snap.stats = { timeS: this.tMs / 1000, collisions: num(c, "collisions"), minClearanceCm: num(c, "minClearance", Infinity), travelledCm: num(c, "travelled"), pose };
    }
    if (spec.arm) {
      const angles = spec.arm.joints.map((j) => num(this.states.get(j.servo), "angle", j.zero));
      snap.arm = { spec: spec.arm, pose: armPose(spec.arm, angles), servoAngles: angles };
    }
    return snap;
  };
}

export const worldTracker = new WorldTracker();
