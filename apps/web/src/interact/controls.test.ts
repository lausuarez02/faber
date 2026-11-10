import { describe, expect, it } from "vitest";
import { getDef } from "../lib/parts.ts";
import { controlHitRect, controlOf, isImu, knobValue, motionSample, sensorProps, tiltFromDrag, tiltToAccel } from "./controls.ts";

// Round 5, live track: which running parts take a press, a flip, a turn, a tilt or a slider.
describe("live controls from part specs", () => {
  it("pushbutton presses, slide switch flips, potentiometer turns; boards and LEDs take nothing", () => {
    expect(controlOf(getDef("pushbutton"))).toBe("button");
    expect(controlOf(getDef("slide-switch"))).toBe("toggle");
    expect(controlOf(getDef("potentiometer"))).toBe("knob");
    expect(controlOf(getDef("arduino-uno"))).toBeUndefined();
    expect(controlOf(getDef("led"))).toBeUndefined();
  });

  it("IMU parts get the tilt pad; sensors get sliders for what they measure, not how they are built", () => {
    expect(isImu(getDef("mpu6050"))).toBe(true);
    expect(isImu(getDef("bme280"))).toBe(false);
    expect(sensorProps(getDef("mpu6050")).map((p) => p.id)).toEqual(["temperature"]);
    expect(sensorProps(getDef("hc-sr04")).map((p) => p.id)).toEqual(["distance", "temperature"]);
    expect(sensorProps(getDef("photoresistor")).map((p) => p.id)).toEqual(["lux"]);
    expect(sensorProps(getDef("bme280")).map((p) => p.id)).toEqual(["temperature", "humidity", "pressure"]);
    expect(sensorProps(getDef("potentiometer"))).toEqual([]);
    expect(sensorProps(getDef("led"))).toEqual([]);
  });

  it("knob drag: right / up turns up, clamped to 0..1", () => {
    expect(knobValue(0.5, 80, 0)).toBe(1);
    expect(knobValue(0.5, 0, 40)).toBe(0.25);
    expect(knobValue(0.1, -500, 0)).toBe(0);
  });

  it("tilt maps to gravity on the sensor axes (flat = +1 g on Z)", () => {
    expect(tiltToAccel(0, 0)).toEqual({ x: -0, y: 0, z: 1 });
    expect(tiltToAccel(90, 0)).toMatchObject({ y: 1 });
    expect(tiltToAccel(0, 90)).toMatchObject({ x: -1 });
    const a = tiltToAccel(30, 20);
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(1, 2);
  });

  // Round 6, canvas track.
  it("the hit area is the cap grown to at least 30 px, inside the part; no cap found = the middle", () => {
    expect(controlHitRect({ x: 26, y: 26, w: 28, h: 28 }, { w: 80, h: 80 })).toEqual({ x: 20, y: 20, w: 40, h: 40 });
    expect(controlHitRect({ x: 0, y: 0, w: 4, h: 4 }, { w: 80, h: 80 })).toEqual({ x: 0, y: 0, w: 30, h: 30 });
    expect(controlHitRect(undefined, { w: 100, h: 50 })).toEqual({ x: 20, y: 10, w: 60, h: 30 });
  });

  it("dragging an IMU tilts it 1° per 2 px, clamped to ±60°", () => {
    expect(tiltFromDrag({ pitch: 0, roll: 0 }, 40, -20)).toEqual({ pitch: 10, roll: 20 });
    expect(tiltFromDrag({ pitch: 50, roll: 0 }, 0, -100)).toEqual({ pitch: 60, roll: 0 });
  });

  it("motions are functions of virtual time: shake swings ±2.2 g at 7 Hz, drop falls 0.4 s then bumps", () => {
    const base = { x: 0, y: 0, z: 1 };
    const peak = motionSample("shake", 1000 / 28, base); // a quarter period
    expect(peak.accelX).toBeCloseTo(2.2, 2);
    expect(motionSample("shake", 1000 / 28, base)).toEqual(peak); // deterministic
    // Every sample of a shake is a jolt: |a| at least 1.8 g and the wrist turning at 250 °/s.
    for (let t = 0; t < 1000; t += 7) {
      const m = motionSample("shake", t, base);
      expect(Math.hypot(m.accelX ?? 0, m.accelY ?? 0, m.accelZ ?? 0)).toBeGreaterThan(1.8);
      expect(Math.hypot(m.gyroX ?? 0, m.gyroY ?? 0, m.gyroZ ?? 0)).toBeCloseTo(250, 0);
    }
    expect(motionSample("drop", 100, base).accelZ).toBe(0);
    expect(motionSample("drop", 450, base).accelZ).toBe(6);
    expect(motionSample("spin", 10, base).gyroZ).toBe(360);
  });
});
