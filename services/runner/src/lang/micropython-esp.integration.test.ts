// MicroPython on the ESP32 family in Fabwright's QEMU: the official firmware + a littlefs image with
// main.py, booted through the bridge. Needs fabwright/qemu-esp (Docker) or a native build; skipped otherwise.
import { afterAll, describe, expect, it } from "vitest";
import { I2cBus } from "@fabwright/sim-core";
import { QemuEspBackend, qemuImageAvailable } from "@fabwright/sim-backends/qemu-esp";
import { composeMicroPython } from "./micropython.ts";

// The current QEMU image (Docker), or a native build with FABWRIGHT_QEMU_ESP_RUNTIME=native.
const available = qemuImageAvailable();

function run(be: QemuEspBackend, ms: number) {
  const end = be.cycles + Math.round((be.cyclesPerSecond * ms) / 1000);
  while (be.cycles < end) be.step(Math.round(be.cyclesPerSecond / 100));
}

describe.skipIf(!available)("MicroPython in QEMU (ESP32 family)", { timeout: 180_000 }, () => {
  const backends: QemuEspBackend[] = [];
  afterAll(() => backends.forEach((b) => b.close()));

  for (const [chip, led] of [["esp32", 2], ["esp32c3", 8]] as const) {
    it(`${chip}: main.py from littlefs blinks GPIO${led} and talks I2C0 to a part at 0x3C`, async () => {
      // I2C0: the ESP32's controller (round 9), and the C3's (added by the jb5 image, round 10).
      const [scl, sda] = chip === "esp32" ? [22, 21] : [5, 4];
      const i2cCode = `from machine import I2C\ni2c = I2C(0, scl=Pin(${scl}), sda=Pin(${sda}))\nprint("scan", i2c.scan())\ni2c.writeto(0x3C, bytes([0x80, 0xAF]))\n`;
      const main = `from machine import Pin\nimport time\nled = Pin(${led}, Pin.OUT)\n${i2cCode}for i in range(4):\n    led.toggle()\n    print("blink", i)\n    time.sleep_ms(100)\nprint("done")\n`;
      const out = await composeMicroPython({ chip, files: new Map([["main.py", main]]) });
      const be = new QemuEspBackend({ chip, network: false });
      backends.push(be);
      const bus = new I2cBus("i2c0", () => be.cycles);
      const writes: number[] = [];
      bus.attach("oled", { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: (b) => (writes.push(b), true), i2cRead: () => 0, i2cStop: () => {} });
      be.attachI2c(bus);
      let serial = "";
      const edges: number[] = [];
      be.onSerial((b) => (serial += String.fromCharCode(b)));
      be.onPinChange((pin, s) => pin === `GPIO${led}` && s.mode === "output" && edges.push(s.value));
      be.load(out.binary!);
      run(be, 4000);
      expect(serial).toContain("blink 3");
      expect(serial).toContain("done");
      expect(serial).not.toContain("Performing initial setup"); // the filesystem Fabwright wrote mounted as is
      expect(edges.filter((v, i) => i === 0 || v !== edges[i - 1]).length).toBeGreaterThanOrEqual(4);
      expect(serial).toContain("scan [60]");
      expect(writes).toEqual([0x80, 0xaf]);
      // The REPL on UART0.
      for (const c of "print(6 * 7)\r") be.writeSerial(c.charCodeAt(0));
      run(be, 300);
      expect(serial).toContain("42");
    });
  }
});
