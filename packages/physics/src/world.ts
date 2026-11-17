// The "world" block of faber.json: what the robot lives in. Units are what people measure with
// a tape: centimetres and degrees. Coordinates are top-down, x to the right, y DOWN (like the
// canvas), heading 0 = facing +x, 90 = facing +y (clockwise on screen).
//
// Validation is hand-written (no zod) so every error names the field, says what is wrong and how
// to fix it, because agents act on these messages literally.

export interface Vec {
  x: number;
  y: number;
}

export type Obstacle =
  | { shape: "box"; x: number; y: number; w: number; h: number; angle: number; id?: string }
  | { shape: "circle"; x: number; y: number; r: number; id?: string };

export interface Wall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  id?: string;
}

export interface RobotSpec {
  /** Part id of the robot-chassis-2wd. */
  chassis: string;
  leftMotor: string;
  rightMotor: string;
  /** HC-SR04 part id facing forward, if any. */
  sonar?: string;
  /** IMU part id (MPU6050) fed with the body's motion, if any. */
  imu?: string;
  /** IR obstacle sensors (ir-proximity) and the side each looks at (degrees from the heading, from the part's mount prop). */
  ir?: { id: string; angleDeg: number }[];
  /** Bump switches (bump-switch) and the side each sits on. */
  bumpers?: { id: string; angleDeg: number }[];
  /** Start pose of the body centre (cm, cm, degrees). */
  start: { x: number; y: number; heading: number };
}

export interface ArmJoint {
  /** Servo part id driving this joint. */
  servo: string;
  /** Servo angle (deg) at which this joint is at `offset`. */
  zero: number;
  /** +1: servo angle up = joint turns counter-clockwise in the side view; -1 reverses. */
  direction: 1 | -1;
  /** Joint angle (deg) when the servo is at `zero`: for the first joint relative to +x, for others relative to the previous link. */
  offset: number;
}

export interface ArmSpec {
  /** Shoulder position in the side view (cm), y UP from the table. */
  base: Vec;
  /** Link lengths in cm, one per joint. */
  links: number[];
  joints: ArmJoint[];
  /** Points the gripper should reach (cm), for expectations and the view. */
  targets: { id: string; x: number; y: number; r: number }[];
}

export interface WorldSpec {
  /** Floor size in cm; four walls are added around it unless `walls: false` style is wanted (set enclosed false). */
  arena: { width: number; height: number; enclosed: boolean; wallThickness: number };
  walls: Wall[];
  obstacles: Obstacle[];
  robot?: RobotSpec;
  arm?: ArmSpec;
}

export class WorldSpecError extends Error {
  constructor(readonly issues: string[]) {
    super(`world is not valid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "WorldSpecError";
  }
}

/** Minimal view of the project's parts the resolver needs (id + type). */
export interface PartsView {
  parts: readonly { id: string; type: string; props?: Record<string, unknown> | undefined }[];
}

/**
 * Side a mounted sensor looks at, in degrees from the robot's heading (negative = left, as the
 * top view has y down): the `mount` prop of ir-proximity (corners at 30°) and bump-switch (45°).
 */
export function mountAngle(type: string, mount: string): number {
  const corner = type === "bump-switch" ? 45 : 30;
  const table: Record<string, number> = { front: 0, "front-left": -corner, "front-right": corner, left: -90, right: 90, rear: 180 };
  return table[mount] ?? 0;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse and check the `world` block. `project` lets it fill in the robot's part ids when there is
 * exactly one chassis / two motors / one sonar, and check that named parts exist with the right type.
 * Throws WorldSpecError listing every problem.
 */
export function parseWorld(raw: unknown, project?: PartsView): WorldSpec {
  const issues: string[] = [];
  if (!isObj(raw)) {
    throw new WorldSpecError([
      `world must be an object like { "arena": { "width": 300, "height": 200 }, "obstacles": [ ... ], "robot": { "start": { "x": 40, "y": 40, "heading": 0 } } }, got ${JSON.stringify(raw)}`,
    ]);
  }
  const num = (v: unknown, path: string, opts: { min?: number; max?: number; def?: number } = {}): number => {
    if (v === undefined && opts.def !== undefined) return opts.def;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push(`${path}: must be a number${opts.def === undefined ? "" : ` (or leave it out for ${opts.def})`}, got ${JSON.stringify(v)}`);
      return opts.def ?? 0;
    }
    if (opts.min !== undefined && v < opts.min) issues.push(`${path}: ${v} is below the minimum ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) issues.push(`${path}: ${v} is above the maximum ${opts.max}`);
    return v;
  };

