// Ties a physics world to a running Simulation:
//   - steps every PHYSICS_STEP_MS of VIRTUAL time on the simulation clock (sim.every), so the
//     result is the same whatever the frame rate or runFor slicing;
//   - motors → wheels: reads each dc-motor's `omega` (rad/s);
//   - world → sensors: raycast distance into the HC-SR04 (interact "distance"), pose and
//     collision stats into the robot-chassis-2wd part (so `expect_part chassis.collisions == 0`
//     works in scenarios), body motion into an IMU part if one is named;
//   - servos → arm: reads each servo's `angle` and runs forward kinematics.
import type { PartInteraction, Simulation, Unsubscribe, VisualState } from "@faber/sim-core";
import { armPose, type ArmPose } from "./arm.ts";
import { BUMP_HALF_ANGLE_DEG, BUMP_REACH_CM, IR_HALF_ANGLE_DEG, IR_MAX_CM, IR_RAYS, PHYSICS_DT, RoverWorld, type Pose, type RobotBody, type SonarReading } from "./rover.ts";
import { parseWorld, type ArmSpec, type WorldSpec } from "./world.ts";

export const PHYSICS_STEP_MS = PHYSICS_DT * 1000;
/** A trail point every this many steps (100 ms). */
const TRAIL_EVERY = 25;
const TRAIL_MAX = 3000;

/** The part of Simulation the binding uses (so tests and other hosts can stand in for it). */
export type SimHost = Pick<Simulation, "every" | "partState" | "interact" | "subscribe" | "project" | "timeMs">;

export interface WorldSnapshot {
  tMs: number;
  arena: WorldSpec["arena"];
  walls: WorldSpec["walls"];
  obstacles: WorldSpec["obstacles"];
  robot?: {
    pose: Pose;
    length: number;
    width: number;
    trackWidth: number;
    axleOffset: number;
    wheelSpeeds: { left: number; right: number };
    speed: number;
    touching: string[];
    sonar?: SonarReading;
    /** IR obstacle sensors' beams (ir-proximity parts). */
    ir?: (SonarReading & { id: string })[];
    /** Bump switches and whether the physics presses them. */
    bumpers?: { id: string; pressed: boolean }[];
  };
  trail: { x: number; y: number }[];
  stats: PhysicsStats;
  arm?: { spec: ArmSpec; pose: ArmPose; servoAngles: number[] };
}

export interface PhysicsStats {
  timeS: number;
  collisions: number;
  /** Smallest gap between robot and any wall/obstacle so far (cm); Infinity before moving or without a robot. */
  minClearanceCm: number;
  travelledCm: number;
  pose?: Pose;
}

export interface PhysicsBinding {
  readonly world: WorldSpec;
  readonly rover: RoverWorld | undefined;
  snapshot(): WorldSnapshot;
  stats(): PhysicsStats;
  /** Pose samples (every 100 ms) since start/reset. */
  trail(): readonly { x: number; y: number }[];
  /** Hash of the pose trace, for determinism checks. */
  traceHash(): string;
  dispose(): void;
}

const n = (s: VisualState | undefined, k: string, d = 0) => {
  const v = s?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
};

/** Robot body from the chassis part's state (its props, echoed by the model). */
export function robotBodyFromState(s: VisualState | undefined): RobotBody {
  const length = n(s, "length", 20);
  return {
    length,
    width: n(s, "width", 15),
    mass: n(s, "mass", 450) / 1000,
    wheelRadius: n(s, "wheelRadius", 3.25),
    trackWidth: n(s, "trackWidth", 13.5),
    grip: n(s, "grip", 0.8),
    sensorOffset: n(s, "sensorOffset", 15),
    axleOffset: -length / 4,
  };
}

/**
 * Attach a world to a simulation. `world` is the raw `world` block from faber.json (validated
 * here, errors list every bad field) or an already parsed WorldSpec. Requires `await initPhysics()`
 * first when the world has a robot.
 */
