// The Jumper bridge line protocol spoken by the patched QEMU GPIO block (toolchains/qemu-esp,
// hw/gpio/esp32_gpio.c). One event per line, hex numbers without 0x (except "I": decimal).
// Version 5 (jumper/qemu-esp:9.2.2-20260417-jb5) adds everything after the I2C lines plus "P"; version 2
// images send a subset and keep working with this parser. Reference: docs/esp32-emulator.md.
//
//   QEMU → Jumper                                      Jumper → QEMU
//   H jumper-esp32-bridge <v> <type> sync= feat=       I <pin> <0|1>     drive an input (decimal)
//   G <out0> <out1> <en0> <en1> <ns>   GPIO regs       E <gpio> <mV>     pad voltage (ADC input)
//   M <gpio> <out_sel> <oen_sel> <ns>  output routing  W <hex>           UART0 RX
//   N <signal> <gpio> <matrix> <ns>    input routing   X <uart> <hex>    UART1/2 RX
//   U <ns> <hex>          UART0 TX                     K <m0> <m1>       pins whose changes park QEMU
//   V <uart> <ns> <hex>   UART1/2 TX                   R <ns>            run until (lockstep)
//   B <uart> <baud> <ns>  UART baud rate               A <0|1>           I2C ACK(0)/NACK(1) to IS
//   T <ns>                reached target               D <hex>           I2C byte for IR
//   IS <addr> <r|w> <ns> [bus]   I2C start             Q <hex>           answer to SQ / SR
//   IW <addr> <byte> [bus]       I2C write
//   IR <addr> [bus]              I2C read
//   IP <addr> [bus]              I2C stop
//   L <ch> <en> <idle> <period_ps> <high_ps> <phase_ps> <ns>   LEDC channel output
//   SX <host> <ns> <hwcs> <dur_ns> <hex>                       SPI transaction (MOSI bytes)
//   SQ <host>                                                  MISO of the last transaction?
//   RM <ch> <ns> <tick_ps> <idle> <hex words>                  RMT symbols sent
//   AT <gpio> <atten> <bits> <raw> <ns>                        ADC conversion (information)
//   ST <port> <ns> <rate> <bits> <chans> <hex>                 I2S frames out
//   SR <port> <ns> <rate> <bits> <chans> <frames>              I2S frames wanted (answer Q)
//   P <pu0> <pu1> <pd0> <pd1> <ns>                             pad pull-up / pull-down masks (IO_MUX / RTC_IO);
//                                                              in lockstep QEMU waits for "A 0" after it

export type BridgeEvent =
  | { kind: "hello"; version: number; type: string; features: string[] }
  | { kind: "gpio"; out: bigint; enable: bigint; ns: bigint }
  | { kind: "route-out"; gpio: number; signal: number; oenSel: number; ns: bigint }
  | { kind: "route-in"; signal: number; gpio: number; matrix: boolean; ns: bigint }
  | { kind: "uart"; ns: bigint; bytes: Uint8Array }
  | { kind: "uart-n"; uart: number; ns: bigint; bytes: Uint8Array }
  | { kind: "baud"; uart: number; baud: number; ns: bigint }
  | { kind: "time"; ns: bigint }
  | { kind: "i2c-start"; addr: number; read: boolean; ns: bigint; bus: number }
  | { kind: "i2c-write"; addr: number; byte: number; bus: number }
  | { kind: "i2c-read"; addr: number; bus: number }
  | { kind: "i2c-stop"; addr: number; bus: number }
  | { kind: "ledc"; ch: number; enabled: boolean; idle: 0 | 1; periodPs: bigint; highPs: bigint; phasePs: bigint; ns: bigint }
  | { kind: "spi"; host: number; ns: bigint; hwCs: boolean; durNs: bigint; mosi: Uint8Array }
  | { kind: "spi-query"; host: number }
  | { kind: "rmt"; ch: number; ns: bigint; tickPs: bigint; idle: 0 | 1; words: Uint32Array }
  | { kind: "adc"; gpio: number; atten: number; bits: number; raw: number; ns: bigint }
  | { kind: "i2s-out"; port: number; ns: bigint; rate: number; bits: number; channels: number; data: Uint8Array }
  | { kind: "i2s-in"; port: number; ns: bigint; rate: number; bits: number; channels: number; frames: number }
  | { kind: "pads"; pullUp: bigint; pullDown: bigint; ns: bigint }
  | { kind: "unknown"; line: string };

const hex = (s: string | undefined) => BigInt(`0x${s || "0"}`);
const num = (s: string | undefined) => parseInt(s || "0", 16);

