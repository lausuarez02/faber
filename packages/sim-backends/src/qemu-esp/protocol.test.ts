import { describe, expect, it } from "vitest";
import { ESP_CHIPS, espGpioOf } from "./chips.ts";
import { qemuArgs } from "./launcher.ts";
import { encodeInput, encodeRun, encodeSerial, isBlockingLine, parseBridgeLine } from "./protocol.ts";

describe("qemu-esp bridge protocol", () => {
  it("parses GPIO masks across both banks with the virtual time", () => {
    const ev = parseBridgeLine("G 4 10000 f84 10000 3b9aca00");
    expect(ev).toEqual({ kind: "gpio", out: (0x10000n << 32n) | 4n, enable: (0x10000n << 32n) | 0xf84n, ns: 1_000_000_000n });
  });
  it("parses UART bytes and I2C events", () => {
    const u = parseBridgeLine("U 64 68690a");
    expect(u.kind).toBe("uart");
    if (u.kind === "uart") expect(Buffer.from(u.bytes).toString()).toBe("hi\n");
    expect(parseBridgeLine("IS 3c r 10")).toEqual({ kind: "i2c-start", addr: 0x3c, read: true, ns: 16n, bus: 0 });
    expect(parseBridgeLine("IW 3c aa")).toEqual({ kind: "i2c-write", addr: 0x3c, byte: 0xaa, bus: 0 });
    expect(isBlockingLine("T 0") && isBlockingLine("IR 3c") && !isBlockingLine("IW 3c 1")).toBe(true);
  });
  it("encodes commands", () => {
    expect(encodeRun(1_000_000n)).toBe("R f4240\n");
    expect(encodeInput(4, 1)).toBe("I 4 1\n");
    expect(encodeSerial([0x41, 0x0a])).toBe("W 410a\n");
  });
  it("builds a lockstep QEMU command line for each chip", () => {
    const a = qemuArgs({ chip: "esp32c3", flashImage: "/x/f.bin", bridgePort: 5555 }, "/fw/f.bin", "host.docker.internal");
    expect(a[0]).toBe("qemu-system-riscv32");
    expect(a.join(" ")).toContain("-icount shift=3,align=off,sleep=off");
    expect(a.join(" ")).toContain("driver=esp32c3.gpio,property=sync,value=on");
    expect(ESP_CHIPS.esp32.qemu).toBe("qemu-system-xtensa");
    expect(espGpioOf("GPIO48")).toBe(48);
    expect(ESP_CHIPS.esp32.gpios).not.toContain(20);
  });
});
