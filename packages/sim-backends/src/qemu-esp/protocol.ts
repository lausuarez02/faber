// The Jumper bridge line protocol spoken by the patched QEMU GPIO block (toolchains/qemu-esp,
// hw/gpio/esp32_gpio.c). One event per line, hex numbers without 0x.
//
//   QEMU → Jumper                          Jumper → QEMU
//   H jumper-esp32-bridge <v> <type> ...   I <pin> <0|1>      drive an input
//   G <out0> <out1> <en0> <en1> <ns>       W <hex bytes>      UART0 RX
//   U <ns> <hex bytes>   UART0 TX          R <ns>             run until virtual ns (lockstep)
//   T <ns>               reached target    A <0|1>            I2C ACK(0)/NACK(1) answer to IS
//   IS <addr> <r|w> <ns> I2C start         D <hex>            I2C byte answer to IR
//   IW <addr> <byte>     I2C write
//   IR <addr>            I2C read
//   IP <addr>            I2C stop

export type BridgeEvent =
  | { kind: "hello"; version: number; type: string }
  | { kind: "gpio"; out: bigint; enable: bigint; ns: bigint }
  | { kind: "uart"; ns: bigint; bytes: Uint8Array }
  | { kind: "time"; ns: bigint }
  | { kind: "i2c-start"; addr: number; read: boolean; ns: bigint }
  | { kind: "i2c-write"; addr: number; byte: number }
  | { kind: "i2c-read"; addr: number }
  | { kind: "i2c-stop"; addr: number }
  | { kind: "unknown"; line: string };

const hex = (s: string | undefined) => BigInt(`0x${s ?? "0"}`);

export function parseBridgeLine(line: string): BridgeEvent {
  const f = line.trim().split(/\s+/);
  switch (f[0]) {
    case "H":
      return { kind: "hello", version: Number(f[2]), type: f[3] ?? "" };
    case "G":
      return { kind: "gpio", out: (hex(f[2]) << 32n) | hex(f[1]), enable: (hex(f[4]) << 32n) | hex(f[3]), ns: hex(f[5]) };
    case "U":
      return { kind: "uart", ns: hex(f[1]), bytes: hexBytes(f[2] ?? "") };
    case "T":
      return { kind: "time", ns: hex(f[1]) };
    case "IS":
      return { kind: "i2c-start", addr: parseInt(f[1] ?? "0", 16), read: f[2] === "r", ns: hex(f[3]) };
    case "IW":
      return { kind: "i2c-write", addr: parseInt(f[1] ?? "0", 16), byte: parseInt(f[2] ?? "0", 16) };
    case "IR":
      return { kind: "i2c-read", addr: parseInt(f[1] ?? "0", 16) };
    case "IP":
      return { kind: "i2c-stop", addr: parseInt(f[1] ?? "0", 16) };
    default:
      return { kind: "unknown", line };
  }
}

export function hexBytes(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const encodeInput = (gpio: number, level: 0 | 1) => `I ${gpio} ${level}\n`;
export const encodeRun = (ns: bigint) => `R ${ns.toString(16)}\n`;
export const encodeAck = (ack: boolean) => `A ${ack ? 0 : 1}\n`;
export const encodeData = (byte: number) => `D ${(byte & 0xff).toString(16)}\n`;
export function encodeSerial(bytes: Iterable<number>): string {
  let s = "W ";
  for (const b of bytes) s += (b & 0xff).toString(16).padStart(2, "0");
  return `${s}\n`;
}

/** True when the line is one QEMU blocks on until Jumper answers (or the lockstep target "T"). */
export const isBlockingLine = (line: string) => line.startsWith("T ") || line.startsWith("IS ") || line.startsWith("IR ");
