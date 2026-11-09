// Top-down 2D world with a differential-drive robot, on Rapier 2D.
//
// Units inside Rapier are metres, seconds, kilograms. The public API speaks centimetres and
// degrees (like the world spec). One step() is one fixed timestep; nothing here reads a clock.
import type { Collider, RigidBody, World } from "@dimforge/rapier2d-compat";
import { rapier } from "./rapier.ts";
import type { Obstacle, Wall, WorldSpec } from "./world.ts";

/** Fixed physics timestep (s). The binding steps it every 4 ms of virtual time. */
export const PHYSICS_DT = 0.004;
const G = 9.81;
/** Share of the weight on each drive wheel (the caster carries the rest). */
const DRIVE_WHEEL_LOAD = 0.4;
/** Caster + bearing rolling resistance (1/s), applied as velocity decay. */
const ROLLING_DECAY = 0.6;
/** HC-SR04 beam: 7 rays over ±15° (a 30° cone, what measured beam patterns show for walls and large objects; see hc-sr04 fidelity). */
export const SONAR_HALF_ANGLE_DEG = 15;
export const SONAR_RAYS = 7;
export const SONAR_MAX_CM = 400;
/** IR obstacle sensor (FC-51 class): a narrow beam, 3 rays over ±5°, seen up to 40 cm. */
export const IR_HALF_ANGLE_DEG = 5;
export const IR_RAYS = 3;
export const IR_MAX_CM = 40;
/** A bump switch's lever reaches this far past the body edge (cm), over ±20°. */
export const BUMP_REACH_CM = 1;
export const BUMP_HALF_ANGLE_DEG = 20;
/** Counts as touching when the gap is at most this (m). */
const TOUCH_M = 0.002;

export interface RobotBody {
  /** cm */
  length: number;
  /** cm */
  width: number;
  /** kg */
  mass: number;
  /** cm */
  wheelRadius: number;
  /** cm */
  trackWidth: number;
  /** tyre-floor friction coefficient */
  grip: number;
  /** sensor distance ahead of the wheel axle (cm) */
  sensorOffset: number;
  /** wheel axle position relative to the body centre, along the body (cm; negative = behind) */
  axleOffset: number;
}

export interface Pose {
  /** cm */
  x: number;
  /** cm */
  y: number;
  /** degrees, 0 = +x, 90 = +y */
  heading: number;
}

export interface SonarReading {
  /** cm to the nearest hit within the cone, or 0 when nothing is within 400 cm. */
  distanceCm: number;
  /** Sensor position (cm). */
  from: { x: number; y: number };
  /** End of the centre ray (hit point, or 400 cm out). */
  to: { x: number; y: number };
  /** Each ray's end (cm) for drawing the cone. */
  rays: { x: number; y: number; hit: boolean }[];
}

const rot = (x: number, y: number, a: number) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

export class RoverWorld {
  readonly world: World;
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly statics: { collider: Collider; id: string }[] = [];
  readonly spec: WorldSpec;
  readonly robot: RobotBody;
  private touching = new Set<number>();
  private _collisions = 0;
  private _minClearance = Infinity;
  private _clearance = Infinity;
  private _travelled = 0;
  private _steps = 0;
  /** Wheel surface speeds (m/s) asked for in the last step. */
  private wheelTarget = { left: 0, right: 0 };
  private _lastAccel = { forward: 0, lateral: 0 };
  private lastVel = { x: 0, y: 0 };

