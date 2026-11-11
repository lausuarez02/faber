// ESP32-family chips the Jumper QEMU image (Espressif's QEMU fork + Jumper's bridge patch) runs.
// Round 9 spike, see docs/decisions (ESP32 backend) and toolchains/qemu-esp.

export type EspChip = "esp32" | "esp32s3" | "esp32c3";

export interface EspChipInfo {
  chip: EspChip;
  /** QEMU system emulator and machine. */
  qemu: "qemu-system-xtensa" | "qemu-system-riscv32";
  machine: EspChip;
  /** QOM type of the GPIO block that carries the bridge chardev. */
  gpioType: string;
  /** Nominal CPU clock: McuBackend.cycles counts these (a time base, as in the RP2040 backend). */
  cpuHz: number;
  /** GPIO numbers that exist on the chip, exposed as pin ids "GPIO<n>". */
  gpios: readonly number[];
  /** Hardware I2C0 default pins in arduino-esp32 (Wire.begin() with no arguments). */
  i2cPins?: { sda: number; scl: number };
  /** arduino-cli FQBN for builds that boot in QEMU (DIO flash mode). */
  fqbn: string;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const ESP_CHIPS: Record<EspChip, EspChipInfo> = {
  esp32: {
    chip: "esp32",
    qemu: "qemu-system-xtensa",
    machine: "esp32",
    gpioType: "esp32.gpio",
    cpuHz: 240_000_000,
    // 20, 24 and 28–31 do not exist on the ESP32.
    gpios: [...range(0, 19), 21, 22, 23, 25, 26, 27, ...range(32, 39)],
    // Only the ESP32 machine models an I2C controller (I2C0, bridged).
    i2cPins: { sda: 21, scl: 22 },
    fqbn: "esp32:esp32:esp32:FlashMode=dio",
  },
  esp32s3: {
    chip: "esp32s3",
    qemu: "qemu-system-xtensa",
    machine: "esp32s3",
    gpioType: "esp32s3.gpio",
    cpuHz: 240_000_000,
    gpios: [...range(0, 21), ...range(26, 48)],
    fqbn: "esp32:esp32:esp32s3:FlashMode=dio",
  },
  esp32c3: {
    chip: "esp32c3",
    qemu: "qemu-system-riscv32",
    machine: "esp32c3",
    gpioType: "esp32c3.gpio",
    cpuHz: 160_000_000,
    gpios: range(0, 21),
    fqbn: "esp32:esp32:esp32c3:FlashMode=dio",
  },
};

export const espPinId = (gpio: number) => `GPIO${gpio}`;

export function espGpioOf(pinId: string): number | undefined {
  const m = /^GPIO(\d+)$/.exec(pinId);
  return m ? Number(m[1]) : undefined;
}
