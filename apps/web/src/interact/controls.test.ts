import { describe, expect, it } from "vitest";
import { getDef } from "../lib/parts.ts";
import { controlOf, isImu, knobValue, sensorProps, tiltToAccel } from "./controls.ts";

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
});