  // arena
  const a = raw.arena;
  let arena: WorldSpec["arena"] = { width: 300, height: 200, enclosed: true, wallThickness: 2 };
  if (a !== undefined) {
    if (!isObj(a)) issues.push(`world.arena: must be { "width": <cm>, "height": <cm> }, got ${JSON.stringify(a)}`);
    else {
      arena = {
        width: num(a.width, "world.arena.width", { min: 20, max: 10000 }),
        height: num(a.height, "world.arena.height", { min: 20, max: 10000 }),
        enclosed: a.enclosed === undefined ? true : a.enclosed === true,
        wallThickness: num(a.wallThickness, "world.arena.wallThickness", { min: 0.5, max: 100, def: 2 }),
      };
    }
  }

  // walls
  const walls: Wall[] = [];
  if (raw.walls !== undefined) {
    if (!Array.isArray(raw.walls)) issues.push(`world.walls: must be a list of { "x1", "y1", "x2", "y2" } segments in cm`);
    else
      raw.walls.forEach((w, i) => {
        const p = `world.walls[${i}]`;
        if (!isObj(w)) return void issues.push(`${p}: must be { "x1": <cm>, "y1": <cm>, "x2": <cm>, "y2": <cm>, "thickness"?: <cm> }`);
        const wall: Wall = { x1: num(w.x1, `${p}.x1`), y1: num(w.y1, `${p}.y1`), x2: num(w.x2, `${p}.x2`), y2: num(w.y2, `${p}.y2`), thickness: num(w.thickness, `${p}.thickness`, { min: 0.5, def: 2 }) };
        if (typeof w.id === "string") wall.id = w.id;
        if (wall.x1 === wall.x2 && wall.y1 === wall.y2) issues.push(`${p}: start and end are the same point (${wall.x1}, ${wall.y1}); a wall needs two different ends`);
        walls.push(wall);
      });
  }

  // obstacles
  const obstacles: Obstacle[] = [];
  if (raw.obstacles !== undefined) {
    if (!Array.isArray(raw.obstacles)) issues.push(`world.obstacles: must be a list of boxes { "shape": "box", "x", "y", "w", "h" } or circles { "shape": "circle", "x", "y", "r" } (cm, x/y = centre)`);
    else
      raw.obstacles.forEach((o, i) => {
        const p = `world.obstacles[${i}]`;
        if (!isObj(o)) return void issues.push(`${p}: must be an object with "shape": "box" or "circle"`);
        const shape = o.shape ?? (o.r !== undefined ? "circle" : "box");
        const id = typeof o.id === "string" ? o.id : undefined;
        if (shape === "circle") {
          obstacles.push({ shape, x: num(o.x, `${p}.x`), y: num(o.y, `${p}.y`), r: num(o.r, `${p}.r`, { min: 0.5 }), ...(id ? { id } : {}) });
        } else if (shape === "box") {
          obstacles.push({ shape, x: num(o.x, `${p}.x`), y: num(o.y, `${p}.y`), w: num(o.w, `${p}.w`, { min: 0.5 }), h: num(o.h, `${p}.h`, { min: 0.5 }), angle: num(o.angle, `${p}.angle`, { def: 0 }), ...(id ? { id } : {}) });
        } else {
          issues.push(`${p}.shape: "${String(shape)}" is not a shape; use "box" (x, y, w, h, angle?) or "circle" (x, y, r)`);
        }
      });
  }