  constructor(spec: WorldSpec, robot: RobotBody, start: Pose) {
    const R = rapier();
    this.spec = spec;
    this.robot = robot;
    this.world = new R.World({ x: 0, y: 0 });
    this.world.timestep = PHYSICS_DT;

    // Arena walls, walls and obstacles: fixed colliders.
    const fixed = (desc: ReturnType<typeof R.ColliderDesc.cuboid>, id: string) => {
      this.statics.push({ collider: this.world.createCollider(desc.setFriction(0.3)), id });
    };
    const { width: W, height: H, enclosed, wallThickness: T } = spec.arena;
    if (enclosed) {
      const t = T / 100;
      const w = W / 100;
      const h = H / 100;
      fixed(R.ColliderDesc.cuboid(w / 2 + t, t / 2).setTranslation(w / 2, -t / 2), "wall-top");
      fixed(R.ColliderDesc.cuboid(w / 2 + t, t / 2).setTranslation(w / 2, h + t / 2), "wall-bottom");
      fixed(R.ColliderDesc.cuboid(t / 2, h / 2 + t).setTranslation(-t / 2, h / 2), "wall-left");
      fixed(R.ColliderDesc.cuboid(t / 2, h / 2 + t).setTranslation(w + t / 2, h / 2), "wall-right");
    }
    spec.walls.forEach((wl: Wall, i) => {
      const dx = (wl.x2 - wl.x1) / 100;
      const dy = (wl.y2 - wl.y1) / 100;
      const len = Math.hypot(dx, dy);
      fixed(
        R.ColliderDesc.cuboid(len / 2, wl.thickness / 200)
          .setTranslation((wl.x1 + wl.x2) / 200, (wl.y1 + wl.y2) / 200)
          .setRotation(Math.atan2(dy, dx)),
        wl.id ?? `walls[${i}]`,
      );
    });
    spec.obstacles.forEach((o: Obstacle, i) => {
      const id = o.id ?? `obstacles[${i}]`;
      if (o.shape === "circle") fixed(R.ColliderDesc.ball(o.r / 100).setTranslation(o.x / 100, o.y / 100), id);
      else fixed(R.ColliderDesc.cuboid(o.w / 200, o.h / 200).setTranslation(o.x / 100, o.y / 100).setRotation((o.angle * Math.PI) / 180), id);
    });

    // The robot: one dynamic box. Mass and inertia from its size and mass.
    const L = robot.length / 100;
    const Wd = robot.width / 100;
    this.body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(start.x / 100, start.y / 100)
        .setRotation((start.heading * Math.PI) / 180)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    this.collider = this.world.createCollider(R.ColliderDesc.cuboid(L / 2, Wd / 2).setDensity(robot.mass / (L * Wd)).setFriction(0.3).setRestitution(0), this.body);
    // Settle the broad phase so queries work before the first step.
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = PHYSICS_DT;
    this.updateContacts();
  }

  get collisions(): number {
    return this._collisions;
  }
  /** Smallest gap (cm) between the robot and any wall/obstacle so far. */
  get minClearanceCm(): number {
    return this._minClearance * 100;
  }
  /** Gap (cm) right now. */
  get clearanceCm(): number {
    return this._clearance * 100;
  }
  get travelledCm(): number {
    return this._travelled * 100;
  }
  get steps(): number {
    return this._steps;
  }
  get timeS(): number {
    return this._steps * PHYSICS_DT;
  }
  /** Ids of what the robot touches now. */
  touchingIds(): string[] {
    return this.statics.filter((s) => this.touching.has(s.collider.handle)).map((s) => s.id);
  }

