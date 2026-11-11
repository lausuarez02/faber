// Boots real ESP32-C3 firmware (fixtures/esp32_blink_io, arduino-esp32 3.3.12) in Espressif's QEMU
// through the Jumper bridge. Needs Docker with the jumper/qemu-esp image (toolchains/qemu-esp);
// skipped otherwise.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { I2cBus } from "@jumper/sim-core";
import { QemuEspBackend } from "./backend.ts";
import { qemuImageAvailable } from "./launcher.ts";

const available = qemuImageAvailable();
const flash = () =>
  new Uint8Array(gunzipSync(readFileSync(fileURLToPath(new URL("../../fixtures/esp32c3_blink_io.merged.bin.gz", import.meta.url)))));

function run(be: QemuEspBackend, ms: number, chunkMs = 1) {
  const chunk = Math.round((be.cyclesPerSecond * chunkMs) / 1000);
  const end = be.cycles + Math.round((be.cyclesPerSecond * ms) / 1000);
  while (be.cycles < end) be.step(chunk);
}

describe.skipIf(!available)("qemu-esp backend (Espressif QEMU in Docker)", () => {
  const backends: QemuEspBackend[] = [];
  afterAll(() => backends.forEach((b) => b.close()));

  function boot() {
    const be = new QemuEspBackend({ chip: "esp32c3", network: false });
    backends.push(be);
    const edges: { pin: string; value: number; ms: number }[] = [];
    let serial = "";
    be.onPinChange((pin, s, cycle) => {
      if (s.mode === "output") edges.push({ pin, value: s.value, ms: (cycle * 1000) / be.cyclesPerSecond });
    });
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    be.load(flash());
    return { be, edges, get serial() { return serial; } };
  }

  it("boots Blink: serial text and the LED pin toggling every 500 ms of virtual time", () => {
    const t0 = Date.now();
    const s = boot();
    expect(s.be.hello).toMatch(/jumper-esp32-bridge 3 esp32c3.gpio sync=1 pads=1/);
    run(s.be, 2600);
    const wallMs = Date.now() - t0;
    expect(s.serial).toContain("hello from jumper esp32");
    const led = s.edges.filter((e) => e.pin === "GPIO8");
    expect(led.length).toBeGreaterThanOrEqual(5);
    // The first toggle lands on the first loop() pass (millis() ≈ boot time), then every 500 ms.
    const gaps = led.slice(3).map((e, i) => e.ms - led[i + 2]!.ms);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of gaps) expect(Math.abs(g - 500)).toBeLessThan(2);
    console.log(`qemu-esp: 2.6 s virtual in ${wallMs} ms wall (boot included); LED edges at ms ${led.map((e) => e.ms.toFixed(3)).join(", ")}`);
  }, 60_000);

  it("reads an input driven from Jumper at an exact virtual time, and is deterministic", () => {
    const traces: string[] = [];
    for (let r = 0; r < 2; r++) {
      const s = boot();
      run(s.be, 200);
      s.be.setPinInput("GPIO4", 3.3);
      run(s.be, 100);
      s.be.setPinInput("GPIO4", 0);
      run(s.be, 100);
      expect(s.serial).toContain("in4=1");
      expect(s.serial).toContain("in4=0");
      const mirror = s.edges.filter((e) => e.pin === "GPIO2");
      expect(mirror.map((e) => e.value)).toEqual([0, 1, 0]);
      traces.push(JSON.stringify(s.edges));
      s.be.close();
    }
    expect(traces[0]).toBe(traces[1]);
  }, 60_000);

  it("ESP32: I2C0 transactions reach a part on Jumper's I2C bus", () => {
    const be = new QemuEspBackend({ chip: "esp32", network: false });
    backends.push(be);
    const bus = new I2cBus("i2c0", () => be.cycles);
    const regs = Array.from({ length: 16 }, (_, i) => 0x10 + i);
    let ptr = 0;
    let first = true;
    bus.attach("fake", {
      i2cAddress: () => 0x3c,
      i2cConnect: (read) => ((first = !read), true),
      i2cWrite: (b) => {
        if (first) ptr = b & 15;
        else regs[ptr++ & 15] = b;
        first = false;
        return true;
      },
      i2cRead: () => regs[ptr++ & 15]!,
      i2cStop: () => {},
    });
    be.attachI2c(bus);
    let serial = "";
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    be.load(new Uint8Array(gunzipSync(readFileSync(fileURLToPath(new URL("../../fixtures/esp32_i2c_probe.merged.bin.gz", import.meta.url))))));
    run(be, 1500, 10);
    expect(serial).toContain("scan: 3c 48");
    expect(serial).toContain("tmp105 raw 19 00 = 25.00 C");
    expect(serial).toContain("write 0x3c -> 0");
    expect(serial).toContain("read 0x3c n=4: 12 13 aa 15"); // regs 2..5, reg 4 written above
    expect(regs[4]).toBe(0xaa);
    expect(bus.transactions().some((t) => t.address === 0x3c && t.read && t.count === 4)).toBe(true);
  }, 60_000);

  it("leaves an attached I2C bus idle when the firmware does not use it", () => {
    const s = boot();
    const bus = new I2cBus("i2c0", () => s.be.cycles);
    s.be.attachI2c(bus);
    run(s.be, 50);
    expect(bus.transactions()).toHaveLength(0);
  }, 60_000);
});