  // robot
  let robot: RobotSpec | undefined;
  const parts = project?.parts ?? [];
  const ofType = (t: string) => parts.filter((p) => p.type === t).map((p) => p.id);
  const typeOf = (id: string) => parts.find((p) => p.id === id)?.type;
  const pick = (given: unknown, path: string, type: string, what: string, required: boolean): string | undefined => {
    if (given !== undefined) {
      if (typeof given !== "string") {
        issues.push(`${path}: must be a part id (a string), got ${JSON.stringify(given)}`);
        return undefined;
      }
      if (project && typeOf(given) === undefined) issues.push(`${path}: there is no part '${given}' in the project; ${type} parts in it: ${ofType(type).join(", ") || "none"}`);
      else if (project && typeOf(given) !== type) issues.push(`${path}: part '${given}' is a ${typeOf(given)}, not a ${type}`);
      return given;
    }
    const found = ofType(type);
    if (found.length === 1) return found[0];
    if (!required) return undefined;
    if (found.length === 0) issues.push(`${path}: the robot needs ${what}, but the project has no '${type}' part. Add one (place_part type "${type}") and set ${path} to its id.`);
    else issues.push(`${path}: the project has ${found.length} '${type}' parts (${found.join(", ")}); say which one is ${what} by setting ${path}.`);
    return undefined;
  };
  if (raw.robot !== undefined) {
    const r = raw.robot;
    if (!isObj(r)) issues.push(`world.robot: must be an object like { "start": { "x": 40, "y": 40, "heading": 0 } }`);
    else {
      const chassis = pick(r.chassis, "world.robot.chassis", "robot-chassis-2wd", "the chassis", true);
      // Motors: explicit, or exactly two dc-motors whose ids say left/right.
      let left = r.leftMotor;
      let right = r.rightMotor;
      if (left === undefined || right === undefined) {
        const motors = ofType("dc-motor");
        const l = motors.find((m) => /left|(^|[^a-z])l($|[^a-z])|^ml$|^m_?l/i.test(m));
        const rr = motors.find((m) => /right|(^|[^a-z])r($|[^a-z])|^mr$|^m_?r/i.test(m));
        if (left === undefined && l !== undefined && motors.length === 2) left = l;
        if (right === undefined && rr !== undefined && motors.length === 2) right = rr;
        if (left === undefined || right === undefined) {
          issues.push(
            motors.length < 2
              ? `world.robot.leftMotor/rightMotor: a 2WD robot needs two 'dc-motor' parts; the project has ${motors.length}. Add them and wire them to the motor driver outputs.`
              : `world.robot.leftMotor/rightMotor: cannot tell which motor is which (${motors.join(", ")}). Set "leftMotor" and "rightMotor" to their part ids.`,
          );
        }
      }
      const leftMotor = pick(left, "world.robot.leftMotor", "dc-motor", "the left motor", true);
      const rightMotor = pick(right, "world.robot.rightMotor", "dc-motor", "the right motor", true);
      if (leftMotor && leftMotor === rightMotor) issues.push(`world.robot: leftMotor and rightMotor are both '${leftMotor}'; use two different motors`);
      const sonar = pick(r.sonar, "world.robot.sonar", "hc-sr04", "the forward sonar", false);
      const imu = r.imu === undefined ? undefined : pick(r.imu, "world.robot.imu", typeOf(String(r.imu)) ?? "mpu6050", "the IMU", false);
      const s = isObj(r.start) ? r.start : {};
      if (r.start !== undefined && !isObj(r.start)) issues.push(`world.robot.start: must be { "x": <cm>, "y": <cm>, "heading": <deg> }`);
      const start = {
        x: num(s.x, "world.robot.start.x", { def: Math.min(40, arena.width / 2) }),
        y: num(s.y, "world.robot.start.y", { def: Math.min(40, arena.height / 2) }),
        heading: num(s.heading, "world.robot.start.heading", { def: 0 }),
      };
      if (arena.enclosed && (start.x <= 0 || start.y <= 0 || start.x >= arena.width || start.y >= arena.height)) {
        issues.push(`world.robot.start: (${start.x}, ${start.y}) is outside the ${arena.width} × ${arena.height} cm arena; put the robot inside, e.g. { "x": 40, "y": 40 }`);
      }
      const mounted = (key: "ir" | "bumpers", type: string): { id: string; angleDeg: number }[] => {
        const given = r[key];
        let ids: string[];
        if (given === undefined) ids = ofType(type);
        else if (!Array.isArray(given) || given.some((g) => typeof g !== "string")) {
          issues.push(`world.robot.${key}: must be a list of ${type} part ids, e.g. ["${type === "ir-proximity" ? "irLeft" : "bumpFront"}"], or left out to use every ${type} in the project`);
          ids = [];
        } else {
          ids = given as string[];
          for (const id of ids) {
            if (project && typeOf(id) === undefined) issues.push(`world.robot.${key}: there is no part '${id}' in the project; ${type} parts in it: ${ofType(type).join(", ") || "none"}`);
            else if (project && typeOf(id) !== type) issues.push(`world.robot.${key}: part '${id}' is a ${typeOf(id)}, not a ${type}`);
          }
        }
        return ids.map((id) => {
          const mount = String(parts.find((p) => p.id === id)?.props?.mount ?? "front");
          return { id, angleDeg: mountAngle(type, mount) };
        });
      };
      const ir = mounted("ir", "ir-proximity");
      const bumpers = mounted("bumpers", "bump-switch");
      if (chassis && leftMotor && rightMotor) {
        robot = { chassis, leftMotor, rightMotor, start, ...(sonar ? { sonar } : {}), ...(imu ? { imu } : {}), ...(ir.length ? { ir } : {}), ...(bumpers.length ? { bumpers } : {}) };
      }
    }
  }

