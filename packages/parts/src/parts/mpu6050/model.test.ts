import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { i2cWires, serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { Mpu6050 } from "./model.ts";

const def = need(registry.get("mpu6050"), "mpu6050");

function wr(chip: Mpu6050, reg: number, v: number) {
  chip.connect(false);
  chip.write(reg);
  chip.write(v);
}
function rd(chip: Mpu6050, reg: number, n: number) {
  chip.connect(false);
  chip.write(reg);
  chip.connect(true);
  return Array.from({ length: n }, () => chip.read());
}
const s16 = (h: number, l: number) => ((h << 8) | l) << 16 >> 16;

describe("mpu6050: registers", () => {
  it("WHO_AM_I, sleep at power-up, wake and sample", () => {
    const chip = new Mpu6050();
    expect(rd(chip, 0x75, 1)).toEqual([0x68]);
    expect(chip.asleep).toBe(true);
    expect(rd(chip, 0x3b, 6)).toEqual([0, 0, 0, 0, 0, 0]); // asleep: no data
    wr(chip, 0x6b, 0x01);
    chip.motion = { accelX: 0.5, accelY: -1, accelZ: 1, gyroX: 10, gyroY: 0, gyroZ: -250, temperature: 36.53 };
    const d = rd(chip, 0x3b, 14);
    expect(s16(d[0]!, d[1]!)).toBe(8192);
    expect(s16(d[2]!, d[3]!)).toBe(-16384);
    expect(s16(d[4]!, d[5]!)).toBe(16384);
    expect(s16(d[6]!, d[7]!)).toBe(0);
    expect(s16(d[8]!, d[9]!)).toBe(1310);
    expect(s16(d[12]!, d[13]!)).toBe(-32750);
  });

  it("scales with the full-scale range and saturates", () => {
    const chip = new Mpu6050();
    wr(chip, 0x6b, 0x00);
    wr(chip, 0x1c, 3 << 3); // ±16 g
    chip.motion.accelX = 3;
    let d = rd(chip, 0x3b, 2);
    expect(s16(d[0]!, d[1]!)).toBe(6144);
    wr(chip, 0x1c, 0); // ±2 g
    d = rd(chip, 0x3b, 2);
    expect(s16(d[0]!, d[1]!)).toBe(32767);
    expect(chip.saturated).toEqual(["accelX"]);
  });

  it("DEVICE_RESET restores the defaults", () => {
    const chip = new Mpu6050();
    wr(chip, 0x6b, 0x01);
    wr(chip, 0x1b, 0x18);
    wr(chip, 0x6b, 0x80);
    expect(rd(chip, 0x6b, 1)).toEqual([0x40]);
    expect(rd(chip, 0x1b, 1)).toEqual([0]);
  });

  it("takes its address from AD0", () => {
    const b = mount(def, { id: "imu", wiring: { VCC: "v", GND: GROUND, AD0: "ad0" } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    expect(b.model.i2c!.i2cAddress()).toBe(0x68);
    b.solve((c) => {
      c.voltageSource("v", GROUND, 5, 0.01);
      c.resistor("v", "ad0", 1);
    });
    expect(b.model.i2c!.i2cAddress()).toBe(0x69);
    expect(b.model.visualState().address).toBe(0x69);
  });
});

describe("mpu6050: real firmware (Adafruit_MPU6050)", { timeout: 120_000 }, () => {
  it("reads the motion set on the part, and follows setProps from a physics step", () => {
    const sim = unoBench({
      parts: [{ id: "imu", type: "mpu6050", x: 0, y: 0, props: { accelX: 0.5, gyroZ: 90, temperature: 30 } }],
      wires: i2cWires("imu"),
      hex: "./example.hex",
      base: import.meta.url,
    });
    sim.runFor(500);
    const lines = serialLines(sim);
    expect(lines[0]).toBe("MPU6050 ready");
    const nums = (l: string) => l.match(/-?\d+\.\d+/g)!.map(Number);
    const [ax, ay, az, gx, gy, gz, t] = nums(lines.at(-1)!);
    expect(ax).toBeCloseTo(0.5 * 9.80665, 1);
    expect(ay).toBeCloseTo(0, 1);
    expect(az).toBeCloseTo(9.81, 1);
    expect(gx).toBeCloseTo(0, 2);
    expect(gy).toBeCloseTo(0, 2);
    expect(gz).toBeCloseTo((90 * Math.PI) / 180, 2);
    expect(t).toBeCloseTo(30, 0);
    sim.setProps("imu", { accelX: -1, accelZ: 0 });
    sim.runFor(300);
    const after = nums(serialLines(sim).at(-1)!);
    expect(after[0]).toBeCloseTo(-9.81, 1);
    expect(after[2]).toBeCloseTo(0, 1);
  });
});