  pose(): Pose {
    const t = this.body.translation();
    let deg = (this.body.rotation() * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    return { x: t.x * 100, y: t.y * 100, heading: deg };
  }

  /** Forward speed (cm/s, signed) and yaw rate (deg/s, positive = towards +y / clockwise on screen). */
  motion(): { speed: number; yawRate: number; accelForward: number; accelLateral: number } {
    const v = this.body.linvel();
    const a = this.body.rotation();
    return {
      speed: (v.x * Math.cos(a) + v.y * Math.sin(a)) * 100,
      yawRate: (this.body.angvel() * 180) / Math.PI,
      accelForward: this._lastAccel.forward,
      accelLateral: this._lastAccel.lateral,
    };
  }

  wheelSpeeds(): { left: number; right: number } {
    return { left: this.wheelTarget.left * 100, right: this.wheelTarget.right * 100 };
  }

  /**
   * Advance one fixed step with the wheels turning at `leftOmega` / `rightOmega` (rad/s, positive
   * = drive forward). Each wheel is a velocity constraint at its contact point: along the wheel it
   * pulls the contact speed towards ω·r, sideways towards 0, each limited by grip·load·dt
   * (Coulomb friction), solved with accumulated impulses (stable, no tuning gains).
   */
  step(leftOmega: number, rightOmega: number): void {
    const rb = this.robot;
    const m = this.body.mass();
    const I = this.body.principalInertia();
    const theta = this.body.rotation();
    const v0 = this.body.linvel();
    let vx = v0.x;
    let vy = v0.y;
    let w = this.body.angvel();
    const f = { x: Math.cos(theta), y: Math.sin(theta) };
    const l = { x: -Math.sin(theta), y: Math.cos(theta) };
    const r = rb.wheelRadius / 100;
    this.wheelTarget = { left: leftOmega * r, right: rightOmega * r };
    const maxJ = rb.grip * m * G * DRIVE_WHEEL_LOAD * PHYSICS_DT;
    const axle = rb.axleOffset / 100;
    const half = rb.trackWidth / 200;
    // Left wheel is on the robot's left: body-frame y = −half (y points to the robot's right).
    const wheels = [
      { r: rot(axle, -half, theta), s: this.wheelTarget.left, jf: 0, jl: 0 },
      { r: rot(axle, half, theta), s: this.wheelTarget.right, jf: 0, jl: 0 },
    ];
    for (let it = 0; it < 8; it++) {
      for (const wh of wheels) {
        for (const dirIsF of [true, false]) {
          const d = dirIsF ? f : l;
          const vpx = vx - w * wh.r.y;
          const vpy = vy + w * wh.r.x;
          const err = (dirIsF ? wh.s : 0) - (vpx * d.x + vpy * d.y);
          const rxd = wh.r.x * d.y - wh.r.y * d.x;
          const k = 1 / m + (rxd * rxd) / I;
          const acc = dirIsF ? wh.jf : wh.jl;
          const next = Math.max(-maxJ, Math.min(maxJ, acc + err / k));
          const dj = next - acc;
          if (dirIsF) wh.jf = next;
          else wh.jl = next;
          vx += (d.x * dj) / m;
          vy += (d.y * dj) / m;
          w += (rxd * dj) / I;
        }
      }
    }
    const decay = Math.max(0, 1 - ROLLING_DECAY * PHYSICS_DT);
    vx *= decay;
    vy *= decay;
    w *= decay;
    this.body.setLinvel({ x: vx, y: vy }, true);
    this.body.setAngvel(w, true);
    const before = this.body.translation();
    this.world.step();
    const after = this.body.translation();
    this._travelled += Math.hypot(after.x - before.x, after.y - before.y);
    const v1 = this.body.linvel();
    const a1 = this.body.rotation();
    const ax = (v1.x - this.lastVel.x) / PHYSICS_DT;
    const ay = (v1.y - this.lastVel.y) / PHYSICS_DT;
    this._lastAccel = { forward: ax * Math.cos(a1) + ay * Math.sin(a1), lateral: -ax * Math.sin(a1) + ay * Math.cos(a1) };
    this.lastVel = { x: v1.x, y: v1.y };
    this._steps++;
    this.updateContacts();
  }

  private updateContacts(): void {
    let clearance = Infinity;
    for (const s of this.statics) {
      const c = this.collider.contactCollider(s.collider, 1.0);
      const dist = c ? c.distance : Infinity;
      if (dist < clearance) clearance = dist;
      const h = s.collider.handle;
      if (dist <= TOUCH_M) {
        if (!this.touching.has(h)) {
          this.touching.add(h);
          if (this._steps > 0) this._collisions++;
        }
      } else this.touching.delete(h);
    }
    this._clearance = Math.max(0, clearance);
    if (this._steps > 0 && this._clearance < this._minClearance) this._minClearance = this._clearance;
  }

  /** Raycast cone from the sensor, ±15° in 7 rays; nearest hit within 400 cm. */
  /**
   * A beam from the body edge at `angleDeg` from the heading (negative = left), as `rays` rays
   * over ±halfAngleDeg, up to maxCm past the edge. distanceCm 0 = nothing within range.
   */
  range(angleDeg: number, halfAngleDeg: number, rays: number, maxCm: number): SonarReading {
    const R = rapier();
    const t = this.body.translation();
    const heading = this.body.rotation();
    const local = (angleDeg * Math.PI) / 180;
    // Distance from the body centre to its rectangle's edge along the mount direction (m).
    const hx = this.robot.length / 200;
    const hy = this.robot.width / 200;
    const c = Math.abs(Math.cos(local));
    const sn = Math.abs(Math.sin(local));
    const edge = Math.min(c > 1e-9 ? hx / c : Infinity, sn > 1e-9 ? hy / sn : Infinity);
    const a = heading + local;
    const o = { x: t.x + edge * Math.cos(a), y: t.y + edge * Math.sin(a) };
    const max = maxCm / 100;
    let best = Infinity;
    const out: SonarReading["rays"] = [];
    let centre = { x: o.x + max * Math.cos(a), y: o.y + max * Math.sin(a) };
    for (let i = 0; i < rays; i++) {
      const da = rays === 1 ? 0 : ((-halfAngleDeg + (2 * halfAngleDeg * i) / (rays - 1)) * Math.PI) / 180;
      const dir = { x: Math.cos(a + da), y: Math.sin(a + da) };
      const hit = this.world.castRay(new R.Ray(o, dir), max, true, undefined, undefined, this.collider);
      const toi = hit ? hit.timeOfImpact : max;
      const end = { x: o.x + dir.x * toi, y: o.y + dir.y * toi };
      out.push({ x: end.x * 100, y: end.y * 100, hit: !!hit });
      if (hit && toi < best) best = toi;
      if (i === (rays - 1) / 2) centre = end;
    }
    return {
      distanceCm: Number.isFinite(best) ? Math.max(best * 100, 0.1) : 0,
      from: { x: o.x * 100, y: o.y * 100 },
      to: { x: centre.x * 100, y: centre.y * 100 },
      rays: out,
    };
  }

  sonar(): SonarReading {
    const R = rapier();
    const t = this.body.translation();
    const a = this.body.rotation();
    const off = (this.robot.axleOffset + this.robot.sensorOffset) / 100;
    const o = { x: t.x + off * Math.cos(a), y: t.y + off * Math.sin(a) };
    const max = SONAR_MAX_CM / 100;
    let best = Infinity;
    const rays: SonarReading["rays"] = [];
    let centre = { x: o.x + max * Math.cos(a), y: o.y + max * Math.sin(a) };
    for (let i = 0; i < SONAR_RAYS; i++) {
      const da = ((-SONAR_HALF_ANGLE_DEG + (2 * SONAR_HALF_ANGLE_DEG * i) / (SONAR_RAYS - 1)) * Math.PI) / 180;
      const dir = { x: Math.cos(a + da), y: Math.sin(a + da) };
      const hit = this.world.castRay(new R.Ray(o, dir), max, true, undefined, undefined, this.collider);
      const toi = hit ? hit.timeOfImpact : max;
      const end = { x: o.x + dir.x * toi, y: o.y + dir.y * toi };
      rays.push({ x: end.x * 100, y: end.y * 100, hit: !!hit });
      if (hit && toi < best) best = toi;
      if (i === (SONAR_RAYS - 1) / 2) centre = end;
    }
    return {
      distanceCm: Number.isFinite(best) ? Math.max(best * 100, 0.5) : 0,
      from: { x: o.x * 100, y: o.y * 100 },
      to: { x: centre.x * 100, y: centre.y * 100 },
      rays,
    };
  }

  free(): void {
    this.world.free();
  }
}
