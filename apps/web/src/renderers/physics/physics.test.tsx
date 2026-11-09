import { describe, expect, it } from "vitest";
import type { WorldSnapshot } from "@jumper/physics";
import { drawArm, drawWorld, fitArena, type Ctx2D } from "./paint.ts";
import { PHYSICS_VIEWS, registerPhysicsViews } from "./index.ts";

/** Records painter calls; enough of a 2D context for the painters. */
function recorder() {
  const calls: string[] = [];
  const texts: string[] = [];
  const ctx = new Proxy({ fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1, textAlign: "left", textBaseline: "alphabetic" } as unknown as Ctx2D, {
    get(t, k) {
      if (k in t) return (t as unknown as Record<string | symbol, unknown>)[k];
      if (k === "measureText") return (text: string) => ({ width: text.length * 6.6 }); // 11px mono
      return (...args: unknown[]) => {
        calls.push(String(k));
        if (k === "fillText") texts.push(String(args[0]));
      };
    },
    set(t, k, v) {
      (t as unknown as Record<string | symbol, unknown>)[k] = v;
      return true;
    },
  });
  return { ctx, calls, texts };
}

const snap: WorldSnapshot = {
  tMs: 1234,
  arena: { width: 300, height: 200, enclosed: true, wallThickness: 2 },
  walls: [{ x1: 0, y1: 100, x2: 50, y2: 100, thickness: 2 }],
  obstacles: [
    { shape: "box", x: 160, y: 80, w: 36, h: 36, angle: 15, id: "crate" },
    { shape: "circle", x: 240, y: 150, r: 12, id: "pillar" },
  ],
  robot: {
    pose: { x: 40, y: 40, heading: 30 },
    length: 20,
    width: 15,
    trackWidth: 13.5,
    axleOffset: -5,
    wheelSpeeds: { left: 40, right: 40 },
    speed: 40,
    touching: [],
    sonar: { distanceCm: 120, from: { x: 50, y: 45 }, to: { x: 150, y: 100 }, rays: [{ x: 150, y: 90, hit: true }, { x: 150, y: 100, hit: true }] },
  },
  trail: [{ x: 40, y: 40 }, { x: 45, y: 42 }],
  stats: { timeS: 1.234, collisions: 0, minClearanceCm: 12.3, travelledCm: 55 },
  arm: {
    spec: { base: { x: 0, y: 6 }, links: [12, 10], joints: [{ servo: "shoulder", zero: 0, direction: 1, offset: 0 }, { servo: "elbow", zero: 90, direction: 1, offset: 0 }], targets: [{ id: "cup", x: 15, y: 4, r: 2 }] },
    pose: { linkAngles: [45, 45], points: [{ x: 0, y: 6 }, { x: 8.5, y: 14.5 }, { x: 8.5, y: 24.5 }], end: { x: 8.5, y: 24.5 }, reached: [] },
    servoAngles: [45, 90],
  },
};

describe("physics painters", () => {
  it("fits the arena into the view with a margin", () => {
    const f = fitArena({ width: 300, height: 200 }, { width: 640, height: 400 });
    expect(f.scale).toBeGreaterThan(1);
    expect(f.ox).toBeGreaterThanOrEqual(16);
  });

  it("draws the world: floor, walls, obstacles, trail, sonar, robot and a stats line", () => {
    const r = recorder();
    drawWorld(r.ctx, snap, { width: 640, height: 400 });
    expect(r.calls.filter((c) => c === "arc").length).toBeGreaterThanOrEqual(2); // pillar + sonar hit
    expect(r.calls).toContain("strokeRect");
    expect(r.texts.at(-1)).toBe("t 1.2 s  ·  collisions 0  ·  min gap 12.3 cm  ·  travelled 0.55 m  ·  sonar 120 cm");
  });

  it("keeps the stats line inside a narrow World card (tighter, then two lines)", () => {
    const r = recorder();
    drawWorld(r.ctx, snap, { width: 300, height: 210 });
    expect(r.texts.slice(-2)).toEqual(["t 1.2 s · collisions 0 · min gap 12.3 cm", "travelled 0.55 m · sonar 120 cm"]);
  });

  it("draws the arm with joint labels and the gripper position", () => {
    const r = recorder();
    drawArm(r.ctx, snap, { width: 400, height: 300 });
    expect(r.texts).toContain("shoulder 45°");
    expect(r.texts).toContain("elbow 90°");
    expect(r.texts.at(-1)).toBe("gripper x 8.5 cm  y 24.5 cm");
  });

  it("registers a World and an Arm view and detects worlds in projects", () => {
    const p = registerPhysicsViews();
    expect(PHYSICS_VIEWS.map((v) => v.id)).toEqual(["world", "arm"]);
    expect(p.hasWorld({ format: "jumper/1", world: { arena: { width: 100, height: 100 } } })).toBe(true);
    expect(p.hasWorld('{"format":"jumper/1"}')).toBe(false);
  });
});
