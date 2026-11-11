// The Renode backend's side of the bridge protocol, against a scripted fake bridge (a child Node
// process that dials the bridge port like platforms/JumperBridge.cs does). No Docker needed.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { I2cBus, SpiBus } from "@jumper/sim-core";
import { describe, expect, it } from "vitest";
import { bundleCSharp, createRenodeBackend } from "./backend.ts";
import { RENODE_BOARDS } from "./boards.ts";
import type { RenodeProcess } from "./launcher.ts";

/**
 * A fake bridge. `script` maps the n-th "R" command (0-based) to the lines it answers before "T".
 * Lines Jumper sends are echoed to a log the test reads back (as JSON on the child's stdout).
 */
function fakeBridge(script: Record<number, string[]>, opts: { ask?: Record<number, string> } = {}) {
  const sent: string[] = [];
  const launch = ({ runDir, port }: { runDir: string; port: number }): RenodeProcess => {
    const src = `
      const net = require("node:net");
      const script = ${JSON.stringify(script)};
      const fs = require("node:fs");
      let ns = 0n, runs = 0, buf = "";
      const s = net.connect(${port}, "127.0.0.1", () => s.write("H jumper-renode-bridge 1\\n"));
      s.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          process.stdout.write(JSON.stringify(line) + "\\n");
          if (line.startsWith("R ")) {
            const lines = script[runs++] ?? [];
            for (const l of lines) s.write(l + "\\n");
            ns += BigInt(line.slice(2));
            s.write("T " + ns + "\\n");
          }
          if (line === "Q") s.end();
        }
      });
      s.on("close", () => process.exit(0));
    `;
    const child = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n")) if (l) sent.push(JSON.parse(l) as string);
    });
    void runDir;
    void opts;
    return { child, argv: [], stop: () => child.kill() };
  };
  return { launch, sent };
}

const HEX = ":00000001FF\n";

