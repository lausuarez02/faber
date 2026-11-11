// Renode backend against real firmware in the jumper/renode Docker image. Skipped when Docker is
// not running or the image has not been built (toolchains/renode/Dockerfile).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { dockerAvailable, RENODE_IMAGE, RenodeMachine, type PinEdge } from "./machine.ts";

const fixture = (f: string) => fileURLToPath(new URL(`../../fixtures/renode/${f}`, import.meta.url));
const platform = (f: string) => fileURLToPath(new URL(`./platforms/${f}`, import.meta.url));

async function imagePresent(): Promise<boolean> {
  if (!(await dockerAvailable())) return false;
  try {
    await promisify(execFile)("docker", ["image", "inspect", RENODE_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

const ready = await imagePresent();
const MS = 1_000_000n;

describe.skipIf(!ready)("renode backend (docker)", () => {
  const machines: RenodeMachine[] = [];
  afterAll(async () => {
    await Promise.all(machines.map((m) => m.stop()));
  });

  it("Blue Pill: UART, button in, LED edges out, I2C sensor, SPI device", { timeout: 120_000 }, async () => {
    const m = await RenodeMachine.start({
      board: "bluepill-f103c8",
      elf: fixture("bridge_bluepill.elf"),
      csharp: [platform("JumperI2cSensor.cs")],
      extraRepl: "sensor: Sensors.JumperI2cSensor @ i2c1 0x48\nextSpi: SPI.ExternalControlSPIPeripheral @ spi1\n",
    });
    machines.push(m);
    let text = "";
    m.onSerial((b) => (text += String.fromCharCode(b)));
    const edges: PinEdge[] = [];
    await m.watchPin("PC13", (e) => edges.push(e));
    const mosi: number[] = [];
    await m.attachSpiDevice("spi1.extSpi", (b) => {
      mosi.push(b);
      return 0x5a;
    });
    await m.setPin("PB0", 1); // INPUT_PULLUP's idle level

    await m.runFor(200n * MS);
    await m.monitor.exec("sysbus.i2c1.sensor Value 0x0190");
    await m.setPin("PB0", 0); // press
    const pressedAt = await m.timeNs();
    await m.runFor(200n * MS);
    await m.drainSerial();

    expect(await m.timeNs()).toBe(400n * MS);
    expect(text).toContain("bridge up");
    expect(text).toMatch(/btn=1 i2c_err=0 got=2 raw=0x1234 spi=0x5A/);
    expect(text).toMatch(/btn=0 i2c_err=0 got=2 raw=0x190 spi=0x5A/);
    expect(mosi.every((b) => b === 0x9f)).toBe(true);
    expect(mosi.length).toBeGreaterThan(4);
    // LED mirrors the button: high while released, one falling edge after the press.
    const fall = edges.find((e) => e.value === 0 && e.timeNs >= pressedAt);
    expect(fall).toBeDefined();
    expect(fall!.timeNs - pressedAt).toBeLessThan(60n * MS); // within one 50 ms loop
    console.log(`bluepill startup ${m.startupMs} ms, edges ${edges.map((e) => `${e.value}@${Number(e.timeNs / 1000n)}us`).join(" ")}`);
  });

  it("Nano 33 BLE: mbed OS boots, Serial1 prints, LED edges every 100 ms", { timeout: 120_000 }, async () => {
    const m = await RenodeMachine.start({ board: "arduino-nano-33-ble", elf: fixture("hello_nano33ble.elf") });
    machines.push(m);
    let text = "";
    m.onSerial((b) => (text += String.fromCharCode(b)));
    const edges: PinEdge[] = [];
    await m.watchPin("D13", (e) => edges.push(e));
    await m.setPin("D2", 1);
    const t0 = Date.now();
    await m.runFor(1000n * MS);
    const wall = Date.now() - t0;
    await m.drainSerial();
    expect(text).toContain("hello from nano33ble");
    expect(text).toMatch(/tick 5 ms=5\d\d btn=1/);
    expect(edges.length).toBeGreaterThanOrEqual(8);
    console.log(`nano33ble startup ${m.startupMs} ms, 1 s virtual in ${wall} ms wall, ${edges.length} LED edges`);
  });
});

describe.skipIf(!ready)("renode as a synchronous McuBackend", () => {
  it("steps Blue Pill in 10 ms chunks: serial bytes, LED edges with cycles, button via setPinInput", { timeout: 120_000 }, async () => {
    const { createRenodeBackend } = await import("./backend.ts");
    const be = createRenodeBackend({ board: "bluepill-f103c8", elf: fixture("bridge_bluepill.elf"), watch: ["PC13"] });
    try {
      let text = "";
      be.onSerial((b) => (text += String.fromCharCode(b)));
      const edges: { value: number; cycle: number }[] = [];
      be.onPinChange((pin, s, cycle) => pin === "PC13" && edges.push({ value: s.value, cycle }));
      be.setPinInput("PB0", 3.3);
      const chunk = be.cyclesPerSecond / 100; // 10 ms
      const t0 = Date.now();
      for (let i = 0; i < 20; i++) be.step(chunk);
      be.setPinInput("PB0", 0);
      const pressCycle = be.cycles;
      for (let i = 0; i < 20; i++) be.step(chunk);
      const wall = Date.now() - t0;
      expect(be.cycles).toBe(40 * chunk);
      expect(text).toMatch(/btn=1 /);
      expect(text).toMatch(/btn=0 /);
      const fall = edges.find((e) => e.value === 0 && e.cycle >= pressCycle);
      expect(fall).toBeDefined();
      console.log(`sync backend: startup ${be.startupMs} ms, 400 ms virtual in 40 steps took ${wall} ms wall; LED fell ${(fall!.cycle - pressCycle) / 72} us after the press`);
    } finally {
      be.dispose();
    }
  });
});