export function attachPhysics(sim: SimHost, world: unknown): PhysicsBinding {
  const spec: WorldSpec = isParsed(world) ? world : parseWorld(world, sim.project);
  let rover: RoverWorld | undefined;
  let trail: { x: number; y: number }[] = [];
  let hash = 0x811c9dc5;
  let arm: WorldSnapshot["arm"];
  let sonar: SonarReading | undefined;
  let ir: (SonarReading & { id: string })[] = [];
  let bumpers: { id: string; pressed: boolean }[] = [];

  const set = (partId: string, key: string, value: number) => {
    const e: PartInteraction = { kind: "set", key, value };
    sim.interact(partId, e, { solve: false });
  };

  const build = () => {
    rover?.free();
    rover = undefined;
    trail = [];
    hash = 0x811c9dc5;
    sonar = undefined;
    ir = [];
    bumpers = [];
    const r = spec.robot;
    if (r) {
      const body = robotBodyFromState(sim.partState(r.chassis));
      rover = new RoverWorld(spec, body, r.start);
      publish();
    }
    updateArm();
  };

  const publish = () => {
    const r = spec.robot;
    if (!r || !rover) return;
    const p = rover.pose();
    if (r.sonar) {
      sonar = rover.sonar();
      set(r.sonar, "distance", sonar.distanceCm);
    }
    // IR obstacle sensors: the nearest hit in their narrow beam; bump switches: something within
    // the lever's reach on their side.
    ir = (r.ir ?? []).map((s) => {
      const reading = rover!.range(s.angleDeg, IR_HALF_ANGLE_DEG, IR_RAYS, IR_MAX_CM);
      set(s.id, "distance", reading.distanceCm);
      return { ...reading, id: s.id };
    });
    bumpers = (r.bumpers ?? []).map((b) => {
      const pressed = rover!.range(b.angleDeg, BUMP_HALF_ANGLE_DEG, 3, BUMP_REACH_CM).distanceCm > 0;
      set(b.id, "pressed", pressed ? 1 : 0);
      return { id: b.id, pressed };
    });
    const m = rover.motion();
    set(r.chassis, "x", p.x);
    set(r.chassis, "y", p.y);
    set(r.chassis, "heading", p.heading);
    set(r.chassis, "collisions", rover.collisions);
    set(r.chassis, "minClearance", Number.isFinite(rover.minClearanceCm) ? rover.minClearanceCm : 9999);
    set(r.chassis, "clearance", Number.isFinite(rover.clearanceCm) ? rover.clearanceCm : 9999);
    set(r.chassis, "travelled", rover.travelledCm);
    set(r.chassis, "speed", m.speed);
    if (r.imu) {
      // The mpu6050 part's units (g, °/s) and axes: chip flat, x forward, y to the robot's LEFT,
      // z up. Our top view has y down, so a clockwise turn on screen (heading increasing) is a
      // negative yaw about z-up, and the right-hand lateral acceleration is −y.
      set(r.imu, "accelX", m.accelForward / 9.81);
      set(r.imu, "accelY", -m.accelLateral / 9.81);
      set(r.imu, "accelZ", 1);
      set(r.imu, "gyroZ", -m.yawRate);
    }
  };

  const updateArm = () => {
    const a = spec.arm;
    if (!a) return;
    const angles = a.joints.map((j) => n(sim.partState(j.servo), "angle", j.zero));
    arm = { spec: a, pose: armPose(a, angles), servoAngles: angles };
  };

  const step = () => {
    const r = spec.robot;
    if (r && rover) {
      const wl = n(sim.partState(r.leftMotor), "omega");
      const wr = n(sim.partState(r.rightMotor), "omega");
      rover.step(wl, wr);
      publish();
      if (rover.steps % TRAIL_EVERY === 0) {
        const p = rover.pose();
        if (trail.length >= TRAIL_MAX) trail.shift();
        trail.push({ x: p.x, y: p.y });
        // FNV-1a over the pose rounded to 1 µm / 1 µdeg: equal hashes = identical runs.
        for (const v of [p.x, p.y, p.heading]) {
          const q = Math.round(v * 1e4);
          hash = Math.imul(hash ^ (q & 0xffff), 16777619) >>> 0;
          hash = Math.imul(hash ^ ((q >>> 16) & 0xffff), 16777619) >>> 0;
        }
      }
    }
    updateArm();
  };

  build();
  const unsubs: Unsubscribe[] = [
    sim.every(PHYSICS_STEP_MS, step),
    sim.subscribe((e) => {
      if (e.type === "reset") build();
    }),
  ];

  const stats = (): PhysicsStats => ({
    timeS: rover?.timeS ?? sim.timeMs / 1000,
    collisions: rover?.collisions ?? 0,
    minClearanceCm: rover?.minClearanceCm ?? Infinity,
    travelledCm: rover?.travelledCm ?? 0,
    ...(rover ? { pose: rover.pose() } : {}),
  });

  return {
    world: spec,
    get rover() {
      return rover;
    },
    stats,
    trail: () => trail,
    traceHash: () => hash.toString(16).padStart(8, "0"),
    snapshot(): WorldSnapshot {
      const r = spec.robot;
      const snap: WorldSnapshot = { tMs: sim.timeMs, arena: spec.arena, walls: spec.walls, obstacles: spec.obstacles, trail: trail.slice(), stats: stats() };
      if (r && rover) {
        snap.robot = {
          pose: rover.pose(),
          length: rover.robot.length,
          width: rover.robot.width,
          trackWidth: rover.robot.trackWidth,
          axleOffset: rover.robot.axleOffset,
          wheelSpeeds: rover.wheelSpeeds(),
          speed: rover.motion().speed,
          touching: rover.touchingIds(),
          ...(sonar ? { sonar } : {}),
          ...(ir.length ? { ir: ir.map((x) => ({ ...x, rays: x.rays.slice() })) } : {}),
          ...(bumpers.length ? { bumpers: bumpers.map((b) => ({ ...b })) } : {}),
        };
      }
      if (arm) snap.arm = arm;
      return snap;
    },
    dispose() {
      for (const u of unsubs.splice(0)) u();
      rover?.free();
      rover = undefined;
    },
  };
}

function isParsed(w: unknown): w is WorldSpec {
  return typeof w === "object" && w !== null && "arena" in w && Array.isArray((w as WorldSpec).walls) && Array.isArray((w as WorldSpec).obstacles) && typeof (w as WorldSpec).arena?.enclosed === "boolean";
}