describe("Renode backend protocol (fake bridge)", () => {
  it("starts on the first step with the parts' I2C addresses and the SPI mode in the per-run platform", async () => {
    const fb = fakeBridge({});
    let runDir = "";
    const be = createRenodeBackend({
      board: "stm32-blackpill-f411",
      launch: (o) => {
        runDir = o.runDir;
        return fb.launch(o);
      },
    });
    const i2c = new I2cBus("i2c0", () => be.cycles);
    i2c.attach("oled", { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: () => true, i2cRead: () => 0, i2cStop: () => {} });
    i2c.attach("bme", { i2cAddress: () => 0x76, i2cConnect: () => true, i2cWrite: () => true, i2cRead: () => 0, i2cStop: () => {} });
    const spi = new SpiBus();
    spi.attach("tft", { spiTransfer: () => 0 }, () => true, false);
    be.attachI2c(i2c);
    be.attachSpi(spi);
    be.load(HEX);
    be.step(100_000);
    const repl = readFileSync(join(runDir, "extra.repl"), "utf8");
    const resc = readFileSync(join(runDir, "start.resc"), "utf8");
    expect(repl).toContain("jumperI2c3c: Miscellaneous.JumperI2cTarget @ i2c1 0x3c");
    expect(repl).toContain("jumperI2c76: Miscellaneous.JumperI2cTarget @ i2c1 0x76");
    expect(repl).toMatch(/jumperSpi: Miscellaneous.JumperSpiTarget @ spi1\n {4}bus: "spi1"\n {4}sync: false/);
    expect(repl).toContain("dwt: Miscellaneous.JumperDwt @ sysbus 0xE0001000");
    expect(resc).toContain("sysbus LoadHEX @/jumper/run/firmware.hex");
    expect(resc).toContain("sysbus.cpu VectorTableOffset 0x8000000");
    expect(resc).toContain("sysbus.cpu PerformanceInMips 100");
    expect(resc).toContain("machine LoadPlatformDescription @/jumper/platforms/blackpill-f411.repl");
    be.dispose();
    await new Promise((r) => setTimeout(r, 50));
    expect(fb.sent.filter((l) => l.startsWith("W ")).length).toBe(Object.keys(RENODE_BOARDS["stm32-blackpill-f411"].pins).length);
    expect(fb.sent).toContain("S usart1 console");
    expect(fb.sent.find((l) => l.startsWith("R "))).toBe("R 1000000"); // 100 000 cycles at 100 MHz = 1 ms
  });

  it("replays pins (with direction), per-byte serial times, I2C transactions and SPI bytes at their virtual time", () => {
    const fb = fakeBridge({
      0: [
        "G PC13 0 o 200000", // LED on at 0.2 ms
        "G PB12 1 i 300000", // an input echoing: not an output
        "U console 400000 68",
        "U console 500000 69",
        "IW 3C 600000 0040",
        "IP 3C 610000",
        "SW spi1 AB 700000",
        "G PA0 1 o 800000",
        "G PA0 1 i 900000", // pinMode(PA0, INPUT): back to an input
      ],
    });
    const be = createRenodeBackend({ board: "stm32-blackpill-f411", launch: fb.launch });
    const i2c = new I2cBus("i2c0", () => be.cycles);
    const writes: number[] = [];
    i2c.attach("oled", { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: (b) => (writes.push(b), true), i2cRead: () => 0, i2cStop: () => {} });
    const spi = new SpiBus();
    const mosi: number[] = [];
    spi.attach("tft", { spiTransfer: (b) => (mosi.push(b), 0) }, () => true, false);
    be.attachI2c(i2c);
    be.attachSpi(spi);
    const pins: string[] = [];
    be.onPinChange((p, s, c) => pins.push(`${p}=${s.mode}:${s.value}@${c}`));
    const bytes: string[] = [];
    be.onSerial((b, c) => bytes.push(`${String.fromCharCode(b)}@${c}`));
    be.load(HEX);
    be.step(100_000); // 1 ms
    try {
      expect(pins).toEqual(["PC13=output:0@20000", "PA0=output:1@80000", "PA0=input:0@90000"]);
      expect(bytes).toEqual(["h@40000", "i@50000"]);
      expect(writes).toEqual([0x00, 0x40]);
      expect(i2c.transactions()[0]).toMatchObject({ address: 0x3c, read: false, ack: true, bytes: [0, 0x40], cycle: 60000 });
      expect(mosi).toEqual([0xab]);
      expect(be.cycles).toBe(100_000);
      expect(be.readPin("PC13")).toEqual({ mode: "output", value: 0 });
      expect(be.readPin("PB12").mode).toBe("input");
    } finally {
      be.dispose();
    }
  });

  it("answers an I2C read (IR) and an SPI byte (SX) from the part models while Renode waits", async () => {
    const fb = fakeBridge({ 0: ["IW 48 1000 00", "IR 48 2 2000", "IP 48 3000", "SX spi2 9F 4000"] });
    const be = createRenodeBackend({ board: "arduino-nano-33-ble", launch: fb.launch });
    const i2c = new I2cBus("i2c0", () => be.cycles);
    let reg = -1;
    let n = 0;
    i2c.attach("t", { i2cAddress: () => 0x48, i2cConnect: () => true, i2cWrite: (b) => ((reg = b), true), i2cRead: () => (reg === 0 ? [0x12, 0x34][n++]! : 0), i2cStop: () => {} });
    const spi = new SpiBus();
    spi.attach("d", { spiTransfer: (b) => (b === 0x9f ? 0xc2 : 0) }, () => true);
    be.attachI2c(i2c);
    be.attachSpi(spi);
    be.load(HEX);
    be.step(64_000);
    await new Promise((r) => setTimeout(r, 100));
    be.dispose();
    expect(fb.sent).toContain("D 1234");
    expect(fb.sent).toContain("M c2");
    expect(i2c.transactions().map((x) => [x.read, x.bytes])).toEqual([
      [false, [0]],
      [true, [0x12, 0x34]],
    ]);
  });

  it("draws PWM a model reports (nRF52 PWM) as exact edges, and stops it", () => {
    // P0.27 = D9 on the Nano 33 BLE: 1 ms period, 250 us high, from t = 0.
    const fb = fakeBridge({ 0: ["P 0.27 1000000 250000 0"], 2: ["P 0.27 0 0 2500000"] });
    const be = createRenodeBackend({ board: "arduino-nano-33-ble", launch: fb.launch });
    const edges: string[] = [];
    be.onPinChange((p, s, c) => p === "D9" && edges.push(`${s.value}@${c / 64}us`));
    be.load(HEX);
    for (let i = 0; i < 3; i++) be.step(64_000); // 3 x 1 ms
    be.dispose();
    expect(edges.slice(0, 5)).toEqual(["1@0us", "0@250us", "1@1000us", "0@1250us", "1@2000us"]);
    expect(edges.at(-1)).toBe("0@2500us"); // stopped: back to the GPIO level
  });

  it("refuses firmware it cannot load, saying why and how to fix it", () => {
    const be = createRenodeBackend({ board: "stm32-bluepill", launch: fakeBridge({}).launch });
    expect(() => be.load("hello")).toThrow(/Intel HEX or an ELF file.*Fix: build the sketch with the board's FQBN \(STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8\)/);
    expect(() => be.step(1)).toThrow(/no firmware loaded.*Fix:/);
  });

  it("bundles the bridge and the board's models into one C# file with the usings first", () => {
    const cs = bundleCSharp(["JumperBridge.cs", "JumperNrf52.cs"]);
    const firstCode = cs.split("\n").findIndex((l) => l.trim() && !l.startsWith("using "));
    expect(cs.split("\n").slice(firstCode).some((l) => /^using [\w.]+;$/.test(l))).toBe(false);
    expect(cs).toContain("public class JumperBridge");
    expect(cs).toContain("public class JumperNrf52Saadc");
  });
});
