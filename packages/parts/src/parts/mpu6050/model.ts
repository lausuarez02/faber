// InvenSense MPU-6050 (register map RM-MPU-6000A-00 rev 4.2) on a GY-521 board.
// Accelerometer, gyroscope and temperature come from props (or sim.setProps from a physics step),
// scaled by the full-scale ranges the sketch selects, and saturate like the real ADCs.
import type { Diagnostic, I2cDevice, PartModel, PartModelFactory } from "@jumper/sim-core";
import { createI2cModule } from "../../lib/i2cModule.ts";
import { clamp, num, round } from "../../lib/props.ts";

const WHO_AM_I = 0x68;
/** LSB per g for AFS_SEL 0..3 and LSB per °/s for FS_SEL 0..3. */
export const ACCEL_LSB = [16384, 8192, 4096, 2048] as const;
export const GYRO_LSB = [131, 65.5, 32.8, 16.4] as const;

export interface Motion {
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  temperature: number;
}

const s16 = (v: number) => clamp(Math.round(v), -32768, 32767);

export class Mpu6050 {
  regs = new Uint8Array(128);
  private ptr = 0;
  private first = true;
  motion: Motion = { accelX: 0, accelY: 0, accelZ: 1, gyroX: 0, gyroY: 0, gyroZ: 0, temperature: 25 };
  /** True when the last sample clipped (value beyond the selected range). */
  saturated: string[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.regs[0x6b] = 0x40; // SLEEP after power-up
    this.regs[0x75] = WHO_AM_I;
  }

  get asleep(): boolean {
    return (this.regs[0x6b]! & 0x40) !== 0;
  }

  /** Latch a sample into the output registers (the chip updates them at the sample rate). */
  sample(): void {
    if (this.asleep) return;
    const afs = (this.regs[0x1c]! >> 3) & 3;
    const fs = (this.regs[0x1b]! >> 3) & 3;
    const m = this.motion;
    const sat: string[] = [];
    const put = (at: number, name: string, v: number) => {
      const r = Math.round(v);
      if (r > 32767 || r < -32768) sat.push(name);
      const x = s16(v) & 0xffff;
      this.regs[at] = x >> 8;
      this.regs[at + 1] = x & 0xff;
    };
    put(0x3b, "accelX", m.accelX * ACCEL_LSB[afs]!);
    put(0x3d, "accelY", m.accelY * ACCEL_LSB[afs]!);
    put(0x3f, "accelZ", m.accelZ * ACCEL_LSB[afs]!);
    put(0x41, "temperature", (m.temperature - 36.53) * 340);
    put(0x43, "gyroX", m.gyroX * GYRO_LSB[fs]!);
    put(0x45, "gyroY", m.gyroY * GYRO_LSB[fs]!);
    put(0x47, "gyroZ", m.gyroZ * GYRO_LSB[fs]!);
    this.saturated = sat;
    this.regs[0x3a]! |= 0x01; // DATA_RDY_INT
  }

  connect(read: boolean): void {
    if (read) this.sample();
    else this.first = true;
  }

  write(b: number): void {
    if (this.first) {
      this.ptr = b & 0x7f;
      this.first = false;
      return;
    }
    const reg = this.ptr;
    if (reg === 0x6b) {
      if (b & 0x80) {
        this.reset(); // DEVICE_RESET: registers back to defaults, the bit reads 0 again
        this.ptr = (reg + 1) & 0x7f;
        return;
      }
      this.regs[reg] = b;
    } else if (reg === 0x68) {
      // SIGNAL_PATH_RESET clears the sensor registers
      if (b & 0x07) this.regs.fill(0, 0x3b, 0x49);
    } else if (reg !== 0x75 && reg !== 0x3a && !(reg >= 0x3b && reg <= 0x60)) {
      this.regs[reg] = b;
    }
    this.ptr = (reg + 1) & 0x7f;
  }

  read(): number {
    const reg = this.ptr;
    const b = this.regs[reg]!;
    if (reg === 0x3a) this.regs[0x3a]! &= ~0x01; // reading INT_STATUS clears it
    this.ptr = (reg + 1) & 0x7f;
    return b;
  }
}

export const create: PartModelFactory = (ctx): PartModel => {
  const mod = createI2cModule(ctx, { supplymA: 3.9, minVolts: 2.9, maxVolts: 5.5 });
  const chip = new Mpu6050();
  let ad0High = false;
  const keys = ["accelX", "accelY", "accelZ", "gyroX", "gyroY", "gyroZ", "temperature"] as const;
  const apply = (id: string, v: unknown) => {
    if (!(keys as readonly string[]).includes(id)) return;
    const k = id as (typeof keys)[number];
    // Values beyond the widest range are kept: the sensor then saturates, like a real one hit hard.
    const fallback = k === "accelZ" ? 1 : k === "temperature" ? 25 : 0;
    chip.motion[k] = num(v as number, fallback);
  };
  for (const k of keys) apply(k, ctx.props[k]);
  const address = () => (ad0High ? 0x69 : 0x68);

  const i2c: I2cDevice = {
    i2cAddress: address,
    i2cConnect(read) {
      if (!mod.powered) return false;
      chip.connect(read);
      return true;
    },
    i2cWrite(b) {
      chip.write(b);
      return true;
    },
    i2cRead: () => chip.read(),
    i2cStop() {},
  };

  return {
    i2c,
    stamp(c) {
      mod.stamp(c);
      c.resistor(ctx.node("AD0"), ctx.node("GND"), 4700, { id: "ad0-pulldown" });
    },
    onSolved(r) {
      mod.onSolved(r);
      const v = r.voltage(ctx.node("AD0")) - r.voltage(ctx.node("GND"));
      ad0High = v > 0.7 * 3.3; // the chip runs at 3.3 V on the GY-521; VIH = 0.7 VDD
    },
    visualState() {
      const m = chip.motion;
      const tilt = clamp(m.accelX, -1, 1) * 20;
      return {
        accelX: round(m.accelX),
        accelY: round(m.accelY),
        accelZ: round(m.accelZ),
        gyroX: round(m.gyroX),
        gyroY: round(m.gyroY),
        gyroZ: round(m.gyroZ),
        address: address(),
        asleep: chip.asleep,
        tiltTransform: `rotate(${round(tilt, 1)} 90 80)`,
      };
    },
    setProp: (id, v) => apply(id, v),
    interact(e) {
      if (e.kind === "set" && e.key) apply(e.key, e.value);
    },
    diagnostics() {
      const out: Diagnostic[] = mod.diagnostics();
      if (chip.saturated.length > 0 && mod.powered) {
        const afs = (chip.regs[0x1c]! >> 3) & 3;
        const fs = (chip.regs[0x1b]! >> 3) & 3;
        out.push({
          severity: "info",
          code: "imu-saturated",
          message: `${ctx.id}: ${chip.saturated.join(", ")} is beyond the selected range (accel ±${[2, 4, 8, 16][afs]} g, gyro ±${[250, 500, 1000, 2000][fs]} °/s), so the reading is clipped at the limit. Select a wider range (e.g. mpu.setAccelerometerRange(MPU6050_RANGE_8_G)) if the motion is real.`,
        });
      }
      return out;
    },
  };
};
