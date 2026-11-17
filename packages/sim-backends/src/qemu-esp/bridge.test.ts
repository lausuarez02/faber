// The ESP backend against a scripted fake QEMU (fake-qemu.mjs): what each bridge event does to
// pins, buses and time, without Docker. The real-firmware tests are in qemu-esp*.integration.test.ts.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { I2cBus, I2sBus, SpiBus } from "@faber/sim-core";
import { QemuEspBackend } from "./backend.ts";
import { ESP_CHIPS, espOutputSource } from "./chips.ts";
import type { QemuLaunchOptions, QemuProcess } from "./launcher.ts";
import { EdgeQueue, PwmWave, queueRmt, queueUart, UartDecoder } from "./waveforms.ts";

const FAKE = fileURLToPath(new URL("./fake-qemu.mjs", import.meta.url));
const C3 = ESP_CHIPS.esp32c3;
const hx = (n: number) => n.toString(16);

interface Ev {
  ns: number;
  line?: string;
  answer?: boolean;
  park?: boolean;
}

function fake(events: Ev[], chip: "esp32" | "esp32s3" | "esp32c3" = "esp32c3") {
  const dir = mkdtempSync(join(tmpdir(), "faber-fake-qemu-"));
  const recordPath = join(dir, "record.json");
  const launch = (o: QemuLaunchOptions): QemuProcess => {
    const scriptPath = join(dir, "script.json");
    writeFileSync(scriptPath, JSON.stringify({ hello: `H faber-esp32-bridge 3 ${chip}.gpio sync=1 feat=gpio,matrix,irq,uart,i2c,ledc,spi,rmt,adc,i2s`, events }));
    const child = spawn(process.execPath, [FAKE, String(o.bridgePort), scriptPath, recordPath], { stdio: "ignore" });
    return { child, argv: [], stop: () => child.kill("SIGTERM") };
  };
  const be = new QemuEspBackend({ chip, launch, timeoutMs: 10_000 });
  const record = async (): Promise<{ t: number; line: string }[]> => {
    be.close();
    for (let i = 0; i < 100; i++) {
      try {
        return JSON.parse(readFileSync(recordPath, "utf8"));
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    throw new Error("fake QEMU wrote no record");
  };
  cleanups.push(() => {
    be.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); // the killed fake may still be writing its record
  });
  return { be, record };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Runs the backend to `ms` of virtual time in steps of `stepMs`. */
function runTo(be: QemuEspBackend, ms: number, stepMs = 1) {
  const end = Math.round((be.cyclesPerSecond * ms) / 1000);
  const chunk = Math.round((be.cyclesPerSecond * stepMs) / 1000);
  while (be.cycles < end) be.step(Math.min(chunk, end - be.cycles));
}

function edgesOf(be: QemuEspBackend, pin: string) {
  const out: { ns: number; v: number; mode: string }[] = [];
  be.onPinChange((p, s, cycle) => {
    if (p === pin) out.push({ ns: Math.round((cycle * 1e9) / be.cyclesPerSecond), v: s.value, mode: s.mode });
  });
  return out;
}

describe("waveforms", () => {
  it("PWM: edges from period, high time and phase; a duty change keeps the period's grid", () => {
    const w = new PwmWave(0, 0);
    w.update(1000, { enabled: true, idle: 0, periodNs: 1000, highNs: 250, phaseNs: 0 });
    expect(w.level).toBe(1);
    const got: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
      const e = w.peek()!;
      got.push([e.t, e.level]);
      w.take();
    }
    expect(got).toEqual([[1250, 0], [2000, 1], [2250, 0], [3000, 1]]);
    w.update(3100, { enabled: true, idle: 0, periodNs: 1000, highNs: 750, phaseNs: 0 });
    expect(w.peek()).toEqual({ t: 3750, level: 0 });
    w.update(3200, { enabled: false, idle: 1, periodNs: 1000, highNs: 750, phaseNs: 0 });
    expect(w.level).toBe(1);
    expect(w.peek()).toBeUndefined();
  });

  it("UART: 8N1 frames out, and the decoder reads them back with the right timing", () => {
    const q = new EdgeQueue(1, 0);
    queueUart(q, 0, 9600, [0x41, 0x0a]);
    const dec = new UartDecoder(9600);
    const bytes: number[] = [];
    let due: number | undefined;
    const pending: number[] = [];
    while (q.peek()) {
      const e = q.peek()!;
      while (pending.length && pending[0]! <= e.t) {
        pending.shift();
        const r = dec.complete();
        if (r.byte !== undefined) bytes.push(r.byte);
        if (r.nextAt !== undefined) pending.push(r.nextAt);
      }
      q.take();
      due = dec.edge(e.t, e.level);
      if (due !== undefined) pending.push(due);
    }
    while (pending.length) {
      pending.shift();
      const r = dec.complete();
      if (r.byte !== undefined) bytes.push(r.byte);
    }
    expect(bytes).toEqual([0x41, 0x0a]);
    expect(dec.framingErrors).toBe(0);
  });

  it("RMT: WS2812 symbols become high pulses of 0.4 / 0.8 µs, then the idle level", () => {
    const q = new EdgeQueue(0, 0);
    // 80 MHz / 2 = 25 ns ticks; bit 1 = 32 high + 18 low, bit 0 = 16 high + 34 low.
    const one = (32 | (1 << 15) | (18 << 16)) >>> 0;
    const zero = (16 | (1 << 15) | (34 << 16)) >>> 0;
    queueRmt(q, 1000, 25, Uint32Array.from([one, zero, 0]), 0);
    const e: [number, number][] = [];
    while (q.peek()) {
      e.push([q.peek()!.t, q.peek()!.level]);
      q.take();
    }
    expect(e).toEqual([[1000, 1], [1800, 0], [2250, 1], [2650, 0]]);
  });

  it("knows which peripheral a GPIO-matrix signal is, per chip", () => {
    expect(espOutputSource(C3, 128)).toEqual({ kind: "gpio" });
    expect(espOutputSource(C3, 45 + 2)).toEqual({ kind: "ledc", ch: 2 });
    expect(espOutputSource(C3, 51)).toEqual({ kind: "rmt", ch: 0 });
    expect(espOutputSource(C3, 9)).toEqual({ kind: "uart-tx", uart: 1 });
    expect(espOutputSource(ESP_CHIPS.esp32, 65)).toEqual({ kind: "spi", host: 3, line: "mosi" });
    expect(espOutputSource(ESP_CHIPS.esp32s3, 81 + 3)).toEqual({ kind: "rmt", ch: 3 });
  });
});

describe("qemu-esp bridge (fake QEMU)", () => {
  it("LEDC: a routed channel draws its PWM on the pin with exact edge times", async () => {
    const { be } = fake([
      { ns: 1000, line: `M 2 ${hx(45)} 0 3e8` },
      // 1 kHz, 25 % duty
      { ns: 2000, line: `L 0 1 0 ${hx(1_000_000_000)} ${hx(250_000_000)} 0 7d0` },
    ]);
    be.load(new Uint8Array(4 << 20));
    const edges = edgesOf(be, "GPIO2");
    runTo(be, 3.5);
    expect(edges.filter((e) => e.mode === "output").map((e) => [e.ns, e.v])).toEqual([
      [2000, 1],
      [252000, 0],
      [1002000, 1],
      [1252000, 0],
      [2002000, 1],
      [2252000, 0],
      [3002000, 1],
      [3252000, 0],
    ]);
    expect(be.readPin("GPIO2").mode).toBe("output");
  });

  it("RMT: symbols drawn on the routed pin decode as WS2812 bits", async () => {
    const one = (32 | (1 << 15) | (18 << 16)) >>> 0;
    const zero = (16 | (1 << 15) | (34 << 16)) >>> 0;
    const words = Uint32Array.from([one, one, zero, one, 0]);
    const hex = Buffer.from(words.buffer).toString("hex");
    const { be } = fake([
      { ns: 500, line: `M a ${hx(51)} 0 1f4` },
      { ns: 10_000, line: `RM 0 2710 ${hx(25_000)} 0 ${hex}` },
    ]);
    be.load(new Uint8Array(4 << 20));
    const edges = edgesOf(be, "GPIO10");
    runTo(be, 1);
    const highs: number[] = [];
    for (let i = 0; i + 1 < edges.length; i++) if (edges[i]!.v === 1 && edges[i + 1]!.v === 0) highs.push(edges[i + 1]!.ns - edges[i]!.ns);
    expect(highs).toEqual([800, 800, 400, 800]);
    expect(edges[edges.length - 1]!.v).toBe(0);
  });

  it("UART1: TX bytes are drawn as frames; frames a part drives on RX reach the firmware at the stop bit", async () => {
    const { be, record } = fake([
      { ns: 100, line: `M 13 ${hx(9)} 0 64` }, // GPIO19 = U1TXD
      { ns: 100, line: `N ${hx(9)} 12 1 64` }, // U1RXD from GPIO18
      { ns: 200, line: `B 1 ${hx(9600)} c8` },
      { ns: 1000, line: "V 1 3e8 41" },
    ]);
    be.load(new Uint8Array(4 << 20));
    const tx = edgesOf(be, "GPIO19");
    const bytes: number[] = [];
    be.onUart((u, b) => bytes.push(u, ...b));
    runTo(be, 2);
    expect(bytes).toEqual([1, 0x41]);
    const bit = 1e9 / 9600;
    // start bit at 1000 ns, LSB first: 0x41 = 1000 0010 → data bits 1,0,0,0,0,0,1,0
    // Routed to U1TXD at 100 ns: the pin idles high, then the start bit at 1000 ns.
    expect(tx[0]).toMatchObject({ ns: 100, v: 1, mode: "output" });
    expect(tx[1]).toMatchObject({ ns: 1000, v: 0 });
    // Edge times are reported in CPU cycles (6.25 ns at 160 MHz).
    expect(tx[2]!.v).toBe(1);
    expect(Math.abs(tx[2]!.ns - (1000 + bit))).toBeLessThan(7);
    // A part answers 0x4F on GPIO18, bit by bit at 9600 baud, starting at 3 ms.
    be.setPinInput("GPIO18", 3.3); // the part's TX idles high
    const t0 = 3_000_000;
    const levels = [0, 1, 1, 1, 1, 0, 0, 1, 0, 1];
    for (let i = 0; i < levels.length; i++) {
      runTo(be, (t0 + i * bit) / 1e6, 0.01);
      be.setPinInput("GPIO18", levels[i] ? 3.3 : 0);
    }
    runTo(be, 5);
    const rec = await record();
    const x = rec.find((r) => r.line.startsWith("X "));
    expect(x?.line).toBe("X 1 4f");
    expect(Math.abs(x!.t - (t0 + 9.5 * bit))).toBeLessThan(2);
  });

  it("SPI: a transaction goes through the bus; the MISO bytes answer the firmware's read-back", async () => {
    const { be, record } = fake([
      { ns: 1000, line: "SX 2 3e8 0 1f40 9f0000" },
      { ns: 2000, line: "SQ 2", answer: true },
    ]);
    const bus = new SpiBus();
    const seen: number[] = [];
    bus.attach("flash", { spiTransfer: (b) => (seen.push(b), seen.length === 1 ? 0xff : 0xef + seen.length - 2) }, () => true);
    be.attachSpi(bus);
    be.load(new Uint8Array(4 << 20));
    runTo(be, 1);
    expect(seen).toEqual([0x9f, 0, 0]);
    const rec = await record();
    expect(rec.find((r) => r.line.startsWith("Q "))?.line).toBe("Q ffeff0");
  });

  it("I2C: repeated START keeps the device's pointer; the second controller's traffic is tagged with its bus", async () => {
    const { be } = fake(
      [
        { ns: 1000, line: "IS 3c w 3e8", answer: true },
        { ns: 1000, line: "IW 3c 2" },
        { ns: 1100, line: "IS 3c r 44c", answer: true },
        { ns: 1100, line: "IR 3c", answer: true },
        { ns: 1100, line: "IP 3c" },
        { ns: 2000, line: "IS 48 r 7d0 1", answer: true },
        { ns: 2000, line: "IR 48 1", answer: true },
        { ns: 2000, line: "IP 48 1" },
      ],
      "esp32",
    );
    const events: string[] = [];
    const bus0 = new I2cBus("i2c0");
    bus0.attach("dev", {
      i2cAddress: () => 0x3c,
      i2cConnect: (read, repeated) => (events.push(`connect ${read ? "r" : "w"}${repeated ? " repeated" : ""}`), true),
      i2cWrite: (b) => (events.push(`w ${b}`), true),
      i2cRead: () => 0x55,
      i2cStop: () => events.push("stop"),
    });
    const bus1 = new I2cBus("i2c1");
    bus1.attach("tmp", { i2cAddress: () => 0x48, i2cConnect: () => true, i2cWrite: () => true, i2cRead: () => 0x19, i2cStop: () => {} });
    be.attachI2c(bus0);
    be.attachI2cBus(1, bus1);
    be.load(new Uint8Array(4 << 20));
    runTo(be, 1);
    expect(events).toEqual(["connect w", "w 2", "connect r repeated", "stop"]);
    expect(bus1.transactions().map((t) => [t.address, t.bytes])).toEqual([[0x48, [0x19]]]);
  });

  it("ADC and lockstep: pad voltages reach QEMU as mV; a watched pin is announced; stopAt moves the target while QEMU waits", async () => {
    const { be, record } = fake([
      { ns: 1000, line: "IS 3c w 3e8", answer: true },
      { ns: 500_000, park: true },
    ]);
    const bus = new I2cBus("i2c0");
    bus.attach("dev", {
      i2cAddress: () => 0x3c,
      i2cConnect: () => {
        be.stopAt(Math.round((300_000 * be.cyclesPerSecond) / 1e9));
        return true;
      },
      i2cWrite: () => true,
      i2cRead: () => 0,
      i2cStop: () => {},
    });
    be.attachI2c(bus);
    be.load(new Uint8Array(4 << 20));
    be.pinWatched("GPIO3");
    be.setPinInput("GPIO0", 1.25); // ADC1_CH0 on the C3
    be.step(Math.round(be.cyclesPerSecond / 1000));
    expect(Number(be.virtualNs)).toBe(300_000);
    be.step(Math.round(be.cyclesPerSecond / 1000));
    const rec = await record();
    const lines = rec.map((r) => r.line);
    expect(lines).toContain("K 8 0");
    expect(lines).toContain("E 0 4e2");
    const iA = lines.indexOf("A 0");
    expect(lines[iA - 1]).toBe(`R ${hx(300_000)}`);
  });

  it("I2S: frames out reach the bus's sinks; frames in come from its source", async () => {
    const out = Buffer.alloc(8);
    out.writeInt16LE(1000, 0);
    out.writeInt16LE(-1000, 2);
    out.writeInt16LE(2000, 4);
    out.writeInt16LE(-2000, 6);
    const { be, record } = fake([
      { ns: 1000, line: `ST 0 3e8 ${hx(16000)} 10 2 ${out.toString("hex")}` },
      { ns: 2000, line: `SR 0 7d0 ${hx(16000)} 10 1 3`, answer: true },
    ]);
    const bus = new I2sBus();
    const blocks: number[][] = [];
    bus.attach("amp", { i2sReceive: (b) => blocks.push([b.sampleRate, b.bits, b.channels, ...b.samples]) });
    bus.attach("mic", { i2sProvide: (req) => Int32Array.from({ length: req.frames }, (_, i) => (i + 1) * 256) });
    be.attachI2s(bus);
    be.load(new Uint8Array(4 << 20));
    runTo(be, 1);
    expect(blocks).toEqual([[16000, 16, 2, 1000, -1000, 2000, -2000]]);
    const rec = await record();
    expect(rec.find((r) => r.line.startsWith("Q "))?.line).toBe("Q 000100020003");
    expect(bus.stats.framesOut).toBe(2);
    expect(bus.stats.framesIn).toBe(3);
  });
});