  // arm
  let arm: ArmSpec | undefined;
  if (raw.arm !== undefined) {
    const r = raw.arm;
    if (!isObj(r)) issues.push(`world.arm: must be { "links": [12, 10], "joints": [{ "servo": "s1" }, { "servo": "s2" }] }`);
    else {
      const servos = ofType("servo-sg90");
      const links = Array.isArray(r.links) ? r.links.map((l, i) => num(l, `world.arm.links[${i}]`, { min: 0.5 })) : [];
      if (!Array.isArray(r.links) || links.length === 0) issues.push(`world.arm.links: list the link lengths in cm, shoulder first, e.g. [12, 10]`);
      const jointsRaw = Array.isArray(r.joints) ? r.joints : [];
      if (!Array.isArray(r.joints)) issues.push(`world.arm.joints: list one { "servo": "<part id>" } per link, shoulder first`);
      const joints: ArmJoint[] = jointsRaw.map((j, i) => {
        const p = `world.arm.joints[${i}]`;
        const o = isObj(j) ? j : {};
        const servo = pick(o.servo, `${p}.servo`, "servo-sg90", `joint ${i}'s servo`, true) ?? servos[i] ?? "";
        const dir = o.direction === -1 ? -1 : 1;
        return { servo, zero: num(o.zero, `${p}.zero`, { def: i === 0 ? 0 : 90 }), direction: dir, offset: num(o.offset, `${p}.offset`, { def: 0 }) };
      });
      if (joints.length !== links.length) issues.push(`world.arm: ${links.length} link(s) but ${joints.length} joint(s); give one joint (servo) per link`);
      const b = isObj(r.base) ? r.base : {};
      const targets: ArmSpec["targets"] = [];
      if (Array.isArray(r.targets))
        r.targets.forEach((t, i) => {
          const p = `world.arm.targets[${i}]`;
          const o = isObj(t) ? t : {};
          targets.push({ id: typeof o.id === "string" ? o.id : `t${i}`, x: num(o.x, `${p}.x`), y: num(o.y, `${p}.y`), r: num(o.r, `${p}.r`, { min: 0.1, def: 2 }) });
        });
      arm = { base: { x: num(b.x, "world.arm.base.x", { def: 0 }), y: num(b.y, "world.arm.base.y", { def: 0 }) }, links, joints, targets };
    }
  }

  if (issues.length) throw new WorldSpecError(issues);
  return { arena, walls, obstacles, ...(robot ? { robot } : {}), ...(arm ? { arm } : {}) };
}

/** The `world` block of a raw faber.json (text or parsed), or undefined when it has none. */
export function worldOf(projectJson: string | unknown): unknown {
  const o = typeof projectJson === "string" ? (JSON.parse(projectJson) as unknown) : projectJson;
  return isObj(o) ? o.world : undefined;
}