export function parseBridgeLine(line: string): BridgeEvent {
  const f = line.trim().split(/\s+/);
  switch (f[0]) {
    case "H": {
      const feat = f.find((x) => x.startsWith("feat="));
      return { kind: "hello", version: Number(f[2]), type: f[3] ?? "", features: feat ? feat.slice(5).split(",").filter(Boolean) : [] };
    }
    case "G":
      return { kind: "gpio", out: (hex(f[2]) << 32n) | hex(f[1]), enable: (hex(f[4]) << 32n) | hex(f[3]), ns: hex(f[5]) };
    case "M":
      return { kind: "route-out", gpio: num(f[1]), signal: num(f[2]), oenSel: num(f[3]), ns: hex(f[4]) };
    case "N":
      return { kind: "route-in", signal: num(f[1]), gpio: num(f[2]), matrix: f[3] === "1", ns: hex(f[4]) };
    case "U":
      return { kind: "uart", ns: hex(f[1]), bytes: hexBytes(f[2] ?? "") };
    case "V":
      return { kind: "uart-n", uart: num(f[1]), ns: hex(f[2]), bytes: hexBytes(f[3] ?? "") };
    case "B":
      return { kind: "baud", uart: num(f[1]), baud: num(f[2]), ns: hex(f[3]) };
    case "T":
      return { kind: "time", ns: hex(f[1]) };
    case "IS":
      return { kind: "i2c-start", addr: num(f[1]), read: f[2] === "r", ns: hex(f[3]), bus: num(f[4]) };
    case "IW":
      return { kind: "i2c-write", addr: num(f[1]), byte: num(f[2]), bus: num(f[3]) };
    case "IR":
      return { kind: "i2c-read", addr: num(f[1]), bus: num(f[2]) };
    case "P":
      return { kind: "pads", pullUp: (hex(f[2]) << 32n) | hex(f[1]), pullDown: (hex(f[4]) << 32n) | hex(f[3]), ns: hex(f[5]) };
    case "IP":
      return { kind: "i2c-stop", addr: num(f[1]), bus: num(f[2]) };
    case "L":
      return {
        kind: "ledc",
        ch: num(f[1]),
        enabled: f[2] === "1",
        idle: f[3] === "1" ? 1 : 0,
        periodPs: hex(f[4]),
        highPs: hex(f[5]),
        phasePs: hex(f[6]),
        ns: hex(f[7]),
      };
    case "SX":
      return { kind: "spi", host: num(f[1]), ns: hex(f[2]), hwCs: f[3] === "1", durNs: hex(f[4]), mosi: hexBytes(f[5] ?? "") };
    case "SQ":
      return { kind: "spi-query", host: num(f[1]) };
    case "RM": {
      const b = hexBytes(f[5] ?? "");
      const words = new Uint32Array(Math.floor(b.length / 4));
      for (let i = 0; i < words.length; i++) words[i] = (b[4 * i]! | (b[4 * i + 1]! << 8) | (b[4 * i + 2]! << 16) | (b[4 * i + 3]! << 24)) >>> 0;
      return { kind: "rmt", ch: num(f[1]), ns: hex(f[2]), tickPs: hex(f[3]), idle: f[4] === "1" ? 1 : 0, words };
    }
    case "AT":
      return { kind: "adc", gpio: num(f[1]), atten: num(f[2]), bits: num(f[3]), raw: num(f[4]), ns: hex(f[5]) };
    case "ST":
      return { kind: "i2s-out", port: num(f[1]), ns: hex(f[2]), rate: num(f[3]), bits: num(f[4]), channels: num(f[5]), data: hexBytes(f[6] ?? "") };
    case "SR":
      return { kind: "i2s-in", port: num(f[1]), ns: hex(f[2]), rate: num(f[3]), bits: num(f[4]), channels: num(f[5]), frames: num(f[6]) };
    default:
      return { kind: "unknown", line };
  }
}

export function hexBytes(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesHex(bytes: Iterable<number>): string {
  let s = "";
  for (const b of bytes) s += (b & 0xff).toString(16).padStart(2, "0");
  return s;
}

export const encodeInput = (gpio: number, level: 0 | 1) => `I ${gpio} ${level}\n`;
export const encodeRun = (ns: bigint) => `R ${ns.toString(16)}\n`;
export const encodeAck = (ack: boolean) => `A ${ack ? 0 : 1}\n`;
export const encodeData = (byte: number) => `D ${(byte & 0xff).toString(16)}\n`;
export const encodeAnswer = (bytes: Iterable<number>) => `Q ${bytesHex(bytes)}\n`;
export const encodeAnalog = (gpio: number, mv: number) => `E ${gpio.toString(16)} ${Math.max(0, Math.round(mv)).toString(16)}\n`;
export const encodeSyncMask = (mask: bigint) =>
  `K ${(mask & 0xffffffffn).toString(16)} ${((mask >> 32n) & 0xffffffffn).toString(16)}\n`;
export function encodeSerial(bytes: Iterable<number>): string {
  return `W ${bytesHex(bytes)}\n`;
}
export function encodeSerialN(uart: number, bytes: Iterable<number>): string {
  return `X ${uart.toString(16)} ${bytesHex(bytes)}\n`;
}

/** Lines QEMU blocks on until Jumper answers (or the lockstep target "T"). Keep in sync with sync-link.ts. */
export const BLOCKING_PREFIXES = ["T ", "IS ", "IR ", "SQ ", "SR ", "P "] as const;
export const isBlockingLine = (line: string) => BLOCKING_PREFIXES.some((p) => line.startsWith(p));
