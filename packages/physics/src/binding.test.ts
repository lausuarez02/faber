import { beforeAll, describe, expect, it } from "vitest";
import type { PartInteraction, SimEvent, VisualState } from "@fabwright/sim-core";
import { attachPhysics, type SimHost } from "./binding.ts";
import { initPhysics } from "./rapier.ts";

/** A stand-in Simulation: two motors at fixed speeds, a chassis, an IMU, a sonar; every() driven by hand. */
function fakeHost(omegaL: number, omegaR: number) {
  const got = new Map<string, Record<string, number>>();
  let tick: ((t: number) => void) | undefined;
  let t = 0;
  const states: Record<string, VisualState> = { mL: { omega: omegaL }, mR: { omega: omegaR }, chassis: { length: 20, width: 15, mass: 450, wheelRadius: 3.25, trackWidth: 13.5, grip: 0.8, sensorOffset: 15 } };
  const host = {
    project: { parts: [
      { id: "chassis", type: "robot-chassis-2wd" }, { id: "mL", type: "dc-motor" }, { id: "mR", type: "dc-motor" },
      { id: "imu", type: "mpu6050" }, { id: "sonar", type: "hc-sr04" },
    ] },
    get timeMs() {
      return t;
    },
    every: (_ms: number, cb: (t: number) => void) => {
      tick = cb;
      return () => (tick = undefined);
    },
    partState: (id: string) => states[id],
    interact: (id: string, e: PartInteraction) => {
      const m = got.get(id) ?? {};
      m[e.key!] = Number(e.value);
      got.set(id, m);
    },
    subscribe: (_l: (e: SimEvent) => void) => () => {},
  } as unknown as SimHost;
  const run = (ms: number) => {
    for (let i = 0; i < ms / 4; i++) {
      t += 4;
      tick?.(t);
    }
  };
  return { host, got, run };
}

beforeAll(async () => {
  await initPhysics();
});

describe("attachPhysics", () => {
  it("feeds the IMU in mpu6050 units: turning left (counter-clockwise from above) is +gyroZ", () => {
    const { host, got, run } = fakeHost(-5, 5); // left wheel back, right forward → turns left
    const phys = attachPhysics(host, { arena: { width: 400, height: 400 }, robot: { imu: "imu", start: { x: 200, y: 200 } } });
    run(400);
    const imu = got.get("imu")!;
    expect(imu.accelZ).toBe(1);
    expect(imu.gyroZ).toBeGreaterThan(130); // (2 · 5 · 0.0325 / 0.135) rad/s ≈ 138 °/s
    expect(imu.gyroZ).toBeLessThan(140);
    expect(phys.stats().pose!.heading).toBeGreaterThan(300); // heading decreases (counter-clockwise on screen)
    phys.dispose();
  });

  it("writes pose and stats into the chassis and the distance into the sonar", () => {
    const { host, got, run } = fakeHost(15, 15);
    const phys = attachPhysics(host, { arena: { width: 300, height: 100 }, robot: { start: { x: 50, y: 50 } } });
    run(1000);
    const c = got.get("chassis")!;
    expect(c.x).toBeGreaterThan(90);
    expect(c.collisions).toBe(0);
    expect(c.speed).toBeGreaterThan(45);
    expect(got.get("sonar")!.distance).toBeGreaterThan(0);
    expect(phys.snapshot().robot!.sonar!.rays).toHaveLength(7);
    phys.dispose();
  });
});
